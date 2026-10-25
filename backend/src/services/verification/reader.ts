import { chain, read } from "../../lib/chain";
import { keccakOfString } from "../../lib/crypto";

/**
 * Reads EvidenceChain directly, for anything that must not trust Postgres: the
 * public Integrity Passport, the independent verification, the court bundle.
 * Injectable so the tests can run against the simulated chain.
 */

export interface ChainEvidence {
  caseId: string;
  fileHash: string;
  /** Block timestamp of the registration, seconds. */
  collectedAt: number;
  currentStage: string;
  mismatchCount: number;
  forensicReportHash: string;
  anomalyFlagHash: string;
  /** Micro-degrees; (0, 0) when coordinates were kept off chain. Internal only. */
  gpsLatE6: number;
  gpsLngE6: number;
  registrar: string;
}

export interface ChainCustodyEvent {
  fromStage: string | null;
  toStage: string;
  confirmedHash: string;
  timestamp: number;
}

export interface ChainReader {
  ready(): boolean;
  evidence(chainId: number): Promise<ChainEvidence>;
  custody(chainId: number): Promise<ChainCustodyEvent[]>;
}

const STAGE_BY_TAG = new Map(
  ["SCENE", "FORENSIC_LAB", "PROSECUTOR", "COURT"].map((stage) => [keccakOfString(stage).toLowerCase(), stage])
);
const ZERO = "0x" + "00".repeat(32);

export function stageFromTag(tag: string): string | null {
  const lower = String(tag).toLowerCase();
  if (lower === ZERO) return null;
  return STAGE_BY_TAG.get(lower) ?? lower;
}

const ethersReader: ChainReader = {
  ready: () => chain.isReady,
  async evidence(chainId) {
    const e = (await read<any>("EvidenceChain", "getEvidence", [chainId])) as any;
    return {
      caseId: String(e.caseId).toLowerCase(),
      fileHash: String(e.fileHash).toLowerCase(),
      collectedAt: Number(e.collectedAt),
      currentStage: stageFromTag(e.currentStage) ?? "UNKNOWN",
      mismatchCount: Number(e.mismatchCount),
      forensicReportHash: String(e.forensicReportHash).toLowerCase(),
      anomalyFlagHash: String(e.anomalyFlagHash).toLowerCase(),
      gpsLatE6: Number(e.gpsLat),
      gpsLngE6: Number(e.gpsLng),
      registrar: String(e.registrar),
    };
  },
  async custody(chainId) {
    const events = (await read<any[]>("EvidenceChain", "getChainOfCustody", [chainId])) as any[];
    return events.map((e) => ({
      fromStage: stageFromTag(e.fromRole),
      toStage: stageFromTag(e.toRole) ?? "UNKNOWN",
      confirmedHash: String(e.confirmedHash).toLowerCase(),
      timestamp: Number(e.timestamp),
    }));
  },
};

let current: ChainReader = ethersReader;

export function chainReader(): ChainReader {
  return current;
}

/** Test hook: swap the reader. Pass null to restore the real chain. */
export function setChainReader(reader: ChainReader | null): void {
  current = reader ?? ethersReader;
}
