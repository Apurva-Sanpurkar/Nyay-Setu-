import { randomUUID } from "crypto";

/**
 * An in-memory stand-in for the subset of the Supabase query builder this API
 * uses, so route tests can run the real Express app without a database.
 *
 * Enabled with NYAY_DB=memory, and refused outright when NODE_ENV=production
 * (see lib/supabase.ts). It is a test instrument, not a database: there is no
 * RLS, no triggers and no SQL, and it enforces only the unique constraints listed
 * below. The migrations themselves are validated separately against a real
 * Postgres engine (database/scripts/validate-migrations.mjs).
 *
 * Supported: select with column lists, aliases and many-to-one embeds
 * (`cases(fir_number)`, `users!inner(...)`), insert / update / upsert / delete,
 * eq neq gt gte lt lte in is ilike match, order, limit, range, single,
 * maybeSingle, count/head, and the rpc functions the API calls.
 */

type Row = Record<string, any>;
type PgError = { message: string; code: string; details?: string };
type Result = { data: any; error: PgError | null; count?: number | null };

/** Tables whose primary key is a bigserial rather than a uuid. */
const SERIAL_TABLES = new Set(["action_log", "audit_log", "chain_events", "email_log", "anchor_state_events"]);

/** Unique constraints, as column groups. `lower(email)` is handled specially. */
const UNIQUE: Record<string, string[][]> = {
  users: [["email"]],
  sessions: [["token_hash"]],
  cases: [["case_id_hash"], ["case_reference"]],
  case_assignments: [["case_id", "user_id"]],
  evidence_items: [["chain_evidence_id"], ["public_ref"], ["idempotency_key"]],
  chain_tx: [["tx_hash"]],
  chain_events: [["tx_hash", "log_index"]],
  indexer_state: [["contract"]],
  anchors: [["idempotency_key"]],
  summons: [["chain_summons_id"]],
  bail_conditions: [["case_id"]],
  user_pii: [["user_id"], ["aadhaar_token"]],
  fir_records: [["police_station_norm", "fir_year", "fir_number_norm"]],
  approval_requests: [["idempotency_key"]],
  sync_receipts: [["idempotency_key"]],
  document_templates: [["template_key"]],
  discrepancy_alerts: [["dedupe_key"]],
  notification_outbox: [["dedupe_key"]],
  station_alerts: [["dedupe_key"]],
  vehicle_matches: [["missing_report_id", "found_report_id"]],
  ti_leads: [["kind", "subject_a", "subject_b"]],
  evidence_ocr: [["evidence_id", "result_digest"]],
};

const PRIMARY_KEY: Record<string, string> = { indexer_state: "contract", user_pii: "user_id" };

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function singular(name: string): string {
  // Only the plurals this schema uses: "summonses" does not occur, "cases" does.
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

interface Projection {
  all: boolean;
  columns: { alias: string; column: string }[];
  embeds: { alias: string; table: string; inner: boolean; projection: Projection }[];
}

function parseProjection(spec: string | undefined): Projection {
  const out: Projection = { all: false, columns: [], embeds: [] };
  for (const part of splitTopLevel(spec && spec.trim() ? spec : "*")) {
    if (part === "*") {
      out.all = true;
      continue;
    }
    const open = part.indexOf("(");
    if (open !== -1) {
      const head = part.slice(0, open);
      const body = part.slice(open + 1, part.lastIndexOf(")"));
      const [alias, rest] = head.includes(":") ? head.split(":") : [null, head];
      const [table, hint] = rest.split("!");
      out.embeds.push({ alias: alias ?? table, table, inner: hint === "inner", projection: parseProjection(body) });
      continue;
    }
    const [alias, column] = part.includes(":") ? part.split(":") : [part, part];
    out.columns.push({ alias: alias.trim(), column: column.trim() });
  }
  return out;
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function compare(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

/**
 * Read-only views in the real schema, served from the table they project. The
 * view exposes a subset of columns; callers select only those, so serving the
 * whole row is equivalent here. (user_directory: 001_schema.sql.)
 */
const VIEWS: Record<string, string> = { user_directory: "users" };

export class MemoryDatabase {
  readonly tables = new Map<string, Row[]>();
  private serial = 0;
  /** Set to make every call fail, for outage tests. */
  failWith: PgError | null = null;

  table(name: string): Row[] {
    const key = VIEWS[name] ?? name.replace(/^restricted\./, "");
    if (!this.tables.has(key)) this.tables.set(key, []);
    return this.tables.get(key)!;
  }

  reset(): void {
    this.tables.clear();
    this.serial = 0;
    this.failWith = null;
  }

  from(name: string): QueryBuilder {
    return new QueryBuilder(this, name);
  }

  schema(_name: string): { from: (table: string) => QueryBuilder } {
    return { from: (table: string) => this.from(table) };
  }

  nextSerial(): number {
    return ++this.serial;
  }

  applyDefaults(table: string, row: Row): Row {
    const now = new Date().toISOString();
    const pk = PRIMARY_KEY[table] ?? "id";
    const out: Row = { ...row };
    if (pk === "id" && out.id === undefined) out.id = SERIAL_TABLES.has(table) ? this.nextSerial() : randomUUID();
    if (out.created_at === undefined) out.created_at = now;
    if (out.updated_at === undefined && table !== "action_log") out.updated_at = now;
    // Column defaults the real schema declares beyond created_at / updated_at.
    if (table === "cases" && out.registered_at === undefined) out.registered_at = now;
    return out;
  }

  uniqueViolation(table: string, candidate: Row, ignoreId?: any): PgError | null {
    const rows = this.table(table);
    const pk = PRIMARY_KEY[table] ?? "id";
    for (const group of UNIQUE[table] ?? []) {
      const values = group.map((col) => candidate[col]);
      if (values.some((v) => v === null || v === undefined)) continue;
      const clash = rows.find(
        (row) =>
          row[pk] !== ignoreId &&
          group.every((col, i) =>
            col === "email"
              ? String(row[col]).toLowerCase() === String(values[i]).toLowerCase()
              : row[col] === values[i]
          )
      );
      if (clash) {
        return {
          code: "23505",
          message: `duplicate key value violates unique constraint "${table}_${group.join("_")}_key"`,
          details: `Key (${group.join(", ")}) already exists.`,
        };
      }
    }
    return null;
  }

  async rpc(fn: string, args: Record<string, any> = {}): Promise<Result> {
    if (this.failWith) return { data: null, error: this.failWith };
    const pii = this.table("user_pii");
    switch (fn) {
      case "pii_get":
        return { data: pii.filter((r) => r.user_id === args.p_user_id).map(clone), error: null };
      case "pii_owner_of":
        return { data: pii.find((r) => r.aadhaar_token === args.p_token)?.user_id ?? null, error: null };
      case "pii_directory":
        return { data: pii.map((r) => ({ user_id: r.user_id, aadhaar_last4: r.aadhaar_last4 ?? null })), error: null };
      case "pii_upsert": {
        const existing = pii.find((r) => r.user_id === args.p_user_id);
        const next = {
          user_id: args.p_user_id,
          aadhaar_token: args.p_aadhaar_token,
          aadhaar_last4: args.p_aadhaar_last4 ?? null,
          phone_encrypted: args.p_phone_encrypted ?? existing?.phone_encrypted ?? null,
          address_encrypted: args.p_address_encrypted ?? existing?.address_encrypted ?? null,
          date_of_birth: args.p_date_of_birth ?? existing?.date_of_birth ?? null,
        };
        if (existing) Object.assign(existing, next);
        else pii.push(next);
        return { data: null, error: null };
      }
      case "next_case_reference": {
        const code = String(args.p_station_code ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40);
        if (!code) return { data: null, error: { code: "P0001", message: "A station or court code is required to number a case." } };
        const counters = this.table("case_reference_counters");
        let counter = counters.find((c) => c.station_code === code && c.year === args.p_year);
        if (!counter) {
          counter = { station_code: code, year: args.p_year, last_serial: 0 };
          counters.push(counter);
        }
        counter.last_serial += 1;
        return { data: `NS/${code}/${args.p_year}/${String(counter.last_serial).padStart(6, "0")}`, error: null };
      }
      case "prune_expired":
        return { data: [{ deleted_sessions: 0, deleted_otps: 0 }], error: null };
      default:
        return { data: null, error: { code: "PGRST202", message: `function ${fn} does not exist in the memory database` } };
    }
  }
}

type Filter = (row: Row) => boolean;

export class QueryBuilder implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private action: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private projection: string | undefined = "*";
  private returning = false;
  private countMode: "exact" | null = null;
  private head = false;
  private orderings: { column: string; ascending: boolean }[] = [];
  private limitCount: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private cardinality: "many" | "single" | "maybe" = "many";
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  constructor(private readonly db: MemoryDatabase, private readonly tableName: string) {}

  private get name(): string {
    return this.tableName.replace(/^restricted\./, "");
  }

  select(columns?: string, options: { count?: "exact"; head?: boolean } = {}): this {
    if (this.action === "select") this.projection = columns ?? "*";
    else {
      this.returning = true;
      this.projection = columns ?? "*";
    }
    if (options.count) this.countMode = "exact";
    if (options.head) this.head = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.action = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean; count?: "exact" } = {}): this {
    this.action = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOptions = options;
    if (options.count) this.countMode = "exact";
    return this;
  }

  update(patch: Row): this {
    this.action = "update";
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.action = "delete";
    return this;
  }

  eq(column: string, value: any): this {
    this.filters.push((row) => row[column] === value || (value !== null && String(row[column]) === String(value) && typeof row[column] !== "object"));
    return this;
  }
  neq(column: string, value: any): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }
  gt(column: string, value: any): this {
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && compare(row[column], value) > 0);
    return this;
  }
  gte(column: string, value: any): this {
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && compare(row[column], value) >= 0);
    return this;
  }
  lt(column: string, value: any): this {
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && compare(row[column], value) < 0);
    return this;
  }
  lte(column: string, value: any): this {
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && compare(row[column], value) <= 0);
    return this;
  }
  in(column: string, values: any[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  is(column: string, value: null | boolean): this {
    this.filters.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
    return this;
  }
  not(column: string, operator: string, value: any): this {
    if (operator === "is") this.filters.push((row) => !(value === null ? row[column] == null : row[column] === value));
    else if (operator === "eq") this.filters.push((row) => row[column] !== value);
    else if (operator === "in") {
      const list = String(value).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      this.filters.push((row) => !list.includes(String(row[column])));
    }
    return this;
  }
  ilike(column: string, pattern: string): this {
    const re = likeToRegex(pattern);
    this.filters.push((row) => typeof row[column] === "string" && re.test(row[column]));
    return this;
  }
  match(criteria: Row): this {
    for (const [k, v] of Object.entries(criteria)) this.eq(k, v);
    return this;
  }
  contains(column: string, values: any[]): this {
    this.filters.push((row) => Array.isArray(row[column]) && values.every((v) => row[column].includes(v)));
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orderings.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  single(): this {
    this.cardinality = "single";
    return this;
  }
  maybeSingle(): this {
    this.cardinality = "maybe";
    return this;
  }
  returns<T>(): this {
    return this;
  }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: any) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    return this.db.table(this.name).filter((row) => this.filters.every((f) => f(row)));
  }

  private project(row: Row, projection: Projection): Row | null {
    const out: Row = projection.all ? clone(row) : {};
    for (const { alias, column } of projection.columns) out[alias] = clone(row[column]);
    for (const embed of projection.embeds) {
      const fk = `${singular(embed.table)}_id`;
      let target: Row | undefined;
      if (row[fk] !== undefined) target = this.db.table(embed.table).find((r) => r.id === row[fk]);
      out[embed.alias] = target ? this.project(target, embed.projection) : null;
      if (embed.inner && !target) return null;
    }
    return out;
  }

  private shape(rows: Row[]): Result {
    const projection = parseProjection(this.projection);
    let projected = rows.map((r) => this.project(r, projection)).filter((r): r is Row => r !== null);

    for (const { column, ascending } of [...this.orderings].reverse()) {
      projected = [...projected].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
    }
    const count = this.countMode ? projected.length : null;
    if (this.rangeFrom !== null && this.rangeTo !== null) projected = projected.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.limitCount !== null) projected = projected.slice(0, this.limitCount);
    if (this.head) return { data: null, error: null, count };

    if (this.cardinality === "single") {
      if (projected.length !== 1) {
        return {
          data: null,
          error: { code: "PGRST116", message: `JSON object requested, multiple (or no) rows returned (${projected.length})` },
          count,
        };
      }
      return { data: projected[0], error: null, count };
    }
    if (this.cardinality === "maybe") {
      if (projected.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows returned for maybeSingle" }, count };
      }
      return { data: projected[0] ?? null, error: null, count };
    }
    return { data: projected, error: null, count };
  }

  private execute(): Result {
    if (this.db.failWith) return { data: null, error: this.db.failWith };
    const table = this.db.table(this.name);
    const pk = PRIMARY_KEY[this.name] ?? "id";

    switch (this.action) {
      case "select":
        return this.shape(this.matching());

      case "insert": {
        const created: Row[] = [];
        for (const raw of this.payload) {
          const row = this.db.applyDefaults(this.name, clone(raw));
          const violation = this.db.uniqueViolation(this.name, row);
          if (violation) return { data: null, error: violation };
          table.push(row);
          created.push(row);
        }
        if (!this.returning) return { data: null, error: null, count: this.countMode ? created.length : null };
        return this.shapeReturned(created);
      }

      case "upsert": {
        const conflictColumns = (this.upsertOptions.onConflict ?? pk).split(",").map((c) => c.trim());
        const touched: Row[] = [];
        for (const raw of this.payload) {
          const existing = table.find((row) => conflictColumns.every((c) => row[c] === raw[c]));
          if (existing) {
            if (this.upsertOptions.ignoreDuplicates) continue;
            const next = { ...existing, ...clone(raw), updated_at: new Date().toISOString() };
            const violation = this.db.uniqueViolation(this.name, next, existing[pk]);
            if (violation) return { data: null, error: violation };
            Object.assign(existing, next);
            touched.push(existing);
          } else {
            const row = this.db.applyDefaults(this.name, clone(raw));
            const violation = this.db.uniqueViolation(this.name, row);
            if (violation) return { data: null, error: violation };
            table.push(row);
            touched.push(row);
          }
        }
        if (!this.returning) return { data: null, error: null, count: this.countMode ? touched.length : null };
        return this.shapeReturned(touched);
      }

      case "update": {
        const targets = this.matching();
        for (const row of targets) {
          const next = { ...row, ...clone(this.patch) };
          if (this.name !== "action_log") next.updated_at = new Date().toISOString();
          const violation = this.db.uniqueViolation(this.name, next, row[pk]);
          if (violation) return { data: null, error: violation };
          Object.assign(row, next);
        }
        if (!this.returning) return { data: null, error: null };
        return this.shapeReturned(targets);
      }

      case "delete": {
        const targets = this.matching();
        const remaining = table.filter((row) => !targets.includes(row));
        table.length = 0;
        table.push(...remaining);
        if (!this.returning) return { data: null, error: null };
        return this.shapeReturned(targets);
      }
    }
  }

  private shapeReturned(rows: Row[]): Result {
    const saved = this.filters;
    this.filters = [];
    const result = this.shape(rows);
    this.filters = saved;
    return result;
  }
}

let shared: MemoryDatabase | null = null;

/** The process-wide memory database, created on first use. */
export function memoryDatabase(): MemoryDatabase {
  if (!shared) shared = new MemoryDatabase();
  return shared;
}
