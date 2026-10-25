/**
 * Runs both sweeps once and exits. Use this as a Railway cron command when the
 * API runs on more than one instance and SCHEDULER_ENABLED is off.
 *
 *   cd backend && npm run sweep
 */
import { initChain, chain } from "../lib/chain";
import { runSweeps } from "../jobs/scheduler";
import { runOnce as indexOnce } from "../indexer/eventIndexer";

async function main() {
  initChain();

  if (!chain.isReady) {
    console.error(`Chain not ready: ${chain.reason}`);
    process.exit(1);
  }

  const indexed = await indexOnce();
  const result = await runSweeps();

  console.log(
    JSON.stringify(
      {
        eventsIndexed: indexed.indexed,
        upToBlock: indexed.upTo,
        summonsMarkedFailed: result.summons.marked,
        bailMissedCheckIns: result.bail.flagged,
        cases: result.bail.cases,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
