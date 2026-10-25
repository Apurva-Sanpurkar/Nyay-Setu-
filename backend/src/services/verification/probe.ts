import type { Interface, Log, TransactionReceipt } from "ethers";
import { chain, contractFor, headBlock, receiptFor, transactionKnown, type ContractName } from "../../lib/chain";

/**
 * The tracker's view of the chain. An interface so tests can inject every
 * failure mode — RPC down, reverted, dropped, reorged — without a node, and so
 * the production implementation is three thin calls to ethers.
 */

export interface ReceiptView {
  status: 0 | 1;
  blockNumber: number;
  blockHash: string;
  /** The raw receipt, for event decoding. Tests may leave it undefined and supply `events`. */
  raw?: TransactionReceipt;
  /** Pre-decoded events, used by test probes. */
  events?: { name: string; args: Record<string, unknown> }[];
}

export interface ChainProbe {
  /** Head block. Throws when the RPC is unreachable. */
  head(): Promise<number>;
  /** Receipt, or null if none. Throws when the RPC is unreachable. */
  receipt(txHash: string): Promise<ReceiptView | null>;
  /** Whether the node knows the transaction. Throws when the RPC is unreachable. */
  txKnown(txHash: string): Promise<boolean>;
  /** Events of the given names emitted by the given contract in this receipt. */
  events(receipt: ReceiptView, contract: ContractName, names: string[]): { name: string; args: Record<string, unknown> }[];
}

export function toReceiptView(receipt: TransactionReceipt): ReceiptView {
  return {
    status: receipt.status === 1 ? 1 : 0,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    raw: receipt,
  };
}

function decodeEvents(receipt: TransactionReceipt, contractName: ContractName, names: string[]) {
  const contract = contractFor(contractName);
  const iface = contract.interface as Interface;
  const target = String(contract.target).toLowerCase();
  const out: { name: string; args: Record<string, unknown> }[] = [];

  for (const log of receipt.logs as Log[]) {
    if (log.address.toLowerCase() !== target) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || !names.includes(parsed.name)) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, index) => {
        const value = parsed.args[index];
        args[input.name] = typeof value === "bigint" ? value.toString() : value;
      });
      out.push({ name: parsed.name, args });
    } catch {
      continue;
    }
  }
  return out;
}

/** The real chain, through the keeper's provider. */
export const ethersProbe: ChainProbe = {
  async head() {
    const head = await headBlock();
    if (head === null) throw new Error(`RPC unavailable: ${chain.reason}`);
    return head;
  },
  async receipt(txHash) {
    const receipt = await receiptFor(txHash);
    return receipt ? toReceiptView(receipt) : null;
  },
  async txKnown(txHash) {
    return transactionKnown(txHash);
  },
  events(receipt, contract, names) {
    if (receipt.events) return receipt.events.filter((e) => names.includes(e.name));
    if (!receipt.raw) return [];
    return decodeEvents(receipt.raw, contract, names);
  },
};
