import { app } from "./app";
import { env, capabilities } from "./config/env";
import { reportPosture } from "./config/posture";
import { logger } from "./lib/logger";
import { initChain, chain } from "./lib/chain";
import { pingDatabase } from "./lib/supabase";
import { otpProvider } from "./otp";
import { startIndexer, stopIndexer } from "./indexer/eventIndexer";
import { startScheduler, stopScheduler } from "./jobs/scheduler";

/** Boots the API: chain bridge, database probe, HTTP listener, indexer, jobs. */
async function start() {
  initChain();

  // A fully local run: seed the in-memory database (refused for a real one).
  if (process.env.NYAY_DB === "memory" && process.env.DEV_SEED === "true") {
    const { seedMemoryDatabase } = await import("./scripts/devSeed");
    await seedMemoryDatabase();
  }

  const databaseReachable = await pingDatabase();
  if (!databaseReachable) {
    logger.error(
      "Supabase is not reachable. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, " +
        "and that the migrations in database/migrations have been run."
    );
  }

  const server = app.listen(env.PORT, () => {
    logger.info("NyaySetu API listening", {
      port: env.PORT,
      environment: env.NODE_ENV,
      database: databaseReachable ? "reachable" : "UNREACHABLE",
      chain: chain.isReady ? chain.network : `not ready (${chain.reason})`,
      storage: capabilities.ipfs ? "pinata" : "local-fallback",
      ai: capabilities.ai ? "configured" : "not configured",
      otpProvider: `${otpProvider.name}${otpProvider.isAuthorisedForProduction ? "" : " (simulated)"}`,
      corsOrigins: env.corsOrigins,
    });

    // Said separately, and loudly, because getting this wrong is invisible from
    // the API side: every route works, every health check passes, and the only
    // symptom is a browser on another origin being refused before it arrives.
    if (env.isProduction && env.corsOrigins.every((o) => o.startsWith("http://localhost"))) {
      logger.error(
        "CORS_ORIGINS still lists only localhost while NODE_ENV=production. " +
          "No deployed site will be able to reach this API.",
        { configured: env.corsOrigins }
      );
    }
    if (env.corsOrigins.some((o) => o.includes("*"))) {
      logger.warn(
        "CORS_ORIGINS contains a wildcard. Every site matching it may send " +
          "credentialed requests to this API.",
        { configured: env.corsOrigins.filter((o) => o.includes("*")) }
      );
    }
  });

  startIndexer();
  startScheduler();

  // Last, so it is the final thing in the log rather than the first: whoever is
  // reading a boot log is looking at the end of it.
  reportPosture();

  const shutdown = (signal: string) => {
    logger.info("Shutting down", { signal });
    stopIndexer();
    stopScheduler();
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason });
  });
}

void start();
