import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { InvoiceForm } from "@/components/invoices/invoice-form";

type Props = { searchParams: Promise<{ clientId?: string }> };

export default async function NewInvoicePage({ searchParams }: Props) {
  const { clientId } = await searchParams;
  const clients = await prisma.client.findMany({
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true },
  });

  if (clients.length === 0) {
    redirect("/clients/new");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Nouvelle facture</h1>
      <InvoiceForm clients={clients} defaultClientId={clientId} />
    </div>
  );
}
