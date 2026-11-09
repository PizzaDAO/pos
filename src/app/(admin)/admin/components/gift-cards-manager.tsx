/**
 * Back office: gift cards + store credit. Lists every card (last 4 only, codes
 * are never stored), the outstanding liability, each card's append-only
 * ledger, and the manager actions: void an UNREDEEMED card (its sale is
 * refunded) and refund a paid reload. The server enforces every rule.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import type { LedgerEntry, StoredValueAccount } from "@/lib/giftcards/types";

const KIND_LABEL = { gift_card: "Gift card", store_credit: "Store credit" } as const;
const ENTRY_LABEL: Record<LedgerEntry["kind"], string> = {
  issue: "Issued",
  load: "Reloaded",
  refund: "Refund returned",
  redeem: "Redeemed",
  reverse: "Reload refunded",
  void: "Voided",
};

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function GiftCardsManager({ tenantId }: { tenantId: string }) {
  const [accounts, setAccounts] = useState<StoredValueAccount[]>([]);
  const [outstanding, setOutstanding] = useState(0);
  const [selected, setSelected] = useState<StoredValueAccount | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerOk, setLedgerOk] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/gift-cards?tenantId=${encodeURIComponent(tenantId)}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as {
      accounts?: StoredValueAccount[];
      outstandingCents?: number;
      error?: string;
    };
    if (!res.ok) {
      setError(data.error ?? `HTTP ${res.status}`);
      return;
    }
    setAccounts(data.accounts ?? []);
    setOutstanding(data.outstandingCents ?? 0);
  }, [tenantId]);

  const open = useCallback(
    async (a: StoredValueAccount) => {
      setSelected(a);
      const res = await fetch(`/api/gift-cards/${a.id}?tenantId=${encodeURIComponent(tenantId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        account?: StoredValueAccount;
        ledger?: LedgerEntry[];
        ledgerOk?: boolean;
      };
      if (data.account) setSelected(data.account);
      setLedger(data.ledger ?? []);
      setLedgerOk(data.ledgerOk !== false);
    },
    [tenantId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      if (selected) await open(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  function voidCard(a: StoredValueAccount) {
    const reason = window.prompt(`Void ${KIND_LABEL[a.kind].toLowerCase()} ••••${a.code_last4}? Reason:`);
    if (!reason?.trim()) return;
    void act(() => post(`/api/gift-cards/${a.id}/void`, { tenantId, reason }));
  }

  function reverse(entry: LedgerEntry) {
    if (!entry.order_id) return;
    const reason = window.prompt("Refund this reload? Reason:");
    if (!reason?.trim()) return;
    void act(() => post(`/api/gift-cards/reloads/${entry.order_id}/reverse`, { tenantId, reason }));
  }

  const reversed = new Set(ledger.filter((e) => e.kind === "reverse").map((e) => e.order_id));
  const redeemed = ledger.some((e) => e.kind !== "issue" && e.kind !== "load");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5" />
          <h2 className="text-base font-semibold">Gift cards &amp; store credit</h2>
        </div>
        <div className="text-sm">
          Outstanding liability: <strong>{formatMoney(outstanding)}</strong>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Card</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Balance</th>
                <th className="p-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-3 text-muted-foreground">
                    No gift cards yet.
                  </td>
                </tr>
              )}
              {accounts.map((a) => (
                <tr
                  key={a.id}
                  className={`cursor-pointer border-t hover:bg-muted/40 ${selected?.id === a.id ? "bg-muted/60" : ""}`}
                  onClick={() => void open(a)}
                >
                  <td className="p-2">
                    {KIND_LABEL[a.kind]} ••••{a.code_last4}
                    {a.physical && <span className="ml-1 text-xs text-muted-foreground">(physical)</span>}
                  </td>
                  <td className="p-2">{a.status}</td>
                  <td className="p-2 text-right tabular-nums">{formatMoney(a.balance_cents, a.currency)}</td>
                  <td className="p-2 text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {KIND_LABEL[selected.kind]} ••••{selected.code_last4} ·{" "}
                {formatMoney(selected.balance_cents, selected.currency)}
              </h3>
              {selected.status !== "voided" && !redeemed && (
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => voidCard(selected)}>
                  {selected.kind === "gift_card" && selected.status === "active" ? "Void & refund sale" : "Void"}
                </Button>
              )}
            </div>
            {!ledgerOk && (
              <p role="alert" className="text-sm text-destructive">
                Ledger check failed: the cached balance does not match the ledger.
              </p>
            )}
            <ul className="space-y-1 text-sm">
              {ledger.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-1">
                  <span>
                    {ENTRY_LABEL[e.kind]}
                    {e.reason && <span className="text-muted-foreground"> · {e.reason}</span>}
                    <span className="block text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
                  </span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {e.amount_cents > 0 ? "+" : ""}
                    {formatMoney(e.amount_cents, selected.currency)} → {formatMoney(e.balance_after_cents, selected.currency)}
                    {e.kind === "load" && e.order_id && !reversed.has(e.order_id) && selected.status === "active" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => reverse(e)}>
                        Refund reload
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
