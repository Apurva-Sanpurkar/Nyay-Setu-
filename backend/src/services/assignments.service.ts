import { db, unwrapList } from "../lib/supabase";

/**
 * Who is assigned to a case, resolved to people.
 *
 * WHY THIS IS TWO QUERIES AND NOT ONE EMBED
 *   `case_assignments` carries two foreign keys to `users` — `user_id`, the person
 *   assigned, and `assigned_by`, the registrar who did it. PostgREST cannot tell
 *   which one an embed means, so it refuses the whole request:
 *
 *     PGRST201  Could not embed because more than one relationship was found
 *               for 'case_assignments' and 'user_directory'
 *
 *   That surfaced as a 500 on GET /api/cases/:id, and — worse — as a silently
 *   EMPTY participants table in the Final Report, because the dossier loader
 *   swallowed the error and carried on with no rows. A court document listing
 *   nobody as having access is not a cosmetic fault.
 *
 *   PostgREST offers disambiguating syntax, `user_directory!case_assignments_user_id_fkey`,
 *   and it is the wrong fix here: it writes a constraint name into a query, so
 *   renaming the constraint breaks this silently, at runtime, in a document nobody
 *   re-reads. Two explicit queries cannot be broken that way.
 *
 * WHY THE DIRECTORY VIEW AND NOT THE TABLE
 *   `user_directory` exposes name, role, designation and posting, and nothing else.
 *   Reading `users` directly here would put a password hash and an email on a code
 *   path that only needs a name. Callers that genuinely need an address ask for it.
 */

export interface CaseParticipant {
  id: string;
  full_name: string;
  role: string;
  designation: string | null;
  station_or_court: string | null;
  access: "read" | "write";
}

/** Everyone assigned to a case, with the access each was granted. */
export async function listCaseParticipants(caseId: string): Promise<CaseParticipant[]> {
  const assignments = unwrapList(
    await db.from("case_assignments").select("user_id, access").eq("case_id", caseId)
  ) as { user_id: string; access: "read" | "write" }[];

  if (assignments.length === 0) return [];

  const accessById = new Map(assignments.map((a) => [a.user_id, a.access]));

  const people = unwrapList(
    await db
      .from("user_directory")
      .select("id, full_name, role, designation, station_or_court")
      .in(
        "id",
        assignments.map((a) => a.user_id)
      )
  ) as Omit<CaseParticipant, "access">[];

  // The directory view filters out deactivated accounts, so somebody assigned and
  // later suspended simply does not appear. That is the right answer: they cannot
  // open the case either.
  return people.map((person) => ({
    ...person,
    access: accessById.get(person.id) ?? "read",
  }));
}

/**
 * The same list, with email addresses, for the routes that send something.
 *
 * Separate from the above so an address is only read when a caller has a reason to
 * send mail, rather than travelling along with every dossier read.
 */
export async function listCaseRecipients(
  caseId: string
): Promise<{ id: string; email: string; full_name: string; role: string; access: string }[]> {
  const assignments = unwrapList(
    await db.from("case_assignments").select("user_id, access").eq("case_id", caseId)
  ) as { user_id: string; access: string }[];

  if (assignments.length === 0) return [];

  const accessById = new Map(assignments.map((a) => [a.user_id, a.access]));

  const people = unwrapList(
    await db
      .from("users")
      .select("id, email, full_name, role, is_active")
      .in(
        "id",
        assignments.map((a) => a.user_id)
      )
  ) as { id: string; email: string; full_name: string; role: string; is_active: boolean }[];

  return people
    .filter((p) => p.is_active && p.email)
    .map((p) => ({
      id: p.id,
      email: p.email,
      full_name: p.full_name,
      role: p.role,
      access: accessById.get(p.id) ?? "read",
    }));
}
