import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env";
import { fromSupabase } from "./errors";
import { memoryDatabase } from "./memoryDb";

/**
 * NYAY_DB=memory swaps the client for an in-memory stand-in so the route tests
 * can run the real app without Supabase (docs/DECISIONS.md D-10). It is refused in
 * production: a server that silently kept its records in RAM would lose them all
 * on restart.
 */
const useMemory = process.env.NYAY_DB === "memory";
if (useMemory && env.isProduction) {
  throw new Error("NYAY_DB=memory is a test instrument and cannot be used with NODE_ENV=production.");
}

/**
 * The single service-role client. It holds the key that bypasses RLS, which is
 * why it lives only here and why nothing in routes/ ever constructs its own.
 *
 * The key must never be shipped to a browser. The frontend talks to this API;
 * it has no Supabase credentials of its own.
 */
export const db: SupabaseClient = useMemory
  ? (memoryDatabase() as unknown as SupabaseClient)
  : createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-nyaysetu-client": "api" } },
    });

/**
 * PII lives in the `restricted` schema. For PostgREST to reach it, the schema
 * must be listed under Supabase Settings -> API -> Exposed schemas. See
 * docs/deployment.md; it is the one manual dashboard step.
 */
export const restricted = db.schema("restricted");

/** Throws a typed AppError instead of returning Supabase's shape. */
export function unwrap<T>(result: { data: T | null; error: any }): T {
  if (result.error) throw fromSupabase(result.error);
  if (result.data === null) {
    throw fromSupabase({ message: "Query returned no data.", code: "PGRST116" });
  }
  return result.data;
}

/** For queries where "no row" is a legitimate answer. */
export function unwrapMaybe<T>(result: { data: T | null; error: any }): T | null {
  if (result.error) {
    // maybeSingle() reports "no rows" as an error in some versions; treat it
    // as an empty result rather than a failure.
    if (result.error.code === "PGRST116") return null;
    throw fromSupabase(result.error);
  }
  return result.data;
}

export function unwrapList<T>(result: { data: T[] | null; error: any }): T[] {
  if (result.error) throw fromSupabase(result.error);
  return result.data ?? [];
}

/** Cheap liveness probe for /api/health. */
export async function pingDatabase(): Promise<boolean> {
  const { error } = await db.from("roles").select("role").limit(1);
  return !error;
}

/**
 * Which 2.0 migrations the connected database appears to have, judged by one
 * table each creates. A missing one means the matching features answer
 * SCHEMA_OUT_OF_DATE rather than failing obscurely.
 */
const MIGRATION_PROBES: [migration: string, table: string][] = [
  ["008_case_intake", "fir_records"],
  ["009_verification_state", "anchors"],
  ["010_passport_capture", "device_keys"],
  ["011_chunked_uploads", "upload_sessions"],
  ["012_workflows", "approval_requests"],
  ["014_smart_policing", "vehicle_reports"],
  ["015_evidence_ocr", "evidence_ocr"],
];

export async function schemaStatus(): Promise<{ upToDate: boolean; missing: string[] }> {
  const results = await Promise.all(
    MIGRATION_PROBES.map(async ([migration, table]) => {
      const { error } = await db.from(table).select("id").limit(0);
      return error ? migration : null;
    })
  );
  const missing = results.filter((m): m is string => m !== null);
  return { upToDate: missing.length === 0, missing };
}
