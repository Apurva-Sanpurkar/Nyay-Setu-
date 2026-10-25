import { env } from "../config/env";
import { logger } from "../lib/logger";
import { chain } from "../lib/chain";
import { sweepNonDelivery } from "../services/summons.service";
import { sweepMissedCheckIns } from "../services/bail.service";
import { trackAnchors } from "../services/verification/anchors";
import { relinkRegistrations } from "../services/evidence.service";
import { detectDiscrepancies } from "../services/alerts.service";
import { sendReminders } from "../services/notify.service";

/**
 * The two jobs that make non-events visible.
 *
 * A chain reacts to transactions. It cannot react to a summons nobody opened or
 * a check-in nobody filed, because nothing happened. Both contracts therefore
 * compute those conditions lazily in views, so dashboards are correct at all
 * times, and these jobs write the conclusions down so the alert exists as a
 * transaction the court can point at.
 *
 * setInterval rather than cron: one process, one schedule, no extra dependency.
 * For a multi-instance deployment set SCHEDULER_ENABLED=false on all but one,
 * or move these to a Railway cron service calling the /sweep endpoints.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runSweeps(): Promise<{
  summons: { marked: number; ids: string[] };
  bail: { flagged: number; cases: string[] };
  anchors: { checked: number; changed: number; relinked: number };
}> {
  // The chain sweeps need the chain; the detector and reminders do not — and an
  // outage is exactly when the detector matters most.
  const ready = chain.isReady;
  const summons = ready ? await sweepNonDelivery() : { marked: 0, ids: [] };
  const bail = ready ? await sweepMissedCheckIns() : { flagged: 0, cases: [] };
  // Verification: advance SUBMITTED anchors by confirmation depth, catch drops,
  // reverts and reorgs, then copy any newly learned chain ids onto evidence rows.
  const tracked = ready ? await trackAnchors() : { checked: 0, changed: 0 };
  const relinked = await relinkRegistrations();
  const anchors = { ...tracked, relinked };
  // Alerts for whatever could not be verified. Raised once each; never acted on automatically.
  const alerts = await detectDiscrepancies().catch((error) => {
    logger.warn("Discrepancy detection failed", { error: error instanceof Error ? error.message : error });
    return { raised: 0 };
  });
  if (alerts.raised > 0) logger.info("Discrepancy alerts raised", alerts);
  // Reminders for summons and check-ins, once per deadline (sandbox unless NOTIFY_PROVIDER=email).
  await sendReminders().catch((error) => logger.warn("Reminders failed", { error: error instanceof Error ? error.message : error }));

  if (summons.marked > 0 || bail.flagged > 0) {
    logger.info("Sweep completed", {
      summonsMarkedFailed: summons.marked,
      bailMissedCheckIns: bail.flagged,
      cases: bail.cases,
    });
  }
  if (anchors.changed > 0 || relinked > 0) logger.info("Verification tracker pass", anchors);
  return { summons, bail, anchors };
}

export function startScheduler(): void {
  if (!env.SCHEDULER_ENABLED) {
    logger.info("Scheduler disabled by SCHEDULER_ENABLED=false");
    return;
  }
  if (timer) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSweeps();
    } catch (error) {
      logger.error("Sweep failed", { error: error instanceof Error ? error.message : error });
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, env.SWEEP_INTERVAL_MS);
  timer.unref();
  logger.info("Scheduler started", { intervalMs: env.SWEEP_INTERVAL_MS });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
