/**
 * Thin Base (EVM) JSON-RPC provider wrapper (Phase 2).
 *
 * Only constructed when BASE_RPC_URL is configured. Used by the onchain USDC
 * rail's confirmation watcher to check whether a payment transaction has the
 * required number of confirmations. We use raw JSON-RPC over `fetch` so there
 * is no web3 dependency in the bundle; a richer Privy/viem client can replace
 * this wrapper behind the same surface later without touching the rail.
 */
import { getOnchainConfig } from "../env";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const config = getOnchainConfig();
  if (!config) throw new Error("Onchain (Base) RPC is not configured.");
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Base RPC error: ${json.error.message}`);
  return json.result as T;
}

/** Current block height. */
export async function getBlockNumber(): Promise<number> {
  const hex = await rpc<string>("eth_blockNumber", []);
  return Number.parseInt(hex, 16);
}

export interface TxReceipt {
  blockNumber: number | null;
  status: "success" | "reverted" | "pending";
}

/** Fetch a transaction receipt and derive confirmation count. */
export async function getTxConfirmations(txHash: string): Promise<{
  found: boolean;
  confirmations: number;
  status: TxReceipt["status"];
}> {
  const receipt = await rpc<{
    blockNumber: string | null;
    status: string | null;
  } | null>("eth_getTransactionReceipt", [txHash]);

  if (!receipt || receipt.blockNumber === null) {
    return { found: false, confirmations: 0, status: "pending" };
  }
  const txBlock = Number.parseInt(receipt.blockNumber, 16);
  const head = await getBlockNumber();
  const confirmations = Math.max(0, head - txBlock + 1);
  const status = receipt.status === "0x1" ? "success" : "reverted";
  return { found: true, confirmations, status };
}
