import { chain, contractFor, ContractName } from "../lib/chain";
import { db } from "../lib/supabase";
import { logger } from "../lib/logger";
import { env } from "../config/env";

/**
 * Materialises contract events into public.chain_events.
 *
 * Polling rather than a websocket subscription, deliberately: a dropped socket
 * silently stops delivering events, whereas a poll that fails simply retries
 * from the last block it recorded. The cursor lives in the database, so a
 * restart does not lose or duplicate history.
 *
 * The chain stays authoritative. This table is a read cache so a dashboard can
 * sort and filter without paying for an RPC round trip per row.
 */

const CONTRACTS: ContractName[] = ["EvidenceChain", "SummonsChain", "BailChain"];

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * The window size actually in use, which may be smaller than configured.
 *
 * Halved whenever a provider refuses the range and restored on nothing, because a
 * provider that rejected 2000 blocks once will reject it again. Alchemy's free
 * tier permits ten; a paid endpoint takes thousands. INDEXER_MAX_RANGE is the
 * opening bid and this is what the provider turned out to allow.
 */
let activeRange = env.INDEXER_MAX_RANGE;

/** Whether an RPC error is "your block range is too wide" rather than a real fault. */
function isRangeRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /block range|10 block|range should work|query returned more than|limit exceeded|too many results/i.test(
    message
  );
}

/**
 * The cursor key.
 *
 * Includes the chain id, and that is the fix for a bug that stalled the indexer
 * completely. indexer_state was keyed on the contract name alone, so switching the
 * deployment from a local Hardhat chain to Sepolia left the cursor sitting at block
 * 206 — a perfectly good position on a chain that had 2,206 blocks, and eleven
 * million blocks behind one that has 11,793,000. The indexer then asked for a range
 * starting at 207 and never reached anything that mattered.
 *
 * A cursor is only meaningful on the chain it was recorded against, so the chain is
 * part of its identity. Existing rows keyed on the bare name are simply left alone.
 */
function cursorKey(contract: ContractName): string {
  const chainId = chain.network?.chainId;
  return chainId ? `${contract}@${chainId}` : contract;
}

/**
 * Where to resume from, with a sanity check.
 *
 * A stored cursor ahead of the chain's own head cannot have come from this chain,
 * and one that is impossibly far behind cannot be caught up with in any reasonable
 * time. Both are treated the same way: start at the deployment block, which is the
 * earliest block that can hold an event of ours.
 */
async function cursorFor(contract: ContractName, latest: number): Promise<number> {
  const key = cursorKey(contract);
  const deployed = chain.deploymentBlock;

  // One block before the deployment, so the first window includes it. Falling back
  // to a short window behind the head keeps a chain with no recorded deployment
  // block from scanning its whole history.
  const floor = deployed !== null ? Math.max(0, deployed - 1) : Math.max(0, latest - activeRange);

  const { data } = await db
    .from("indexer_state")
    .select("last_block")
    .eq("contract", key)
    .maybeSingle();

  const stored = data?.last_block === undefined || data?.last_block === null ? null : Number(data.last_block);

  if (stored !== null && stored <= latest && stored >= floor) return stored;

  if (stored !== null) {
    logger.warn(
      "Indexer cursor does not belong to this chain; restarting from the deployment block",
      { contract, stored, latest, restartingAt: floor }
    );
  }

  await db.from("indexer_state").upsert({ contract: key, last_block: floor }, { onConflict: "contract" });
  return floor;
}

function serialiseArgs(parsed: { fragment: { inputs: { name: string }[] }; args: readonly unknown[] }) {
  const out: Record<string, unknown> = {};
  parsed.fragment.inputs.forEach((input, index) => {
    const value = parsed.args[index];
    // bigint is not JSON-serialisable, and a block timestamp must not lose
    // precision, so every integer is stored as a decimal string.
    out[input.name] = typeof value === "bigint" ? value.toString() : value;
  });
  return out;
}

/**
 * Indexes one window, and reports whether there is more to do.
 *
 * Windows rather than one sweep because a provider caps the span of a single
 * eth_getLogs, and several small calls per pass is what lets a fresh index catch
 * up with a chain that is producing blocks while it works.
 */
async function indexWindow(
  name: ContractName,
  latest: number
): Promise<{ inserted: number; caughtUp: boolean }> {
  const contract = contractFor(name);
  const from = (await cursorFor(name, latest)) + 1;
  if (from > latest) return { inserted: 0, caughtUp: true };

  const to = Math.min(latest, from + activeRange - 1);

  let logs;
  try {
    logs = await contract.queryFilter("*", from, to);
  } catch (error) {
    if (isRangeRefusal(error) && activeRange > 1) {
      activeRange = Math.max(1, Math.floor(activeRange / 2));
      logger.warn("The provider refused that block range; narrowing it", {
        contract: name,
        attempted: to - from + 1,
        nowUsing: activeRange,
        hint:
          "Alchemy's free tier permits ten blocks per eth_getLogs. Set INDEXER_MAX_RANGE to match " +
          "your provider, or use a paid endpoint to index faster.",
      });
      return { inserted: 0, caughtUp: false };
    }
    throw error;
  }

  let inserted = 0;
  const rows: any[] = [];

  for (const log of logs) {
    const parsed = (log as any).fragment
      ? (log as any)
      : contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;

    const eventName: string | undefined = (log as any).eventName ?? parsed.name;
    if (!eventName) continue;

    rows.push({
      contract: name,
      event_name: eventName,
      block_number: log.blockNumber,
      tx_hash: log.transactionHash,
      log_index: (log as any).index ?? (log as any).logIndex ?? 0,
      args: serialiseArgs(parsed),
    });
  }

  if (rows.length > 0) {
    // onConflict on (tx_hash, log_index) makes a replayed range idempotent.
    const { error, count } = await db
      .from("chain_events")
      .upsert(rows, { onConflict: "tx_hash,log_index", ignoreDuplicates: true, count: "exact" });
    if (error) {
      // The cursor is deliberately NOT advanced: a window whose events could not be
      // stored must be retried, or the events are lost silently.
      logger.warn("Could not store chain events", { contract: name, error: error.message });
      return { inserted: 0, caughtUp: false };
    }
    inserted = count ?? rows.length;
  }

  await db
    .from("indexer_state")
    .upsert(
      { contract: cursorKey(name), last_block: to, updated_at: new Date().toISOString() },
      { onConflict: "contract" }
    );

  return { inserted, caughtUp: to >= latest };
}

/** Walks up to INDEXER_CHUNKS_PER_PASS windows, or until it catches up. */
async function indexContract(name: ContractName, latest: number): Promise<number> {
  let total = 0;

  for (let pass = 0; pass < env.INDEXER_CHUNKS_PER_PASS; pass++) {
    const { inserted, caughtUp } = await indexWindow(name, latest);
    total += inserted;
    if (caughtUp) break;
  }

  return total;
}

export async function runOnce(): Promise<{ indexed: number; upTo: number | null }> {
  if (!chain.isReady) return { indexed: 0, upTo: null };

  const latest = await chain.blockNumber();
  if (latest === null) return { indexed: 0, upTo: null };

  let total = 0;
  for (const name of CONTRACTS) {
    try {
      total += await indexContract(name, latest);
    } catch (error) {
      logger.warn("Indexer pass failed for a contract", {
        contract: name,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  if (total > 0) logger.info("Indexed contract events", { count: total, upTo: latest });
  return { indexed: total, upTo: latest };
}

export function startIndexer(): void {
  if (!env.INDEXER_ENABLED) {
    logger.info("Event indexer disabled by INDEXER_ENABLED=false");
    return;
  }
  if (!chain.isReady) {
    logger.warn("Event indexer not started: the chain bridge is not ready", { reason: chain.reason });
    return;
  }
  if (timer) return;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(tick, Math.max(5000, env.SWEEP_INTERVAL_MS / 4));
  timer.unref();
  logger.info("Event indexer started");
}

export function stopIndexer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
