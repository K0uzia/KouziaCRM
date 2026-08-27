import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faPlay, faPause, faStop } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, PageHeader, Badge } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";

type SubscriptionStatus = "ACTIVE" | "PAUSED" | "ENDED";

type Subscription = {
  id: string;
  label: string;
  amountCents: number;
  billingDay: number;
  startDate: string;
  endDate: string | null;
  status: SubscriptionStatus;
  nextInvoiceAt: string;
  client: { id: string; displayName: string; clientNumber: string | null };
  service: { id: string; name: string };
};

type Client = { id: string; displayName: string };
type Service = { id: string; name: string };

const statusBadge: Record<SubscriptionStatus, { tone: "green" | "amber" | "neutral"; label: string }> = {
  ACTIVE: { tone: "green", label: "Actif" },
  PAUSED: { tone: "amber", label: "Suspendu" },
  ENDED: { tone: "neutral", label: "Clôturé" },
};

const emptyForm = {
  clientId: "",
  serviceId: "",
  label: "",
  amountEuros: "",
  billingDay: "1",
  startDate: new Date().toISOString().slice(0, 10),
};

export function SubscriptionsPage() {
  const [rows, setRows] = useState<Subscription[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);

  async function load() {
    const [subs, cls, svcs] = await Promise.all([
      api<Subscription[]>("/api/subscriptions"),
      api<Client[]>("/api/clients").catch(() => [] as Client[]),
      api<Service[]>("/api/services?active=1").catch(() => [] as Service[]),
    ]);
    setRows(subs);
    setClients(cls);
    setServices(svcs);
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  function openCreate() {
    setForm({
      ...emptyForm,
      clientId: clients[0]?.id ?? "",
      serviceId: services[0]?.id ?? "",
    });
    setOpen(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          clientId: form.clientId,
          serviceId: form.serviceId,
          label: form.label,
          amountEuros: Number(form.amountEuros),
          billingDay: Number(form.billingDay),
          startDate: form.startDate,
        }),
      });
      toast.success("Abonnement créé");
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, kind: "pause" | "resume" | "end") {
    try {
      await api(`/api/subscriptions/${id}/${kind}`, { method: "POST" });
      toast.success(
        kind === "pause" ? "Abonnement suspendu" : kind === "resume" ? "Abonnement repris" : "Abonnement clôturé",
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  return (
    <div>
      <PageHeader
        title="Abonnements"
        subtitle="Contrats de maintenance mensuels récurrents"
        actions={
          <Button onClick={openCreate}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            Nouvel abonnement
          </Button>
        }
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="Aucun abonnement"
            hint="Créez un contrat de maintenance mensuel : une facture sera émise automatiquement chaque mois."
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg)]/80 text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Libellé</th>
                <th className="px-4 py-3 text-right font-medium">Montant/mois</th>
                <th className="px-4 py-3 font-medium">Jour</th>
                <th className="px-4 py-3 font-medium">Prochaine facture</th>
                <th className="px-4 py-3 font-medium">Statut</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const badge = statusBadge[s.status];
                return (
                  <tr key={s.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3">
                      <p className="font-medium">{s.client.displayName}</p>
                      <p className="text-xs text-[var(--muted)]">{s.service.name}</p>
                    </td>
                    <td className="px-4 py-3">{s.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {formatEUR(s.amountCents)}
                    </td>
                    <td className="px-4 py-3">{s.billingDay}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {formatDate(s.nextInvoiceAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {s.status === "ACTIVE" ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => void action(s.id, "pause")}
                            title="Suspendre"
                          >
                            <FontAwesomeIcon icon={faPause} className="h-3 w-3" />
                          </Button>
                        ) : null}
                        {s.status === "PAUSED" ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => void action(s.id, "resume")}
                            title="Reprendre"
                          >
                            <FontAwesomeIcon icon={faPlay} className="h-3 w-3" />
                          </Button>
                        ) : null}
                        {s.status !== "ENDED" ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => void action(s.id, "end")}
                            title="Clôturer"
                          >
                            <FontAwesomeIcon icon={faStop} className="h-3 w-3" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Nouvel abonnement mensuel">
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Client">
            <Select
              required
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            >
              <option value="">-</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prestation">
            <Select
              required
              value={form.serviceId}
              onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
            >
              <option value="">-</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Libellé de la facture">
            <Input
              required
              placeholder="Maintenance site web : mensuel"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Montant/mois (€)">
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={form.amountEuros}
                onChange={(e) => setForm({ ...form, amountEuros: e.target.value })}
              />
            </Field>
            <Field label="Jour de prélèvement">
              <Select
                value={form.billingDay}
                onChange={(e) => setForm({ ...form, billingDay: e.target.value })}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date de début">
              <Input
                required
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </Field>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Une facture sera émise automatiquement chaque mois à cette date (numéro légal alloué,
            snapshot client figé). Si SMTP est configuré, le PDF sera envoyé au client.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "…" : "Créer"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
