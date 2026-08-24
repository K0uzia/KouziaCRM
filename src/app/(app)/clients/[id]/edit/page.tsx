import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { serializeClient } from "@/lib/clients";
import { ClientForm } from "@/components/clients/client-form";

type Props = { params: Promise<{ id: string }> };

export default async function EditClientPage({ params }: Props) {
  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) notFound();
  const data = serializeClient(client);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Modifier le client</h1>
      <ClientForm
        mode="edit"
        clientId={id}
        initial={{
          type: data.type,
          firstName: data.firstName,
          lastName: data.lastName,
          companyName: data.companyName,
          email: data.email,
          phone: data.phone,
          siret: data.siret,
          addressLine1: data.addressLine1,
          addressLine2: data.addressLine2,
          postalCode: data.postalCode,
          city: data.city,
          country: data.country,
          notes: data.notes,
        }}
      />
    </div>
  );
}
