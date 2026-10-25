import { Request } from "express";
import { db } from "../lib/supabase";
import { logger } from "../lib/logger";

/**
 * API-level audit trail.
 *
 * The database trigger in migration 003 records row diffs. This records
 * intent, including the attempts that produced no row at all. A refused tamper
 * attempt is the clearest example: nothing changed, so a row-diff audit is
 * silent, yet it is exactly the event a court would want to see.
 */
export async function recordAction(
  req: Request,
  args: {
    action: string;
    subject?: string | null;
    caseId?: string | null;
    outcome?: "ok" | "refused" | "failed";
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await db.from("action_log").insert({
      actor_id: req.user?.id ?? null,
      actor_role: req.user?.role ?? null,
      action: args.action,
      subject: args.subject ?? null,
      case_id: args.caseId ?? null,
      outcome: args.outcome ?? "ok",
      detail: (args.detail ?? null) as any,
      ip_address: req.ip ?? null,
      user_agent: req.get("user-agent")?.slice(0, 400) ?? null,
    });
  } catch (error) {
    // An audit failure must never break the operation being audited, but it
    // must be loud in the log.
    logger.error("Could not write action_log entry", {
      action: args.action,
      error: error instanceof Error ? error.message : error,
    });
  }
}
