import { db } from "./supabase";
import { fromSupabase } from "./errors";

/**
 * The only route to personally identifying data.
 *
 * `restricted.user_pii` is not reachable over the REST API: the schema is
 * deliberately not exposed. Everything here goes through four SECURITY DEFINER
 * functions created in migration 005, each doing exactly one thing.
 *
 * Two reasons that is better than exposing the schema:
 *
 *   - Exposing a schema makes every table in it reachable, forever, including
 *     ones added later. Four named functions do not grow.
 *   - It removes a manual dashboard step from setup. A step that lives in a
 *     dashboard rather than in the repository is a step that gets skipped, and
 *     skipping this one produced an error that looked like a code bug.
 *
 * Nothing in this file ever returns an Aadhaar number. There is none stored.
 */

export interface PiiRecord {
  user_id: string;
  aadhaar_token: string;
  aadhaar_last4: string | null;
  phone_encrypted: string | null;
  address_encrypted: string | null;
  date_of_birth: string | null;
}

/** One record, or null when the user has no Aadhaar on file. */
export async function getPii(userId: string): Promise<PiiRecord | null> {
  const { data, error } = await db.rpc("pii_get", { p_user_id: userId });
  if (error) throw fromSupabase(error);
  // The function returns a set, so an empty array means "no record".
  const rows = (data ?? []) as PiiRecord[];
  return rows[0] ?? null;
}

/** Just the token, which is what most call sites actually want. */
export async function getAadhaarToken(userId: string): Promise<string | null> {
  const record = await getPii(userId);
  return record?.aadhaar_token ?? null;
}

/**
 * Who holds this token, or null.
 *
 * Used for the uniqueness check when an administrator attaches an Aadhaar
 * number, so the same number cannot be registered to two accounts.
 */
export async function ownerOfToken(token: string): Promise<string | null> {
  const { data, error } = await db.rpc("pii_owner_of", { p_token: token });
  if (error) throw fromSupabase(error);
  return (data as string | null) ?? null;
}

/**
 * Which users have a record, and the last four digits.
 *
 * Deliberately never returns the token: the admin list needs to show whether a
 * record exists, not to enumerate the tokens themselves.
 */
export async function piiDirectory(): Promise<{ user_id: string; aadhaar_last4: string | null }[]> {
  const { data, error } = await db.rpc("pii_directory");
  if (error) throw fromSupabase(error);
  return (data ?? []) as { user_id: string; aadhaar_last4: string | null }[];
}

/**
 * Creates or updates a record.
 *
 * Omitting an optional field leaves the stored value alone rather than erasing
 * it, so re-attaching an Aadhaar number without re-entering a phone number does
 * not wipe the phone number.
 */
export async function upsertPii(args: {
  userId: string;
  aadhaarToken: string;
  aadhaarLast4?: string | null;
  phoneEncrypted?: string | null;
  addressEncrypted?: string | null;
  dateOfBirth?: string | null;
}): Promise<void> {
  const { error } = await db.rpc("pii_upsert", {
    p_user_id: args.userId,
    p_aadhaar_token: args.aadhaarToken,
    p_aadhaar_last4: args.aadhaarLast4 ?? null,
    p_phone_encrypted: args.phoneEncrypted ?? null,
    p_address_encrypted: args.addressEncrypted ?? null,
    p_date_of_birth: args.dateOfBirth ?? null,
  });
  if (error) throw fromSupabase(error);
}

/** True when migration 005 has been applied. Used by the connection check. */
export async function piiAccessReady(): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db.rpc("pii_directory");
  if (!error) return { ok: true };
  return { ok: false, error: error.message };
}
