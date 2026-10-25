import { randomBytes } from "crypto";
import { AppError } from "../../src/lib/errors";
import { setVerificationDeps, type Sender } from "../../src/services/verification/anchors";
import type { ChainProbe, ReceiptView } from "../../src/services/verification/probe";
import { setChainReader } from "../../src/services/verification/reader";

/**
 * A simulated EvidenceChain for tests: its own registry of digests (so it can
 * disagree with a tampered database), mined receipts carrying real event shapes,
 * and switches for every way a real chain fails.
 */

const hex32 = () => "0x" + randomBytes(32).toString("hex");

type Failure = "rpc-down" | "revert" | "reject" | "pending" | null;

interface Record_ {
  caseId: string;
  fileHash: string;
  stage: string;
  mismatchCount: number;
  custody: { fromRole: string; toRole: string; confirmedHash: string; timestamp: number }[];
  registeredAt: number;
  gpsLatE6: number;
  gpsLngE6: number;
}

const NEXT: Record<string, string> = { SCENE: "FORENSIC_LAB", FORENSIC_LAB: "PROSECUTOR", PROSECUTOR: "COURT" };

export class FakeChain {
  head = 100;
  ready = true;
  /** The next send fails this way, then the switch resets. */
  nextSend: Failure = null;
  /** Every receipt lookup fails (an RPC outage seen by the tracker). */
  rpcDown = false;
  /** Sends that reach the node but never get mined. */
  holdReceipts = false;
  readonly receipts = new Map<string, ReceiptView>();
  readonly known = new Set<string>();
  readonly sent: { method: string; args: unknown[]; txHash: string }[] = [];
  readonly registry = new Map<number, Record_>();
  private nextEvidenceId = 1;

  install(): this {
    const sender: Sender = async (_contract, method, args, meta) => this.send(method, args, meta.onSent);
    const probe: ChainProbe = {
      head: async () => {
        if (this.rpcDown) throw new Error("RPC down");
        return this.head;
      },
      receipt: async (hash) => {
        if (this.rpcDown) throw new Error("RPC down");
        return this.receipts.get(hash) ?? null;
      },
      txKnown: async (hash) => {
        if (this.rpcDown) throw new Error("RPC down");
        return this.known.has(hash);
      },
      events: (receipt, _contract, names) => (receipt.events ?? []).filter((e) => names.includes(e.name)),
    };
    setVerificationDeps({ sender, probe, ready: () => this.ready });
    setChainReader({
      ready: () => this.ready && !this.rpcDown,
      evidence: async (id) => {
        if (this.rpcDown) throw new Error("RPC down");
        const r = this.registry.get(id);
        if (!r) throw new Error(`UnknownEvidence(${id})`);
        return {
          caseId: r.caseId,
          fileHash: r.fileHash,
          collectedAt: r.registeredAt,
          currentStage: r.stage,
          mismatchCount: r.mismatchCount,
          forensicReportHash: "0x" + "00".repeat(32),
          anomalyFlagHash: "0x" + "00".repeat(32),
          gpsLatE6: r.gpsLatE6,
          gpsLngE6: r.gpsLngE6,
          registrar: "0x" + "11".repeat(20),
        };
      },
      custody: async (id) => {
        if (this.rpcDown) throw new Error("RPC down");
        const r = this.registry.get(id);
        if (!r) throw new Error(`UnknownEvidence(${id})`);
        return r.custody.map((c, i) => ({
          fromStage: i === 0 ? null : c.fromRole,
          toStage: c.toRole,
          confirmedHash: c.confirmedHash,
          timestamp: c.timestamp,
        }));
      },
    });
    return this;
  }

  uninstall(): void {
    setVerificationDeps(null);
    setChainReader(null);
  }

  /** Mines n empty blocks. */
  mine(n = 1): void {
    this.head += n;
  }

  /** Rewrites the chain's stored digest, for tests of a record that disagrees with the chain. */
  setDigest(id: number, digest: string): void {
    const r = this.registry.get(id);
    if (r) r.fileHash = digest.toLowerCase();
  }

  /** Moves a mined transaction into a different block, as a reorg would. */
  reorg(txHash: string): void {
    const receipt = this.receipts.get(txHash);
    if (!receipt) return;
    this.receipts.set(txHash, { ...receipt, blockHash: hex32(), blockNumber: receipt.blockNumber + 1 });
  }

  /** Forgets a transaction entirely, as a node does with a dropped one. */
  drop(txHash: string): void {
    this.receipts.delete(txHash);
    this.known.delete(txHash);
  }

  private async send(method: string, args: unknown[], onSent: (hash: string) => Promise<void>) {
    const failure = this.nextSend;
    this.nextSend = null;

    if (failure === "rpc-down") throw new AppError(503, "UNAVAILABLE", "The RPC endpoint did not respond. Check CHAIN_RPC_URL.");
    if (failure === "reject") throw new AppError(409, "CHAIN_UNKNOWNEVIDENCE", "That evidence id does not exist on chain.");

    const txHash = hex32();
    this.known.add(txHash);
    this.sent.push({ method, args, txHash });
    await onSent(txHash);

    this.head += 1;
    const blockNumber = this.head;
    const blockHash = hex32();

    if (failure === "pending") {
      // Accepted by the node, not mined within the request's wait.
      throw new AppError(504, "CHAIN_PENDING", "The transaction was sent but not mined in time. It is being tracked.", { txHash });
    }

    if (failure === "revert") {
      const receipt: ReceiptView = { status: 0, blockNumber, blockHash, events: [] };
      this.receipts.set(txHash, receipt);
      throw new AppError(502, "CHAIN_REVERTED", "The transaction was mined but reverted; it recorded nothing.", { txHash });
    }

    const events = this.execute(method, args);
    const receipt: ReceiptView = { status: 1, blockNumber, blockHash, events };
    if (!this.holdReceipts) this.receipts.set(txHash, receipt);
    return { txHash, receipt };
  }

  /** What EvidenceChain would do with this call. */
  private execute(method: string, args: unknown[]): { name: string; args: Record<string, unknown> }[] {
    const now = Math.floor(Date.now() / 1000);
    switch (method) {
      case "registerEvidence": {
        const [caseId, fileHash, lat, lng] = args as [string, string, bigint, bigint];
        const id = this.nextEvidenceId++;
        this.registry.set(id, {
          caseId,
          fileHash: fileHash.toLowerCase(),
          stage: "SCENE",
          mismatchCount: 0,
          custody: [{ fromRole: "0x" + "00".repeat(32), toRole: "SCENE", confirmedHash: fileHash, timestamp: now }],
          registeredAt: now,
          gpsLatE6: Number(lat ?? 0),
          gpsLngE6: Number(lng ?? 0),
        });
        return [{ name: "EvidenceRegistered", args: { evidenceId: String(id), caseId, fileHash: fileHash.toLowerCase() } }];
      }
      case "reportIntegrityCheck": {
        const [id, checkHash] = args as [number, string];
        const record = this.registry.get(Number(id));
        if (!record) return [];
        if (record.fileHash === String(checkHash).toLowerCase()) {
          return [{ name: "IntegrityVerified", args: { evidenceId: String(id), checkHash: String(checkHash).toLowerCase() } }];
        }
        record.mismatchCount++;
        return [
          {
            name: "IntegrityMismatch",
            args: { evidenceId: String(id), expectedHash: record.fileHash, submittedHash: String(checkHash).toLowerCase() },
          },
        ];
      }
      case "transferCustody": {
        const [id, , , confirmedHash] = args as [number, string, string, string];
        const record = this.registry.get(Number(id));
        if (!record) return [];
        const to = NEXT[record.stage] ?? record.stage;
        record.custody.push({ fromRole: record.stage, toRole: to, confirmedHash, timestamp: now });
        record.stage = to;
        return [{ name: "CustodyTransferred", args: { evidenceId: String(id), confirmedHash: String(confirmedHash).toLowerCase() } }];
      }
      case "anchorAnomalyFlag": {
        const [id, flagHash] = args as [number, string];
        return [{ name: "AnomalyFlagAnchored", args: { evidenceId: String(id), flagHash: String(flagHash).toLowerCase() } }];
      }
      case "anchorForensicResult": {
        const [id, reportHash] = args as [number, string];
        return [{ name: "ForensicResultAnchored", args: { evidenceId: String(id), reportHash: String(reportHash).toLowerCase() } }];
      }
      default:
        return [];
    }
  }
}
