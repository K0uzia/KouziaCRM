import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faPlay, faPause, faStop, faPen, faSync } from "@fortawesome/free-solid-svg-icons";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseId, setReviseId] = useState<string | null>(null);
  const [reviseAmount, setReviseAmount] = useState("");
  const [reviseLabel, setReviseLabel] = useState("");
  const [reviseBusy, setReviseBusy] = useState(false);

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
    setEditingId(null);
    setForm({
      ...emptyForm,
      clientId: clients[0]?.id ?? "",
      serviceId: services[0]?.id ?? "",
    });
    setOpen(true);
  }

  function openEdit(s: Subscription) {
    setEditingId(s.id);
    setForm({
      clientId: s.client.id,
      serviceId: s.service.id,
      label: s.label,
      amountEuros: (s.amountCents / 100).toString(),
      billingDay: String(s.billingDay),
      startDate: s.startDate.slice(0, 10),
    });
    setOpen(true);
  }

  function openRevise(s: Subscription) {
    setReviseId(s.id);
    setReviseAmount((s.amountCents / 100).toString());
    setReviseLabel(s.label);
    setReviseOpen(true);
  }

  async function onReviseSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reviseId) return;
    setReviseBusy(true);
    try {
      const res = await api<{ quoteNumber: string | null; emailed: boolean }>(
        `/api/subscriptions/${reviseId}/revise`,
        {
          method: "POST",
          body: JSON.stringify({
            amountEuros: Number(reviseAmount),
            label: reviseLabel.trim() || undefined,
          }),
        },
      );
      toast.success(
        `Devis ${res.quoteNumber ?? ""} émis au client${res.emailed ? " (PDF envoyé)" : ""}. Abonnement mis à jour à l'acceptation.`,
      );
      setReviseOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setReviseBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        clientId: form.clientId,
        serviceId: form.serviceId,
        label: form.label,
        amountEuros: Number(form.amountEuros),
        billingDay: Number(form.billingDay),
        startDate: form.startDate,
      };
      if (editingId) {
        await api(`/api/subscriptions/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            label: payload.label,
            billingDay: payload.billingDay,
          }),
        });
        toast.success("Abonnement modifié");
      } else {
        await api("/api/subscriptions", { method: "POST", body: JSON.stringify(payload) });
        toast.success("Abonnement créé");
      }
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
                        {s.status !== "ENDED" ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => openEdit(s)}
                            title="Modifier (libellé, jour)"
                          >
                            <FontAwesomeIcon icon={faPen} className="h-3 w-3" />
                          </Button>
                        ) : null}
                        {s.status === "ACTIVE" ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2 text-xs"
                            onClick={() => openRevise(s)}
                            title="Réviser le montant (avenant)"
                          >
                            <FontAwesomeIcon icon={faSync} className="h-3 w-3" />
                          </Button>
                        ) : null}
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? "Modifier l'abonnement" : "Nouvel abonnement mensuel"}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Client">
            <Select
              required
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              disabled={!!editingId}
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
              disabled={!!editingId}
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
            <Field
              label="Montant/mois (€)"
              hint={editingId ? "Via un nouveau devis (légal)" : undefined}
            >
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={form.amountEuros}
                onChange={(e) => setForm({ ...form, amountEuros: e.target.value })}
                disabled={!!editingId}
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
                disabled={!!editingId}
              />
            </Field>
          </div>
          <p className="text-xs text-[var(--muted)]">
            {editingId
              ? "Édition administrative (libellé, jour de prélèvement). Pour changer le montant, utilisez le bouton Réviser (↻) : il émet un devis d'avenant au client et met à jour l'abonnement à l'acceptation."
              : "Une facture sera émise automatiquement chaque mois à cette date (numéro légal alloué, snapshot client figé). Si SMTP est configuré, le PDF sera envoyé au client."}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "…" : editingId ? "Enregistrer" : "Créer"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={reviseOpen}
        onClose={() => setReviseOpen(false)}
        title="Réviser le contrat (avenant)"
        description="Un devis de révision est émis et envoyé au client. L'abonnement passe au nouveau montant à l'acceptation, et la facture correspondante est émise."
      >
        <form onSubmit={onReviseSubmit} className="space-y-4">
          <Field label="Nouveau montant/mois (€)">
            <Input
              required
              type="number"
              step="0.01"
              min="0.01"
              value={reviseAmount}
              onChange={(e) => setReviseAmount(e.target.value)}
            />
          </Field>
          <Field label="Libellé">
            <Input
              required
              placeholder="Maintenance site web : mensuel"
              value={reviseLabel}
              onChange={(e) => setReviseLabel(e.target.value)}
            />
          </Field>
          <p className="text-xs text-[var(--muted)]">
            Ex. ajout d'un site à gérer : le nouveau montant remplace l'ancien à l'acceptation du
            devis. Le mois en cours reste facturé à l'ancien montant ; le suivant l'est au nouveau.
          </p>
          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
            <Button type="button" variant="secondary" onClick={() => setReviseOpen(false)} disabled={reviseBusy}>
              Annuler
            </Button>
            <Button type="submit" disabled={reviseBusy}>
              {reviseBusy ? "Émission…" : "Émettre le devis au client"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
