/**
 * Gift card / store credit tender (inside the payment screen).
 *
 * Enter or scan the code, optionally an amount (default: as much as the card
 * covers, never more than the balance due), then Apply: the server debits the
 * card and records the tender in one step. The rest of the balance is taken
 * with any other tender (split payment). The tender id is stable until a tender
 * is recorded, so a retry after a lost response never debits twice.
 */
"use client";

import { useRef, useState } from "react";
import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";

function newUuid(): string {
  return crypto.randomUUID();
}

interface CardInfo {
  kind: "gift_card" | "store_credit";
  status: string;
  balance_cents: number;
  code_last4: string;
}

export function GiftCardTender({
  orderId,
  tenantId,
  balanceCents,
  currency,
  onApplied,
}: {
  orderId: string;
  tenantId: string;
  balanceCents: number;
  currency: string;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [card, setCard] = useState<CardInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentId = useRef(newUuid());

  const amountCents = amount.trim() ? Math.round(parseFloat(amount) * 100) : null;

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/gift-cards/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, code }),
      });
      const data = (await res.json()) as { account?: CardInfo; error?: string };
      if (!res.ok || !data.account) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCard(data.account);
    } catch (e) {
      setCard(null);
      setError(e instanceof Error ? e.message : "Could not check the card.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/gift-cards/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          code,
          paymentId: paymentId.current,
          ...(amountCents != null && Number.isFinite(amountCents) ? { amountCents } : {}),
        }),
      });
      const data = (await res.json()) as { account?: CardInfo; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      paymentId.current = newUuid();
      setCard(data.account ?? null);
      setAmount("");
      setCode("");
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the card.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-12 w-full"
        disabled={balanceCents <= 0}
        onClick={() => setOpen(true)}
      >
        <Gift className="mr-2 h-4 w-4" aria-hidden="true" /> Gift card / store credit
      </Button>
    );
  }

  return (
    <div data-testid="gift-card-tender" className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Gift className="h-4 w-4" aria-hidden="true" /> Gift card / store credit
      </div>
      <label className="block text-sm text-muted-foreground" htmlFor="gc-code">
        Code or card number
      </label>
      <input
        id="gc-code"
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setCard(null);
          paymentId.current = newUuid();
        }}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        className="h-12 w-full rounded-md border bg-background px-3 font-mono text-lg uppercase tracking-wider"
      />
      <label className="block text-sm text-muted-foreground" htmlFor="gc-amount">
        Amount (blank = as much as the card covers)
      </label>
      <div className="flex items-center gap-2">
        <span className="text-lg text-muted-foreground">$</span>
        <input
          id="gc-amount"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            paymentId.current = newUuid();
          }}
          placeholder={(balanceCents / 100).toFixed(2)}
          className="h-12 w-full max-w-40 rounded-md border bg-background px-3 text-right text-lg"
        />
      </div>
      {card && (
        <p role="status" className="text-sm">
          {card.kind === "store_credit" ? "Store credit" : "Gift card"} ••••{card.code_last4}:{" "}
          <strong>{formatMoney(card.balance_cents, currency)}</strong>
          {card.status !== "active" && ` (${card.status})`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-12 flex-1" disabled={busy || !code.trim()} onClick={check}>
          Check balance
        </Button>
        <Button
          type="button"
          className="h-12 flex-1"
          disabled={busy || !code.trim() || balanceCents <= 0}
          onClick={apply}
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : "Apply"}
        </Button>
      </div>
    </div>
  );
}
