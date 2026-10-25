/**
 * Applies every migration, in order, to a throwaway Postgres running in-process
 * (PGlite), and fails on the first error.
 *
 *   npm run db:validate            from backend/
 *
 * Supabase-specific roles (anon, authenticated, service_role) are created first,
 * because the migrations grant and revoke against them. Nothing here touches the
 * real database: PGlite lives in memory and is discarded at exit.
 *
 * After applying, it asserts the properties the migrations promise rather than
 * trusting that "it ran" means "it is right":
 *   - every table in public and restricted has row level security enabled
 *   - every 2.0 table carries the audit trigger
 *   - re-running the 2.0 migrations is harmless (they are idempotent)
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "database", "migrations");
const seedFile = join(here, "..", "..", "database", "seed", "reference.sql");
const fixturesDir = join(here, "..", "..", "database", "fixtures");

/** Optional data fixtures: before_NNN.sql seeds rows, after_NNN.sql asserts. */
function fixture(kind, name) {
  const file = join(fixturesDir, `${kind}_${name.slice(0, 3)}.sql`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const files = readdirSync(migrationsDir)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort();

const db = new PGlite();

await db.exec(`
  do $$ begin
    create role anon nologin;
  exception when duplicate_object then null; end $$;
  do $$ begin
    create role authenticated nologin;
  exception when duplicate_object then null; end $$;
  do $$ begin
    create role service_role nologin bypassrls;
  exception when duplicate_object then null; end $$;
`);

let failed = false;

async function apply(name, sql) {
  const started = Date.now();
  try {
    await db.exec(sql);
    console.log(`  ok    ${name}  (${Date.now() - started} ms)`);
  } catch (error) {
    failed = true;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
    if (error.position) {
      const position = Number(error.position);
      const context = sql.slice(Math.max(0, position - 200), position + 120);
      console.error("        near:\n" + context.split("\n").map((l) => "          | " + l).join("\n"));
    }
  }
}

console.log("Applying migrations to an in-process Postgres (PGlite):");
for (const name of files) {
  const before = fixture("before", name);
  if (before) await apply(`fixtures/before_${name.slice(0, 3)}.sql`, before);
  if (failed) break;
  await apply(name, readFileSync(join(migrationsDir, name), "utf8"));
  if (failed) break;
  const after = fixture("after", name);
  if (after) await apply(`fixtures/after_${name.slice(0, 3)}.sql`, after);
  if (failed) break;
  // The reference seed belongs straight after the schema exists.
  if (name.startsWith("003_")) await apply("seed/reference.sql", readFileSync(seedFile, "utf8"));
  if (failed) break;
}

if (!failed) {
  console.log("\nRe-applying 008+ to prove they are idempotent:");
  for (const name of files.filter((n) => Number(n.slice(0, 3)) >= 8)) {
    await apply(`${name} (again)`, readFileSync(join(migrationsDir, name), "utf8"));
    if (failed) break;
  }
}

if (!failed) {
  const noRls = await db.query(`
    select schemaname || '.' || tablename as t
    from pg_tables
    where schemaname in ('public', 'restricted') and not rowsecurity
    order by 1`);
  if (noRls.rows.length) {
    failed = true;
    console.error("\n  FAIL  tables without row level security: " + noRls.rows.map((r) => r.t).join(", "));
  } else {
    console.log("\n  ok    every table in public and restricted has row level security");
  }

  const v2Tables = await db.query(`
    select c.relname as t
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and obj_description(c.oid) like '2.0:%'
    order by 1`);
  const missingAudit = [];
  for (const { t } of v2Tables.rows) {
    const trigger = await db.query(
      `select 1 from pg_trigger where tgrelid = ('public.' || $1)::regclass and tgname = 'audit_changes'`,
      [t]
    );
    if (trigger.rows.length === 0) missingAudit.push(t);
  }
  if (missingAudit.length) {
    failed = true;
    console.error("  FAIL  2.0 tables without the audit trigger: " + missingAudit.join(", "));
  } else {
    console.log(`  ok    all ${v2Tables.rows.length} tables added in 2.0 carry the audit trigger`);
  }

  const policies = await db.query(`
    select count(*)::int as n from pg_policies where schemaname = 'public'`);
  console.log(`  info  ${policies.rows[0].n} row level security policies in public`);
}

await db.close();

if (failed) {
  console.error("\nMigration validation FAILED.");
  process.exit(1);
}
console.log(`\nMigration validation passed: ${files.length} migrations applied cleanly.`);
