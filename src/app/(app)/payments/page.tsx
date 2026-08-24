import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatEUR } from "@/lib/money";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

export default async function PaymentsPage() {
  const payments = await prisma.payment.findMany({
    orderBy: { paidAt: "desc" },
    include: {
      invoice: {
        select: {
          id: true,
          number: true,
          client: { select: { displayName: true } },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Paiements</h1>
        <p className="text-muted-foreground">Encaissements liés aux factures</p>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Facture</th>
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Méthode</th>
              <th className="px-4 py-3 font-medium text-right">Montant</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  Aucun paiement enregistré
                </td>
              </tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-4 py-3">{format(p.paidAt, "d MMM yyyy", { locale: fr })}</td>
                <td className="px-4 py-3">
                  <Link href={`/invoices/${p.invoice.id}`} className="text-primary hover:underline">
                    {p.invoice.number ?? p.invoice.id}
                  </Link>
                </td>
                <td className="px-4 py-3">{p.invoice.client.displayName}</td>
                <td className="px-4 py-3">{p.method}</td>
                <td className="px-4 py-3 text-right">{formatEUR(p.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
