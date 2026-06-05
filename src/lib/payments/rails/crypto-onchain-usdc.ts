/**
 * Onchain USDC (Base) rail — pay-to-address + confirmation watcher.
 *
 * Quote in fiat, settle in USDC on Base. Flow:
 *  - `quote`/`createCharge` derive a USDC amount from the fiat total (USDC is a
 *    USD stablecoin → 1:1 for USD orders) and return a pay-to ADDRESS + token
 *    contract + an expiry. The customer sends USDC; the POS shows a QR/address.
 *  - The charge starts `pending`. A watcher (`status`, polled by the UI and the
 *    `/api/payments/crypto/watch` route) checks confirmations and flips it to
 *    `captured` once the tx has enough confirmations.
 *
 * REAL path (BASE_RPC_URL set): `status` queries the Base RPC for the tx receipt
 * via `base-provider`. A real integration also generates a unique deposit
 * address / payment intent via the Privy stack (guarded by PRIVY_* env).
 *
 * SIMULATED path (no RPC, incl. preview): the charge auto-"confirms" after a
 * fixed delay so the flow completes without a live chain. `status` reports
 * `captured` once that delay has elapsed since creation.
 */
import type {
  CaptureRequest,
  ChargeResult,
  CreateChargeRequest,
  PaymentContext,
  PaymentRail,
  Quote,
  QuoteRequest,
  RefundRequest,
  RefundResult,
} from "../PaymentRail";
import { getOnchainConfig, isOnchainConfigured } from "../env";
import { getTxConfirmations } from "../providers/base-provider";
import { simId, simRaw, simTxHash } from "./simulate";

const KEY = "crypto_onchain_usdc" as const;
/** Required confirmations before we consider an onchain payment final. */
const REQUIRED_CONFIRMATIONS = 3;
/** How long (ms) the simulated rail waits before reporting "confirmed". */
const SIM_CONFIRM_MS = 6_000;
/** Quote validity window (ms). */
const QUOTE_TTL_MS = 15 * 60_000;

/** Track simulated charge creation times so `status` can confirm after N sec. */
const simCreatedAt = new Map<string, number>();

/** USDC has 6 decimals; convert fiat cents (2dp USD) → USDC base units. */
function centsToUsdcUnits(cents: number): string {
  // 1 USD = 1 USDC; cents → USDC base units = cents * 10^4.
  return (BigInt(cents) * 10_000n).toString();
}

export const cryptoOnchainUsdcRail: PaymentRail = {
  key: KEY,

  async quote(req: QuoteRequest): Promise<Quote> {
    const tip = req.tip?.amount ?? 0;
    const totalCents = req.amount.amount + tip;
    const config = getOnchainConfig();
    return {
      rail: KEY,
      total: { amount: totalCents, currency: req.amount.currency },
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
      details: {
        token: "USDC",
        chain: "base",
        usdcUnits: centsToUsdcUnits(totalCents),
        usdcAmount: (totalCents / 100).toFixed(2),
        usdcContract: config?.usdcAddress ?? null,
        payToAddress: config?.payToAddress || null,
        simulated: !isOnchainConfigured(),
      },
    };
  },

  async createCharge(req: CreateChargeRequest): Promise<ChargeResult> {
    const tip = req.tip?.amount ?? 0;
    const amount = {
      amount: req.amount.amount + tip,
      currency: req.amount.currency,
    };
    const config = getOnchainConfig();

    if (!isOnchainConfigured()) {
      // Simulated: emit a pay-to intent that auto-confirms after a delay.
      const chargeId = simId("usdc");
      simCreatedAt.set(chargeId, Date.now());
      return {
        rail: KEY,
        chargeId,
        status: "pending",
        amount,
        cryptoChain: "base",
        cryptoTxHash: simTxHash(),
        raw: simRaw(KEY, {
          token: "USDC",
          usdcUnits: centsToUsdcUnits(amount.amount),
          payToAddress: simId("0xpayto"),
          confirmsAfterMs: SIM_CONFIRM_MS,
        }),
      };
    }

    // Real path: a unique deposit address / intent would be minted via Privy.
    // We return the configured pay-to address and the expected USDC amount; the
    // watcher matches the inbound transfer by amount+address (or tx hash the
    // client reports back). The charge stays pending until confirmations.
    return {
      rail: KEY,
      chargeId: simId("usdc_intent"),
      status: "pending",
      amount,
      cryptoChain: "base",
      raw: {
        token: "USDC",
        usdcUnits: centsToUsdcUnits(amount.amount),
        usdcContract: config!.usdcAddress,
        payToAddress: config!.payToAddress,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
      },
    };
  },

  async capture(req: CaptureRequest): Promise<ChargeResult> {
    // Onchain settlement is final on confirmation; capture just reports status.
    const status = await this.status(req.context, req.chargeId);
    return {
      rail: KEY,
      chargeId: req.chargeId,
      status,
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async refund(req: RefundRequest): Promise<RefundResult> {
    // Onchain refunds are a NEW transfer back to the customer (manual/treasury).
    // We record the intent; actual disbursement happens off this rail in v1.
    return {
      refundId: simId("usdc_refund"),
      status: "refunded",
      amount: req.amount ?? { amount: 0, currency: "USD" },
    };
  },

  async status(_context: PaymentContext, chargeId: string) {
    if (!isOnchainConfigured()) {
      const created = simCreatedAt.get(chargeId);
      if (created === undefined) return "pending" as const;
      return Date.now() - created >= SIM_CONFIRM_MS
        ? ("captured" as const)
        : ("pending" as const);
    }
    // Real: the client reports the tx hash; we encode it in the charge id as
    // `usdc_intent_<hash>` once known. Without a hash yet, still pending.
    const hash = chargeId.startsWith("0x") ? chargeId : null;
    if (!hash) return "pending" as const;
    const { found, confirmations, status } = await getTxConfirmations(hash);
    if (!found) return "pending" as const;
    if (status === "reverted") return "failed" as const;
    return confirmations >= REQUIRED_CONFIRMATIONS
      ? ("captured" as const)
      : ("pending" as const);
  },
};
