import { Router } from "express";
import { env, capabilities } from "../config/env";
import { productionFindings } from "../config/posture";
import { chain } from "../lib/chain";
import { pingDatabase, schemaStatus } from "../lib/supabase";
import { health as aiHealth } from "../lib/ai";
import { loginOtpProvider, otpProvider } from "../otp";
import { mailerHealth } from "../lib/mailer";
import { asyncRoute } from "../middleware/error";
import { safeEqual } from "../lib/crypto";
import { notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { runSweeps } from "../jobs/scheduler";
import { runOnce as indexOnce } from "../indexer/eventIndexer";

const router = Router();

/** From package.json, two levels up from both src/routes and dist/routes. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require("../../package.json") as { version: string };

/**
 * Honest health reporting. Every subsystem says whether it is configured and
 * whether it is actually reachable, and the OTP provider says out loud whether
 * it is authorised for production. A demo deployment should never be mistakable
 * for an Aadhaar-verified one.
 */
router.get(
  "/",
  asyncRoute(async (_req, res) => {
    const [database, schema, ai, blockNumber, keeperBalance, mail] = await Promise.all([
      pingDatabase(),
      schemaStatus(),
      aiHealth(),
      chain.blockNumber(),
      chain.keeperBalance(),
      mailerHealth(),
    ]);

    const healthy = database;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      version,
      environment: env.NODE_ENV,
      /**
       * The origins this instance will accept credentialed requests from.
       *
       * Published deliberately. It is not a secret — every preflight response
       * discloses it — and it is the fastest way to settle the question a CORS
       * failure actually raises, which is not "is the API up" but "did the
       * environment variable I just set reach the running process". Curl this
       * and you can see, rather than infer, what it loaded.
       */
      allowedOrigins: env.corsOrigins,
      subsystems: {
        database: {
          configured: true,
          reachable: database,
          schema: database
            ? { upToDate: schema.upToDate, missingMigrations: schema.missing, note: schema.upToDate ? undefined : "Run the listed migrations in order; the features they add will refuse with SCHEMA_OUT_OF_DATE until then." }
            : null,
        },
        blockchain: {
          configured: capabilities.chain,
          ready: chain.isReady,
          reason: chain.reason,
          network: chain.network,
          blockNumber,
          keeper: chain.keeperAddress ?? null,
          keeperBalanceWei: keeperBalance,
          addresses: chain.isReady ? chain.addresses : null,
        },
        storage: {
          backend: capabilities.ipfs ? "pinata" : "local-fallback",
          configured: capabilities.ipfs,
          note: capabilities.ipfs
            ? "Encrypted blobs are pinned to IPFS."
            : "Pinata is not configured; encrypted blobs are written to disk. Not for production.",
        },
        ai: {
          configured: capabilities.ai,
          reachable: ai,
          note: ai ? undefined : "Evidence screening and risk scoring will report themselves unavailable.",
        },
        email: {
          configured: mail.configured,
          reachable: mail.reachable,
          // "smtp", "brevo" or "resend". Worth publishing: a timeout on SMTP and a
          // refused key on an HTTP provider need completely different fixes.
          transport: mail.transport,
          host: mail.host,
          from: mail.from,
          error: mail.error,
          note:
            mail.note ??
            (mail.reachable
              ? `Verified over ${mail.transport}. Sign-in codes and notices are live.`
              : "Configured, but the provider refused. See error."),
        },
        identity: {
          // Citizen actions: acknowledging a summons, filing a bail check-in.
          citizenChannel: otpProvider.name,
          citizenAuthorisedForProduction: otpProvider.isAuthorisedForProduction,
          // Sign-in second factor.
          loginChannel: loginOtpProvider?.name ?? null,
          loginOtpEnabled: Boolean(loginOtpProvider),
          // Kept for older clients that read these two field names.
          provider: otpProvider.name,
          authorisedForProduction: otpProvider.isAuthorisedForProduction,
          note: [
            otpProvider.isAuthorisedForProduction
              ? "Live UIDAI provider selected for citizen actions."
              : "Citizen actions use the sandbox Aadhaar provider: simulated, not Aadhaar-verified.",
            loginOtpProvider
              ? "Sign-in requires a real emailed code."
              : "Sign-in is password-only.",
          ].join(" "),
        },
      },

      // Every documented fallback still in use, each with the reason it matters.
      // Named here as well as in the boot log, because a hosted instance's log is
      // somewhere you have to go looking and this endpoint is not.
      posture: productionFindings(),
    });
  })
);

/**
 * Runs the sweeps once, for a hosted cron.
 *
 * WHY THIS EXISTS
 *   Two things in this system are not events. A summons that nobody acknowledged
 *   within 72 hours, and a bail check-in that never happened, are both the absence
 *   of a transaction, and an absence cannot emit one. The contracts compute them
 *   lazily in view functions, but something still has to write the conclusion down
 *   and raise the alert, and normally that something is the in-process scheduler.
 *
 *   On a platform where the process does not outlive a request — anything
 *   serverless — that scheduler never ticks. So the same work is exposed as one
 *   POST that an external cron can call, and SCHEDULER_ENABLED is set to false.
 *
 * WHY IT IS NOT UNDER /api/admin
 *   A cron has no session and no browser, so it cannot hold a session cookie or
 *   a CSRF token. It authenticates with a bearer secret instead, compared in
 *   constant time. The route is only mounted when that secret is configured:
 *   an unset CRON_SECRET must mean "no such endpoint", never "no password".
 */
if (capabilities.cron) {
  router.post(
    "/sweep",
    asyncRoute(async (req, res) => {
      const offered = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!offered || !safeEqual(offered, env.CRON_SECRET!)) {
        // Deliberately indistinguishable from the route not existing.
        throw notFound("Resource");
      }

      if (!chain.isReady) {
        return res.status(503).json({ ok: false, reason: chain.reason });
      }

      const indexed = await indexOnce();
      const swept = await runSweeps();

      logger.info("Sweep ran from cron", {
        eventsIndexed: indexed.indexed,
        summonsMarkedFailed: swept.summons.marked,
        bailMissedCheckIns: swept.bail.flagged,
      });

      res.json({
        ok: true,
        eventsIndexed: indexed.indexed,
        upToBlock: indexed.upTo,
        summonsMarkedFailed: swept.summons.marked,
        bailMissedCheckIns: swept.bail.flagged,
      });
    })
  );
}

export default router;