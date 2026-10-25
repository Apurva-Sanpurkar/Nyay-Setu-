/**
 * The background worker: the event indexer and the scheduler, without HTTP.
 *
 * Runs as a Vercel Daemon (backend/Dockerfile.worker) next to the API
 * functions. The loops notice what did not happen — a summons left
 * unacknowledged for 72 hours, a bail check-in that never arrived — and keep
 * verification states moving (SUBMITTED → CONFIRMED) after a request has
 * finished. Run exactly one instance.
 */
import { initChain, chain } from "./lib/chain";
import { pingDatabase } from "./lib/supabase";
import { logger } from "./lib/logger";
import { startIndexer, stopIndexer } from "./indexer/eventIndexer";
import { startScheduler, stopScheduler } from "./jobs/scheduler";

async function main() {
  initChain();
  const database = await pingDatabase();
  logger.info("NyaySetu worker starting", {
    database: database ? "reachable" : "UNREACHABLE",
    chain: chain.isReady ? chain.network : `not ready (${chain.reason})`,
  });

  startIndexer();
  startScheduler();

  const shutdown = (signal: string) => {
    logger.info("Worker shutting down", { signal });
    stopIndexer();
    stopScheduler();
    // Give an in-flight sweep a moment to finish its current write.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", { reason }));
}

void main();
