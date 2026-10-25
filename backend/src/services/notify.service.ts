import { db, unwrapList, unwrapMaybe } from "../lib/supabase";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Reminders for summons and bail check-ins (2.0 · F18), behind a provider
 * interface. The default provider is the sandbox: it records the message in the
 * outbox and sends nothing, so a deployment never texts anybody by accident.
 * NOTIFY_PROVIDER=email sends through the configured mail transport.
 *
 * A reminder names the obligation and the deadline. It never contains the case's
 * content, and it never says a person is in breach.
 */

export interface Notification {
  recipientUserId: string;
  template: "summons_due" | "checkin_due" | "checkin_missed";
  payload: Record<string, string | number>;
  dedupeKey: string;
}

export interface NotificationProvider {
  readonly name: "sandbox" | "email";
  deliver(message: Notification, address: { email: string | null }): Promise<{ status: "sent" | "skipped" | "failed"; error?: string }>;
}

const TEXT: Record<Notification["template"], (p: Record<string, string | number>) => { subject: string; body: string }> = {
  summons_due: (p) => ({
    subject: "Reminder: a summons is waiting for your acknowledgement",
    body: `A summons in case ${p.caseReference} needs your acknowledgement before ${p.deadline}. Sign in to NyaySetu to acknowledge it.`,
  }),
  checkin_due: (p) => ({
    subject: "Reminder: your next bail check-in",
    body: `Your next check-in for case ${p.caseReference} is due by ${p.deadline}. Check in from inside the permitted area with location turned on.`,
  }),
  checkin_missed: (p) => ({
    subject: "Your check-in was not received",
    body:
      `A check-in for case ${p.caseReference} due by ${p.deadline} was not received. If you could not check in, you can give the reason in NyaySetu; ` +
      "the court sees it beside the missed check-in.",
  }),
};

export function renderNotification(message: Notification) {
  return TEXT[message.template](message.payload);
}

const sandboxProvider: NotificationProvider = {
  name: "sandbox",
  async deliver(message) {
    logger.info("Sandbox notification (not sent)", { template: message.template, recipient: message.recipientUserId });
    return { status: "sent" };
  },
};

const emailProvider: NotificationProvider = {
  name: "email",
  async deliver(message, address) {
    if (!address.email) return { status: "skipped", error: "no email address on file" };
    try {
      const { sendPlainNotice } = await import("../lib/mailer");
      const text = renderNotification(message);
      await sendPlainNotice({ to: address.email, userId: message.recipientUserId, subject: text.subject, body: text.body, purpose: message.template });
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  },
};

let provider: NotificationProvider = env.NOTIFY_PROVIDER === "email" ? emailProvider : sandboxProvider;

export function notificationProvider(): NotificationProvider {
  return provider;
}

/** Test hook. */
export function setNotificationProvider(next: NotificationProvider | null) {
  provider = next ?? (env.NOTIFY_PROVIDER === "email" ? emailProvider : sandboxProvider);
}

/** Queues and delivers once per dedupe key. */
export async function notify(message: Notification): Promise<"sent" | "skipped" | "failed" | "duplicate"> {
  const exists = unwrapMaybe(await db.from("notification_outbox").select("id").eq("dedupe_key", message.dedupeKey).maybeSingle());
  if (exists) return "duplicate";
  const user = unwrapMaybe(await db.from("users").select("email").eq("id", message.recipientUserId).maybeSingle()) as { email: string } | null;
  const result = await provider.deliver(message, { email: user?.email ?? null });
  await db.from("notification_outbox").insert({
    recipient_user_id: message.recipientUserId,
    channel: provider.name === "email" ? "email" : "sandbox",
    template: message.template,
    payload: message.payload,
    dedupe_key: message.dedupeKey,
    status: result.status,
    provider: provider.name,
    error: result.error ?? null,
    sent_at: result.status === "sent" ? new Date().toISOString() : null,
  });
  return result.status;
}

/**
 * One pass of the reminder job: every pending summons whose window closes within
 * REMINDER_LEAD_HOURS, and every active bail order whose next check-in is due
 * within it or has been missed. Each reminder is sent once per deadline.
 */
export async function sendReminders(now = new Date()): Promise<{ queued: number }> {
  let queued = 0;
  const lead = env.REMINDER_LEAD_HOURS * 3_600_000;
  const iso = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const summons = unwrapList(
    await db
      .from("summons")
      .select("id, recipient_user_id, expiry_at, status, cases(case_reference)")
      .eq("status", "PENDING")
      .gt("expiry_at", now.toISOString())
      .lt("expiry_at", new Date(now.getTime() + lead).toISOString())
  ) as any[];
  for (const s of summons) {
    if (!s.recipient_user_id) continue;
    const r = await notify({
      recipientUserId: s.recipient_user_id,
      template: "summons_due",
      payload: { caseReference: s.cases?.case_reference ?? "your case", deadline: iso(new Date(s.expiry_at)) },
      dedupeKey: `summons_due:${s.id}`,
    });
    if (r === "sent") queued++;
  }

  const bails = unwrapList(
    await db.from("bail_conditions").select("id, accused_user_id, checkin_interval_seconds, created_at, active, cases(case_reference)").eq("active", true)
  ) as any[];
  for (const b of bails) {
    if (!b.accused_user_id) continue;
    const last = unwrapList(
      await db.from("checkins").select("occurred_at").eq("bail_id", b.id).order("occurred_at", { ascending: false }).limit(1)
    ) as { occurred_at: string }[];
    const since = new Date(last[0]?.occurred_at ?? b.created_at).getTime();
    const due = new Date(since + b.checkin_interval_seconds * 1000);
    const caseReference = b.cases?.case_reference ?? "your case";
    if (due.getTime() < now.getTime()) {
      if ((await notify({ recipientUserId: b.accused_user_id, template: "checkin_missed", payload: { caseReference, deadline: iso(due) }, dedupeKey: `checkin_missed:${b.id}:${due.toISOString()}` })) === "sent") queued++;
    } else if (due.getTime() - now.getTime() < lead) {
      if ((await notify({ recipientUserId: b.accused_user_id, template: "checkin_due", payload: { caseReference, deadline: iso(due) }, dedupeKey: `checkin_due:${b.id}:${due.toISOString()}` })) === "sent") queued++;
    }
  }
  return { queued };
}

export async function notificationsFor(userId: string) {
  const rows = unwrapList(
    await db.from("notification_outbox").select("id, template, payload, status, created_at").eq("recipient_user_id", userId).order("created_at", { ascending: false }).limit(50)
  ) as any[];
  return rows.map((r) => ({ ...r, ...renderNotification({ recipientUserId: userId, template: r.template, payload: r.payload, dedupeKey: "" }) }));
}
