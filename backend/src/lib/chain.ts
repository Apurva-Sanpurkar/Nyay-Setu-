import * as fs from "fs";
import * as path from "path";
import { Contract, Interface, JsonRpcProvider, Log, TransactionReceipt, Wallet } from "ethers";
import { env } from "../config/env";
import { logger } from "./logger";
import { unavailable, badRequest, AppError } from "./errors";
import { db } from "./supabase";

/**
 * The Ethers bridge. Everything on-chain goes through here.
 *
 * Two behaviours worth calling out:
 *
 * 1. Graceful degradation. If no RPC URL or keeper key is configured the module
 *    reports itself not-ready and chain-backed endpoints answer 503 with the
 *    reason. A fresh clone therefore boots, serves the UI and tells you exactly
 *    what to configure, instead of crashing on import.
 *
 * 2. A serial submit queue. The keeper is a single wallet relaying many
 *    citizens' actions. Two concurrent sends would fetch the same nonce and one
 *    would be dropped, so every transaction waits its turn.
 */

const CONTRACT_NAMES = ["EvidenceChain", "SummonsChain", "BailChain"] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

interface Deployment {
  network: string;
  chainId: number;
  deployer: string;
  deployedAt?: string;
  /** The block the contracts were deployed in. Written by scripts/deploy.ts. */
  blockNumber?: number;
  contracts: Record<string, { address: string; abi: any[] }>;
}

interface ChainState {
  ready: boolean;
  reason: string;
  provider?: JsonRpcProvider;
  wallet?: Wallet;
  deployment?: Deployment;
  contracts: Partial<Record<ContractName, Contract>>;
}

const state: ChainState = { ready: false, reason: "not initialised", contracts: {} };

// ------------------------------------------------------------------ artefacts

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (env.DEPLOYED_ARTIFACT) paths.push(path.resolve(process.cwd(), env.DEPLOYED_ARTIFACT));
  const deployedDir = path.resolve(process.cwd(), "..", "contracts", "deployed");
  paths.push(path.join(deployedDir, `${env.CHAIN_NETWORK}.json`));
  paths.push(path.join(deployedDir, "latest.json"));
  // The backend's own synced copy (scripts/deployment-sync.mjs), for bundles that
  // do not contain ../contracts: a Vercel function or a backend-only container.
  for (const dir of [path.resolve(__dirname, "..", "deployed"), path.resolve(process.cwd(), "src", "deployed"), path.resolve(process.cwd(), "dist", "deployed")]) {
    paths.push(path.join(dir, `${env.CHAIN_NETWORK}.json`));
  }
  return paths;
}

function loadDeployment(): Deployment | null {
  for (const file of candidatePaths()) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
      if (!parsed.contracts) continue;
      logger.info("Loaded contract deployment", { file, network: parsed.network });
      return parsed;
    } catch (error) {
      logger.warn("Deployment artefact is not valid JSON", { file });
    }
  }
  return null;
}

/**
 * An explicit address from the environment, or undefined to use the artefact.
 * Anything that is not a well-formed address is treated as absent and warned
 * about, rather than being handed to ethers, which would interpret it as an ENS
 * name and fail deep inside a contract call.
 */
function addressOverride(name: ContractName): string | undefined {
  const raw =
    name === "EvidenceChain"
      ? env.EVIDENCE_CHAIN_ADDRESS
      : name === "SummonsChain"
        ? env.SUMMONS_CHAIN_ADDRESS
        : env.BAIL_CHAIN_ADDRESS;

  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    logger.warn("Ignoring a malformed contract address override", { contract: name, value: raw });
    return undefined;
  }
  return raw;
}

export function initChain(): void {
  if (!env.CHAIN_RPC_URL) {
    state.reason =
      "CHAIN_RPC_URL is not set. Start a local chain (cd contracts && npm run node) or point at Sepolia.";
    return;
  }
  if (!env.CHAIN_PRIVATE_KEY) {
    state.reason = "CHAIN_PRIVATE_KEY is not set. The keeper wallet relays every citizen action.";
    return;
  }

  const deployment = loadDeployment();
  if (!deployment) {
    state.reason =
      "No deployment artefact found. Run `npm run deploy:local` (or deploy:sepolia) in contracts/.";
    return;
  }

  try {
    const provider = new JsonRpcProvider(env.CHAIN_RPC_URL);
    const wallet = new Wallet(env.CHAIN_PRIVATE_KEY, provider);

    for (const name of CONTRACT_NAMES) {
      const info = deployment.contracts[name];
      if (!info) throw new Error(`${name} missing from the deployment artefact.`);

      const address = addressOverride(name) ?? info.address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
        throw new Error(
          `${name} has no usable address. The deployment artefact gave "${info.address}". ` +
            "Re-run the deploy script."
        );
      }
      state.contracts[name] = new Contract(address, info.abi, wallet);
    }

    state.provider = provider;
    state.wallet = wallet;
    resetNonce();
    state.deployment = deployment;
    state.ready = true;
    state.reason = "ready";

    logger.info("Chain bridge ready", {
      network: deployment.network,
      chainId: deployment.chainId,
      keeper: wallet.address,
      evidence: String(state.contracts.EvidenceChain?.target ?? ""),
      summons: String(state.contracts.SummonsChain?.target ?? ""),
      bail: String(state.contracts.BailChain?.target ?? ""),
    });
  } catch (error) {
    state.ready = false;
    state.reason = error instanceof Error ? error.message : "chain init failed";
    logger.error("Chain bridge failed to initialise", { reason: state.reason });
  }
}

export const chain = {
  get isReady() {
    return state.ready;
  },
  get reason() {
    return state.reason;
  },
  get keeperAddress() {
    return state.wallet?.address;
  },
  get network() {
    return state.deployment
      ? { name: state.deployment.network, chainId: state.deployment.chainId }
      : null;
  },
  /**
   * The block these contracts were deployed in, and therefore the earliest one
   * that can contain an event of theirs.
   *
   * The indexer needs it: on a public chain, starting a fresh index at genesis
   * means walking eleven million empty blocks to reach the first one that matters.
   */
  get deploymentBlock(): number | null {
    return typeof state.deployment?.blockNumber === "number" ? state.deployment.blockNumber : null;
  },
  get addresses() {
    return {
      EvidenceChain: state.contracts.EvidenceChain?.target?.toString(),
      SummonsChain: state.contracts.SummonsChain?.target?.toString(),
      BailChain: state.contracts.BailChain?.target?.toString(),
    };
  },
  async blockNumber(): Promise<number | null> {
    if (!state.provider) return null;
    try {
      return await state.provider.getBlockNumber();
    } catch {
      return null;
    }
  },
  async keeperBalance(): Promise<string | null> {
    if (!state.provider || !state.wallet) return null;
    try {
      const wei = await state.provider.getBalance(state.wallet.address);
      return wei.toString();
    } catch {
      return null;
    }
  },
};

export function contractFor(name: ContractName): Contract {
  const contract = state.contracts[name];
  if (!state.ready || !contract) throw unavailable(`Blockchain unavailable: ${state.reason}`);
  return contract;
}

export function requireChain(): void {
  if (!state.ready) throw unavailable(`Blockchain unavailable: ${state.reason}`);
}

// -------------------------------------------------------------- GPS encoding

/**
 * Contracts store coordinates as micro-degrees so the EVM never needs a float.
 * Rounding here, once, is what keeps the database value and the on-chain value
 * in agreement.
 */
export function toMicroDegrees(value: number, label: string): bigint {
  if (!Number.isFinite(value)) throw badRequest(`${label} must be a number.`);
  return BigInt(Math.round(value * 1_000_000));
}

export function fromMicroDegrees(value: bigint | string | number): number {
  return Number(BigInt(value)) / 1_000_000;
}

export function assertLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw badRequest("Latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw badRequest("Longitude must be between -180 and 180.");
  }
}

// ------------------------------------------------------------- error decoding

const FRIENDLY_REVERTS: Record<string, string> = {
  // This message is shown when transferCustody ITSELF reverts. A reverted
  // transaction keeps no state, so it must not claim anything was recorded. The
  // mismatch is recorded only by the separate reportIntegrityCheck transaction,
  // which evidence.service sends first and which succeeds on a mismatch.
  HashMismatch:
    "The hash does not match the registered evidence, so the contract refused the transfer. " +
    "A refused transaction records nothing; the mismatch is on chain only through the separate integrity check.",
  StageMismatch: "This item is not at the custody stage you specified.",
  IllegalTransition: "Custody cannot move between those stages.",
  NotAuthorised: "The keeper wallet does not hold the role this action needs.",
  AccessControlUnauthorizedAccount:
    "The signing wallet does not hold the on-chain role this action needs. Grant it with " +
    "`npm run grant:local` (or grant:sepolia) in contracts/, after listing the wallet in contracts/.env.",
  UnknownEvidence: "That evidence id does not exist on chain.",
  FlagAlreadyAnchored: "An anomaly verdict is already anchored for this item and cannot be replaced.",
  ReportAlreadyAnchored: "A forensic report is already anchored for this item.",
  SummonsExpired: "The 72 hour acknowledgement window has closed.",
  SummonsNotPending: "This summons has already been resolved.",
  SummonsNotExpired: "The acknowledgement window is still open.",
  RecipientTokenMismatch: "That Aadhaar token is not the summons recipient.",
  AccusedTokenMismatch: "That Aadhaar token does not match the bail order.",
  BailExpired: "The bail order has expired.",
  BailInactive: "This bail order is closed.",
  BailAlreadyExists: "Bail has already been granted for this case.",
  NotOverdue: "No check-in is overdue for this case.",
  InvalidCoordinates: "Those coordinates are not a valid point on Earth.",
  ExpiryInPast: "The expiry timestamp is already in the past.",
};

/**
 * Pulls raw revert data out of whichever field ethers put it in.
 *
 * A revert seen during eth_estimateGas arrives shaped differently from one seen
 * in a mined receipt, and a custom error inherited from a library (OpenZeppelin's
 * AccessControlUnauthorizedAccount, for instance) frequently reaches us as
 * "unknown custom error" with only the selector. Decoding it ourselves against
 * the three contract interfaces turns that into a name a person can act on.
 */
function revertData(error: any): string | null {
  const candidates = [
    error?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.transaction?.data && error?.revert === null ? undefined : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) {
      return candidate;
    }
  }
  // Last resort: ethers puts the selector in the message for an undecodable error.
  const match = /data="?(0x[0-9a-fA-F]{8,})"?/.exec(String(error?.message ?? ""));
  return match ? match[1] : null;
}

function decodeAgainstContracts(data: string): { name: string; args: string[] } | null {
  for (const name of CONTRACT_NAMES) {
    const contract = state.contracts[name];
    if (!contract) continue;
    try {
      const parsed = (contract.interface as Interface).parseError(data);
      if (parsed) {
        return { name: parsed.name, args: parsed.args.map((a: unknown) => String(a)) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function decodeChainError(error: unknown): AppError {
  const anyError = error as any;
  let revertName: string | undefined = anyError?.revert?.name ?? anyError?.errorName;
  let revertArgs: string[] | undefined = anyError?.revert?.args?.map((a: unknown) => String(a));

  // ethers could not name it, so try the ABIs ourselves.
  if (!revertName) {
    const data = revertData(anyError);
    if (data) {
      const decoded = decodeAgainstContracts(data);
      if (decoded) {
        revertName = decoded.name;
        revertArgs = decoded.args;
      }
    }
  }

  if (revertName && FRIENDLY_REVERTS[revertName]) {
    return new AppError(409, `CHAIN_${revertName.toUpperCase()}`, FRIENDLY_REVERTS[revertName], {
      args: revertArgs,
    });
  }
  if (anyError?.code === "INSUFFICIENT_FUNDS") {
    return unavailable("The keeper wallet is out of ETH. Top it up from a Sepolia faucet.");
  }
  if (anyError?.code === "NETWORK_ERROR" || anyError?.code === "SERVER_ERROR") {
    return unavailable("The RPC endpoint did not respond. Check CHAIN_RPC_URL.");
  }
  if (revertName) {
    return new AppError(409, `CHAIN_${revertName.toUpperCase()}`, `Contract rejected the call: ${revertName}.`);
  }

  logger.error("Unclassified chain error", {
    message: anyError?.message,
    code: anyError?.code,
    data: revertData(anyError),
  });
  return new AppError(502, "CHAIN_ERROR", "The blockchain call failed. See the server log.");
}

// ------------------------------------------- submit queue and nonce ledger

/**
 * The keeper is a relayer: one wallet sending many citizens' transactions. That
 * makes nonce handling the single most failure-prone part of this module, so it
 * is handled explicitly rather than left to the signer.
 *
 * Two mechanisms, and both are needed:
 *
 *   1. A serial queue, so two sends can never be in flight at once. Without it
 *      both would claim the same nonce and one would be dropped silently.
 *
 *   2. An explicit nonce ledger. We read the confirmed count once, pass the
 *      nonce on every send, and increment only after a send is accepted. The
 *      alternative -- letting the signer ask the node each time -- is not
 *      reliable: the count a node reports straight after a send does not always
 *      include it yet, and a signer that caches the answer keeps using a stale
 *      value. Both failure modes produce "nonce too low", and the transaction
 *      vanishes rather than erroring usefully.
 *
 * "latest" rather than "pending" is deliberate. Because sends are serialised and
 * each awaits its receipt, the confirmed count is authoritative and immune to
 * whatever is sitting in a mempool.
 */
let nonceLedger: number | null = null;

function resetNonce(): void {
  nonceLedger = null;
}

async function claimNonce(): Promise<number> {
  if (nonceLedger === null) {
    if (!state.provider || !state.wallet) throw unavailable("Chain bridge is not initialised.");
    nonceLedger = await state.provider.getTransactionCount(state.wallet.address, "latest");
    logger.debug("Nonce ledger synced from chain", { nonce: nonceLedger });
  }
  return nonceLedger;
}

/** Called only after the node has accepted a transaction. */
function commitNonce(): void {
  if (nonceLedger !== null) nonceLedger += 1;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Waits for a receipt by polling for it, with a deadline.
 *
 * Not tx.wait(). ethers' wait() compares the receipt against a cached block
 * number and then waits for the NEXT block to arrive; a local Hardhat node mines
 * only when it receives a transaction, so that next block never comes and the
 * request — and the serial queue behind it — hangs for ever. Polling the receipt
 * directly works the same on every chain, and the deadline means an HTTP request
 * never waits indefinitely for mining: past it, the transaction stays SUBMITTED
 * and the verification tracker follows it from there.
 */
async function waitForReceipt(txHash: string, timeoutMs: number): Promise<TransactionReceipt | null> {
  if (!state.provider) throw unavailable("Chain bridge is not initialised.");
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  for (;;) {
    const receipt = await state.provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    if (Date.now() + delay > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 4000);
  }
}

/** Serialises sends so two transactions can never claim the same nonce. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  // Keep the chain alive after a rejection, but do not swallow the caller's error.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface SubmitResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  receipt: TransactionReceipt;
}

/**
 * Sends a transaction, records it in chain_tx, waits for confirmation and
 * updates the row. The chain_tx table is what lets the admin dashboard show a
 * transaction that is still in flight.
 */
export async function submit(
  name: ContractName,
  method: string,
  args: unknown[],
  meta: {
    submittedBy?: string | null;
    payload?: Record<string, unknown>;
    /**
     * Called the moment the node accepts the transaction, before waiting for a
     * receipt. This is where an anchor becomes SUBMITTED: if the process dies
     * while waiting, the hash is already on record and the tracker can find it.
     */
    onSent?: (txHash: string) => Promise<void> | void;
  } = {}
): Promise<SubmitResult> {
  requireChain();
  const contract = contractFor(name);

  return enqueue(async () => {
    let txHash = "";
    try {
      const nonce = await claimNonce();
      // Every contract method here takes only value arguments, so a trailing
      // overrides object is unambiguous.
      const tx = await (contract as any)[method](...args, { nonce });
      // The node has the transaction, so this nonce is spent whatever happens next.
      commitNonce();
      txHash = tx.hash;

      await db.from("chain_tx").insert({
        tx_hash: tx.hash,
        contract: name,
        method,
        status: "pending",
        submitted_by: meta.submittedBy ?? null,
        payload: meta.payload ?? null,
      });

      if (meta.onSent) await meta.onSent(tx.hash);

      const receipt = await waitForReceipt(tx.hash, env.SUBMIT_WAIT_SECONDS * 1000);
      if (!receipt) {
        // Accepted by the node, not mined yet. Not a failure: the anchor stays
        // SUBMITTED and the tracker confirms it when it lands.
        throw new AppError(
          504,
          "CHAIN_PENDING",
          `The transaction was sent but not mined within ${env.SUBMIT_WAIT_SECONDS} seconds. It is being tracked.`,
          { txHash: tx.hash }
        );
      }

      await db
        .from("chain_tx")
        .update({
          status: receipt.status === 1 ? "confirmed" : "failed",
          block_number: receipt.blockNumber,
          gas_used: receipt.gasUsed.toString(),
          confirmed_at: new Date().toISOString(),
        })
        .eq("tx_hash", tx.hash);

      if (receipt.status !== 1) {
        // A reverted transaction keeps no state. Nothing was recorded by it.
        throw new AppError(502, "CHAIN_REVERTED", "The transaction was mined but reverted; it recorded nothing.", {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
        });
      }

      logger.info("Chain tx confirmed", {
        contract: name,
        method,
        txHash: tx.hash,
        block: receipt.blockNumber,
      });

      return {
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        receipt,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "CHAIN_PENDING") throw error;
      if (txHash) {
        await db
          .from("chain_tx")
          .update({
            status: "failed",
            error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
          })
          .eq("tx_hash", txHash);
      }
      // A refused or dropped send can leave the ledger out of step with the
      // chain, which would wedge every later transaction. Clearing it makes the
      // next send re-read the confirmed count.
      resetNonce();

      if (error instanceof AppError) throw error;
      throw decodeChainError(error);
    }
  });
}

/** Reads a value from a view function, translating reverts into AppErrors. */
export async function read<T>(name: ContractName, method: string, args: unknown[] = []): Promise<T> {
  requireChain();
  const contract = contractFor(name);
  try {
    return (await (contract as any)[method](...args)) as T;
  } catch (error) {
    throw decodeChainError(error);
  }
}

/** Pulls the decoded arguments of the first matching event in a receipt. */
export function eventArgs(
  receipt: TransactionReceipt,
  name: ContractName,
  eventName: string
): Record<string, any> | null {
  const contract = contractFor(name);
  const iface = contract.interface as Interface;
  const fragment = iface.getEvent(eventName);
  if (!fragment) return null;

  for (const log of receipt.logs as Log[]) {
    if (log.address.toLowerCase() !== String(contract.target).toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== eventName) continue;
      const out: Record<string, any> = {};
      parsed.fragment.inputs.forEach((input, index) => {
        out[input.name] = parsed.args[index];
      });
      return out;
    } catch {
      continue;
    }
  }
  return null;
}

/** Block explorer link, so the UI can send a sceptic to Etherscan. */
export function explorerUrl(txHash: string): string | null {
  const chainId = state.deployment?.chainId;
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
  if (chainId === 1) return `https://etherscan.io/tx/${txHash}`;
  return null;
}

/* ------------------------------------------------------ raw reads for tracking */

/**
 * Head block, or null if the RPC cannot answer. Asked of the node directly:
 * provider.getBlockNumber() is cached for a polling interval, and a stale head
 * undercounts confirmations right after a transaction is mined.
 */
export async function headBlock(): Promise<number | null> {
  if (!state.provider) return null;
  try {
    return Number(BigInt(await state.provider.send("eth_blockNumber", [])));
  } catch {
    return null;
  }
}

/** A receipt by hash, or null if there is none (yet). Throws if the RPC fails. */
export async function receiptFor(txHash: string): Promise<TransactionReceipt | null> {
  if (!state.provider) throw unavailable(`Blockchain unavailable: ${state.reason}`);
  return state.provider.getTransactionReceipt(txHash);
}

/** Whether the node knows the transaction at all (mempool or mined). Throws if the RPC fails. */
export async function transactionKnown(txHash: string): Promise<boolean> {
  if (!state.provider) throw unavailable(`Blockchain unavailable: ${state.reason}`);
  return (await state.provider.getTransaction(txHash)) !== null;
}

/** Contract arguments as JSON: bigints become decimal strings. */
export function serialiseArgs(args: unknown[]): unknown[] {
  return args.map((value) => (typeof value === "bigint" ? { $bigint: value.toString() } : value));
}

/** The inverse of serialiseArgs, for a retry that must send exactly the same call. */
export function deserialiseArgs(args: unknown[]): unknown[] {
  return args.map((value) =>
    value && typeof value === "object" && "$bigint" in (value as Record<string, unknown>)
      ? BigInt((value as { $bigint: string }).$bigint)
      : value
  );
}
