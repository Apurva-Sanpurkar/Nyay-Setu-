import { db, unwrap, unwrapList, unwrapMaybe } from "../../lib/supabase";
import { env } from "../../config/env";
import { forbidden, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { stationNorm } from "../../lib/similarity";
import { sendPlainNotice } from "../../lib/mailer";
import type { SessionUser } from "../../middleware/auth";

/**
 * Alerts from one police station to another: "a vehicle you hold a complaint
 * for may have been found", "a case at your station may be linked to ours".
 *
 * Delivered on the dashboard always, and by email to the officers of the
 * receiving station when email notifications are configured. The email names no
 * vehicle, person or place; it only says there is something to open.
 */

export type AlertKind = "vehicle_match" | "vehicle_recovered" | "third_eye_link";

export async function raiseStationAlert(args: {
  targetStation: string;
  kind: AlertKind;
  subjectType: "vehicle_match" | "vehicle_report" | "ti_lead";
  subjectId: string;
  title: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  createdBy: string | null;
}): Promise<{ id: string; created: boolean } | null> {
  const target = stationNorm(args.targetStation);
  if (!target) return null;

  const existing = unwrapMaybe(await db.from("station_alerts").select("id").eq("dedupe_key", args.dedupeKey).maybeSingle()) as { id: string } | null;
  if (existing) return { id: existing.id, created: false };

  const row = unwrap(
    await db
      .from("station_alerts")
      .insert({
        target_station: target,
        kind: args.kind,
        subject_type: args.subjectType,
        subject_id: args.subjectId,
        title: args.title,
        payload: args.payload,
        status: "unread",
        dedupe_key: args.dedupeKey,
        created_by: args.createdBy,
      })
      .select("id")
      .single()
  ) as { id: string };

  if (env.emailNotificationsEnabled) void emailStation(target, args.title).catch(() => undefined);
  return { id: row.id, created: true };
}

async function emailStation(target: string, title: string) {
  const officers = (unwrapList(
    await db.from("users").select("id, email, station_or_court, is_active").eq("role", "police").eq("is_active", true)
  ) as { id: string; email: string; station_or_court: string | null }[]).filter((u) => stationNorm(u.station_or_court) === target);

  for (const officer of officers.slice(0, 20)) {
    try {
      await sendPlainNotice({
        to: officer.email,
        userId: officer.id,
        purpose: "station_alert",
        subject: `NyaySetu: ${title}`,
        body: "There is a new inter-station alert for your police station. Sign in to NyaySetu and open Station alerts to see it.",
      });
    } catch (error) {
      logger.warn("Could not email a station alert", { error: error instanceof Error ? error.message : error });
    }
  }
}

/** Alerts addressed to the officer's own station; the registry sees all. */
export async function listStationAlerts(user: SessionUser, status?: string) {
  let query = db.from("station_alerts").select("*").order("created_at", { ascending: false }).limit(200);
  if (user.role !== "court_admin") query = query.eq("target_station", stationNorm(user.stationOrCourt));
  if (status) query = query.eq("status", status);
  return unwrapList(await query) as any[];
}

export async function updateStationAlert(user: SessionUser, id: string, status: "read" | "actioned") {
  const alert = unwrapMaybe(await db.from("station_alerts").select("*").eq("id", id).maybeSingle()) as any;
  if (!alert) throw notFound("Alert");
  if (alert.target_station !== stationNorm(user.stationOrCourt)) throw forbidden("This alert is addressed to another police station.");
  return unwrap(
    await db
      .from("station_alerts")
      .update({ status, read_by: user.id, read_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single()
  );
}
