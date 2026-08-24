import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { serializeClient } from "@/lib/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatEUR } from "@/lib/money";
import { NewInvoiceButton } from "@/components/modals/create-buttons";

type Props = { params: Promise<{ id: string }> };

export default async function ClientDetailPage({ params }: Props) {
  const { id } = await params;
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      invoices: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!client) notFound();

  const data = serializeClient(client);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            {data.displayName}
          </h1>
          <div className="mt-2 flex gap-2">
            <Badge variant="secondary">{data.type}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/clients/${id}/edit`}>
            <Button variant="outline">Modifier</Button>
          </Link>
          <NewInvoiceButton clientId={id} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coordonnées</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Email : {data.email ?? "—"}</p>
            <p>Téléphone : {data.phone ?? "—"}</p>
            {data.siret && <p>SIRET : {data.siret}</p>}
            <p>
              {[data.addressLine1, data.addressLine2, [data.postalCode, data.city].filter(Boolean).join(" "), data.country]
                .filter(Boolean)
                .join(", ") || "—"}
            </p>
            {data.notes && <p className="text-muted-foreground">{data.notes}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Factures récentes</CardTitle>
          </CardHeader>
          <CardContent>
            {client.invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune facture</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {client.invoices.map((inv) => (
                  <li key={inv.id} className="flex justify-between border-b py-2 last:border-0">
                    <Link href={`/invoices/${inv.id}`} className="text-primary hover:underline">
                      {inv.number ?? "Brouillon"}
                    </Link>
                    <span>
                      {formatEUR(inv.totalCents)} · {inv.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
