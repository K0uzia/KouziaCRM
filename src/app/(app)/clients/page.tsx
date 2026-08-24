import Link from "next/link";
import { listClients } from "@/lib/clients";
import { Badge } from "@/components/ui/badge";
import { NewClientButton } from "@/components/modals/create-buttons";

export default async function ClientsPage() {
  const clients = await listClients();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Clients</h1>
          <p className="text-muted-foreground">CRM — particuliers et professionnels</p>
        </div>
        <NewClientButton />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Nom</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Ville</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  Aucun client — créez votre premier contact.
                </td>
              </tr>
            )}
            {clients.map((c) => (
              <tr key={c.id} className="border-t hover:bg-muted/30">
                <td className="px-4 py-3">
                  <Link href={`/clients/${c.id}`} className="font-medium text-primary hover:underline">
                    {c.displayName}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="secondary">{c.type}</Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.city ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
