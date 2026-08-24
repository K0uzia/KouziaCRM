"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Props = {
  invoiceId: string;
  status: string;
  documentType: string;
  maxRemainingEuros?: number;
};

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `Erreur ${res.status}`;
  } catch {
    return `Erreur ${res.status}`;
  }
}

export function InvoiceActions({ invoiceId, status, documentType, maxRemainingEuros }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(maxRemainingEuros ?? ""));

  async function issue() {
    setLoading("issue");
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/issue`, { method: "POST" });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Facture émise");
      router.refresh();
    } catch {
      toast.error("Connexion interrompue — vérifiez que npm run dev tourne, puis réessayez");
    } finally {
      setLoading(null);
    }
  }

  async function cancel() {
    if (!confirm("Créer un avoir et annuler cette facture ? Cette action est définitive.")) return;
    setLoading("cancel");
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/cancel`, { method: "POST" });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const credit = await res.json();
      toast.success(`Avoir ${credit.number} créé`);
      router.push(`/invoices/${credit.id}`);
      router.refresh();
    } catch {
      toast.error("Connexion interrompue — réessayez");
    } finally {
      setLoading(null);
    }
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setLoading("pay");
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountEuros: Number(amount) }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Paiement enregistré");
      router.refresh();
    } catch {
      toast.error("Connexion interrompue — réessayez");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      {status === "DRAFT" && (
        <Button onClick={issue} disabled={!!loading}>
          {loading === "issue" ? "Émission…" : "Émettre la facture"}
        </Button>
      )}
      {(status === "ISSUED" || status === "PAID") && documentType === "INVOICE" && (
        <Button variant="destructive" onClick={cancel} disabled={!!loading}>
          {loading === "cancel" ? "…" : "Annuler via avoir"}
        </Button>
      )}
      {status !== "DRAFT" && (
        <a href={`/api/invoices/${invoiceId}/pdf`} target="_blank" rel="noreferrer">
          <Button type="button" variant="outline">
            Télécharger PDF
          </Button>
        </a>
      )}
      {status === "ISSUED" && documentType === "INVOICE" && (
        <form onSubmit={pay} className="flex items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Paiement (€)</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-32"
              required
            />
          </div>
          <Button type="submit" disabled={!!loading}>
            {loading === "pay" ? "…" : "Encaisser"}
          </Button>
        </form>
      )}
    </div>
  );
}
