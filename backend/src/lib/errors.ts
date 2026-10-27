/**
 * One error type for everything the client is allowed to know about, and a
 * default of "500, details in the log" for everything else. That split is what
 * stops a Postgres constraint name or a contract revert reason leaking into a
 * response body.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  /**
   * expose: whether the message may reach the client. Anything below 500 is the
   * client's own doing and always is. Of the 5xx family, 501 and 503 are raised
   * with messages written for a person ("the database could not be reached",
   * "run migration 014") and are shown too; a 500 or 502 is shown only when the
   * code that raised it says so. A 5xx never sends its details, which is where
   * driver and Postgres internals end up.
   */
  constructor(status: number, code: string, message: string, details?: unknown, options: { expose?: boolean } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = options.expose ?? (status < 500 || status === 501 || status === 503);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "BAD_REQUEST", message, details);

export const unauthorised = (message = "Sign in to continue.") =>
  new AppError(401, "UNAUTHORISED", message);

export const forbidden = (message = "Your role does not permit this action.") =>
  new AppError(403, "FORBIDDEN", message);

export const notFound = (what = "Resource") =>
  new AppError(404, "NOT_FOUND", `${what} not found.`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "CONFLICT", message, details);

export const tooMany = (message = "Too many attempts. Try again shortly.") =>
  new AppError(429, "RATE_LIMITED", message);

export const unavailable = (message: string) =>
  new AppError(503, "UNAVAILABLE", message);

/** Wraps a Supabase error object into something with a status code. */
export function fromSupabase(error: { message: string; code?: string; details?: string }): AppError {
  // P0001 is a deliberate RAISE from one of our own triggers, and its message
  // was written to be read by a person, so it is the one case where the database
  // text is passed through rather than replaced.
  if (error.code === "P0001") return conflict(error.message);
  // 23505 unique_violation, 23503 foreign_key_violation, 23514 check_violation
  if (error.code === "23505") return conflict("That record already exists.", error.details);
  if (error.code === "23503") return badRequest("Referenced record does not exist.", error.details);
  if (error.code === "23514") return badRequest("A value failed a database constraint.", error.details);
  if (error.code === "PGRST116") return notFound("Record");
  // An undefined table or column means the code is newer than the database: the
  // 2.0 migrations have not been run yet. Saying so beats a bare 500, because the
  // fix is a step for whoever owns the database, not a bug to hunt for.
  if (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    /does not exist|Could not find the .* (column|table)/i.test(error.message)
  ) {
    return new AppError(
      503,
      "SCHEMA_OUT_OF_DATE",
      "The database is missing a migration this version needs. Run the SQL files in " +
        "database/migrations from 008 onward, in order, then retry.",
      { reason: error.message }
    );
  }
  // The database never answered: DNS, a refused connection, a paused project.
  // supabase-js reports these with no code and the fetch failure as the message.
  if (!error.code && /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|timeout/i.test(error.message ?? "")) {
    return new AppError(
      503,
      "DB_UNREACHABLE",
      "The API could not reach its database, so nothing was saved. Check that the Supabase project " +
        "is running (free projects pause when idle) and that SUPABASE_URL is right, then retry.",
      { reason: error.message }
    );
  }
  // PostgREST refusing the service key: a rotated or mistyped SUPABASE_SERVICE_ROLE_KEY.
  if (error.code === "PGRST301" || error.code === "401" || /invalid api key|jwt|no api key/i.test(error.message ?? "")) {
    return new AppError(
      503,
      "DB_UNAUTHORISED",
      "The database refused the API's credentials, so nothing was saved. Check SUPABASE_SERVICE_ROLE_KEY " +
        "in backend/.env against Supabase → Settings → API, then restart the API.",
      { reason: error.message }
    );
  }
  return new AppError(500, "DB_ERROR", error.message, error.details);
}
