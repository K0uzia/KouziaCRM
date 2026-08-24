import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatEUR, centsToEuros } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

type Props = { params: Promise<{ id: string }> };

export default async function InvoiceDetailPage({ params }: Props) {
  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { position: "asc" } },
      client: true,
      payments: { orderBy: { paidAt: "desc" } },
      creditedInvoice: true,
      creditNotes: true,
    },
  });
  if (!invoice) notFound();

  const paid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const remaining = Math.max(0, invoice.totalCents - paid);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/invoices" className="hover:underline">
              Factures
            </Link>
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            {invoice.number ?? "Brouillon"}
          </h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="secondary">
              {invoice.documentType === "CREDIT_NOTE" ? "Avoir" : "Facture"}
            </Badge>
            <Badge>{invoice.status}</Badge>
            <Link href={`/clients/${invoice.clientId}`} className="text-sm text-primary hover:underline">
              {invoice.client.displayName}
            </Link>
          </div>
        </div>
        <InvoiceActions
          invoiceId={invoice.id}
          status={invoice.status}
          documentType={invoice.documentType}
          maxRemainingEuros={centsToEuros(remaining)}
        />
      </div>

      {invoice.creditedInvoice && (
        <p className="text-sm text-muted-foreground">
          Avoir sur facture{" "}
          <Link href={`/invoices/${invoice.creditedInvoice.id}`} className="text-primary hover:underline">
            {invoice.creditedInvoice.number}
          </Link>
        </p>
      )}
      {invoice.creditNotes.map((cn) => (
        <p key={cn.id} className="text-sm text-muted-foreground">
          Annulée par avoir{" "}
          <Link href={`/invoices/${cn.id}`} className="text-primary hover:underline">
            {cn.number}
          </Link>
        </p>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lignes</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2">Description</th>
                <th className="pb-2 text-right">Qté</th>
                <th className="pb-2 text-right">P.U.</th>
                <th className="pb-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-2">{l.description}</td>
                  <td className="py-2 text-right">{Number(l.quantity)}</td>
                  <td className="py-2 text-right">{formatEUR(l.unitPriceCents)}</td>
                  <td className="py-2 text-right">{formatEUR(l.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-right text-lg font-semibold">
            Total TTC : {formatEUR(invoice.totalCents)}
          </p>
          <p className="text-right text-xs text-muted-foreground">
            TVA non applicable, art. 293 B du CGI
          </p>
        </CardContent>
      </Card>

      {invoice.payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paiements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {invoice.payments.map((p) => (
              <div key={p.id} className="flex justify-between border-b py-2 last:border-0">
                <span>
                  {format(p.paidAt, "d MMM yyyy", { locale: fr })} · {p.method}
                  {p.reference ? ` · ${p.reference}` : ""}
                </span>
                <span>{formatEUR(p.amountCents)}</span>
              </div>
            ))}
            <p className="pt-2 text-muted-foreground">
              Payé {formatEUR(paid)} / reste {formatEUR(remaining)}
            </p>
          </CardContent>
        </Card>
      )}

      {(invoice.issueDate || invoice.notes) && (
        <Card>
          <CardContent className="space-y-1 pt-6 text-sm text-muted-foreground">
            {invoice.issueDate && (
              <p>Émise le {format(invoice.issueDate, "d MMMM yyyy", { locale: fr })}</p>
            )}
            {invoice.paymentTerms && <p>Conditions : {invoice.paymentTerms}</p>}
            {invoice.notes && <p>Notes : {invoice.notes}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
