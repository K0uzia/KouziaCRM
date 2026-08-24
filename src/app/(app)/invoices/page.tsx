import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { formatEUR } from "@/lib/money";
import { NewInvoiceButton } from "@/components/modals/create-buttons";

function statusVariant(status: string) {
  switch (status) {
    case "PAID":
      return "success" as const;
    case "ISSUED":
      return "warning" as const;
    case "CANCELLED":
      return "destructive" as const;
    default:
      return "secondary" as const;
  }
}

function statusLabel(status: string, documentType: string) {
  if (documentType === "CREDIT_NOTE") return `Avoir · ${status}`;
  const map: Record<string, string> = {
    DRAFT: "Brouillon",
    ISSUED: "Émise",
    PAID: "Payée",
    CANCELLED: "Annulée",
  };
  return map[status] ?? status;
}

export default async function InvoicesPage() {
  const invoices = await prisma.invoice.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: { client: { select: { displayName: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Factures</h1>
          <p className="text-muted-foreground">Numérotation séquentielle — suppression interdite</p>
        </div>
        <NewInvoiceButton />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">N°</th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Statut</th>
              <th className="px-4 py-3 font-medium text-right">Montant</th>
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  Aucune facture
                </td>
              </tr>
            )}
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-t hover:bg-muted/30">
                <td className="px-4 py-3">
                  <Link href={`/invoices/${inv.id}`} className="font-medium text-primary hover:underline">
                    {inv.number ?? "Brouillon"}
                  </Link>
                </td>
                <td className="px-4 py-3">{inv.client.displayName}</td>
                <td className="px-4 py-3">
                  <Badge variant={statusVariant(inv.status)}>
                    {statusLabel(inv.status, inv.documentType)}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">{formatEUR(inv.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
