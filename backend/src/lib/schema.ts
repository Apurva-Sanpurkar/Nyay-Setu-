import { db } from "./supabase";
import { logger } from "./logger";

/**
 * Which optional migrations have actually been applied.
 *
 * Supabase does not let the API run DDL, so migrations are pasted into the SQL
 * editor by a human, and there is always a window where the code is newer than
 * the database. The dangerous case is the session lookup: if it selects a column
 * that does not exist yet, PostgREST errors, every session read fails, and the
 * whole deployment looks like "nobody can sign in" with no hint as to why.
 *
 * So the columns added by 006 are probed once, cached, and everything that reads
 * them degrades to a safe default until they appear. The probe is one request per
 * process lifetime, not per session.
 */

let invitationsProbe: Promise<boolean> | null = null;

/** True once 006_invitations.sql has been applied. */
export function invitationsReady(): Promise<boolean> {
  if (!invitationsProbe) {
    invitationsProbe = (async () => {
      const { error } = await db.from("users").select("must_change_password").limit(1);
      if (error) {
        logger.warn(
          "Invitation columns are missing. Run database/migrations/006_invitations.sql in the " +
            "Supabase SQL editor; until then new accounts will not be forced to change their password.",
          { reason: error.message }
        );
        return false;
      }
      return true;
    })();
  }
  return invitationsProbe;
}

/** Forces the next call to probe again. Used after a migration is applied. */
export function resetSchemaProbes(): void {
  invitationsProbe = null;
}
