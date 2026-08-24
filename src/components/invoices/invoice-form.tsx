"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatEUR, eurosToCents } from "@/lib/money";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

type ClientOption = { id: string; displayName: string };

type Line = { description: string; quantity: string; unitPriceEuros: string };

type Props = {
  clients?: ClientOption[];
  defaultClientId?: string;
  variant?: "page" | "modal";
  onSuccess?: (invoice: { id: string }) => void;
  onCancel?: () => void;
};

export function InvoiceForm({
  clients: clientsProp,
  defaultClientId,
  variant = "page",
  onSuccess,
  onCancel,
}: Props) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientOption[]>(clientsProp ?? []);
  const [loadingClients, setLoadingClients] = useState(!clientsProp);
  const [clientId, setClientId] = useState(defaultClientId ?? clientsProp?.[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("Paiement à réception");
  const [lines, setLines] = useState<Line[]>([
    { description: "Prestation de développement", quantity: "1", unitPriceEuros: "0" },
  ]);
  const [loading, setLoading] = useState(false);
  const isModal = variant === "modal";

  useEffect(() => {
    if (clientsProp) {
      setClients(clientsProp);
      if (!clientId && (defaultClientId || clientsProp[0]?.id)) {
        setClientId(defaultClientId ?? clientsProp[0].id);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingClients(true);
      try {
        const res = await fetch("/api/clients");
        if (!res.ok) throw new Error("clients");
        const data = (await res.json()) as ClientOption[];
        if (cancelled) return;
        setClients(data);
        setClientId((prev) => prev || defaultClientId || data[0]?.id || "");
      } catch {
        if (!cancelled) toast.error("Impossible de charger les clients");
      } finally {
        if (!cancelled) setLoadingClients(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsProp, defaultClientId]);

  const totalCents = useMemo(() => {
    return lines.reduce((sum, l) => {
      const q = Number(l.quantity) || 0;
      const p = eurosToCents(l.unitPriceEuros || 0);
      return sum + Math.round(q * p);
    }, 0);
  }, [lines]);

  function updateLine(index: number, key: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [key]: value } : l)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) {
      toast.error("Sélectionnez un client");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        notes,
        paymentTerms,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unitPriceEuros: Number(l.unitPriceEuros),
        })),
      }),
    });
    setLoading(false);
    if (!res.ok) {
      toast.error("Impossible de créer la facture");
      return;
    }
    const invoice = await res.json();
    toast.success("Brouillon créé");
    if (onSuccess) {
      onSuccess(invoice);
      return;
    }
    router.push(`/invoices/${invoice.id}`);
    router.refresh();
  }

  const formBody = (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label>Client</Label>
        <select
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
          disabled={loadingClients}
        >
          {clients.length === 0 ? (
            <option value="">Aucun client</option>
          ) : (
            clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Lignes</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setLines((prev) => [
                ...prev,
                { description: "", quantity: "1", unitPriceEuros: "0" },
              ])
            }
          >
            <Plus className="h-4 w-4" /> Ligne
          </Button>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 md:grid-cols-[1fr_80px_120px_40px]">
            <Input
              placeholder="Description"
              value={line.description}
              onChange={(e) => updateLine(index, "description", e.target.value)}
              required
            />
            <Input
              type="number"
              step="0.001"
              min="0.001"
              value={line.quantity}
              onChange={(e) => updateLine(index, "quantity", e.target.value)}
              required
            />
            <Input
              type="number"
              step="0.01"
              value={line.unitPriceEuros}
              onChange={(e) => updateLine(index, "unitPriceEuros", e.target.value)}
              required
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={lines.length === 1}
              onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <p className="text-right text-sm font-medium">Total : {formatEUR(totalCents)}</p>
      </div>

      <div className="space-y-2">
        <Label>Conditions de paiement</Label>
        <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={loading || clients.length === 0 || loadingClients}>
          {loading ? "Création…" : "Enregistrer le brouillon"}
        </Button>
        {isModal ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Annuler
          </Button>
        ) : null}
      </div>
    </form>
  );

  if (isModal) return formBody;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-[family-name:var(--font-display)] text-xl">
          Nouvelle facture
        </CardTitle>
      </CardHeader>
      <CardContent>{formBody}</CardContent>
    </Card>
  );
}
