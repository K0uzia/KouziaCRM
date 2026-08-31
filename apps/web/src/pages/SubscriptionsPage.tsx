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
type Service = {
  id: string;
  name: string;
  description?: string | null;
  unitPriceCents: number;
  isSubscription?: boolean;
  defaultBillingDay?: number;
  active?: boolean;
};

const emptyOfferForm = {
  name: "",
  description: "",
  unitPriceEuros: "",
  defaultBillingDay: "1",
  active: true,
};

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
  const [offers, setOffers] = useState<Service[]>([]);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<Service | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerForm, setOfferForm] = useState(emptyOfferForm);
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
    const [subs, cls, svcs, catalog] = await Promise.all([
      api<Subscription[]>("/api/subscriptions"),
      api<Client[]>("/api/clients").catch(() => [] as Client[]),
      api<Service[]>("/api/services?active=1&subscription=1").catch(() => [] as Service[]),
      api<Service[]>("/api/services?subscription=1").catch(() => [] as Service[]),
    ]);
    setRows(subs);
    setClients(cls);
    setServices(svcs);
    setOffers(catalog);
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  function openCreateOffer() {
    setEditingOffer(null);
    setOfferForm(emptyOfferForm);
    setOfferOpen(true);
  }

  function openEditOffer(s: Service) {
    setEditingOffer(s);
    setOfferForm({
      name: s.name,
      description: s.description ?? "",
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
      defaultBillingDay: String(s.defaultBillingDay ?? 1),
      active: s.active !== false,
    });
    setOfferOpen(true);
  }

  async function onOfferSubmit(e: FormEvent) {
    e.preventDefault();
    setOfferBusy(true);
    try {
      const body = {
        name: offerForm.name,
        description: offerForm.description || null,
        unitPriceEuros: Number(offerForm.unitPriceEuros),
        unit: "FORFAIT" as const,
        active: offerForm.active,
        isSubscription: true,
        defaultBillingDay: Number(offerForm.defaultBillingDay) || 1,
      };
      if (editingOffer) {
        await api(`/api/services/${editingOffer.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        toast.success("Offre abonnement mise à jour");
      } else {
        await api("/api/services", { method: "POST", body: JSON.stringify(body) });
        toast.success("Offre abonnement créée");
      }
      setOfferOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setOfferBusy(false);
    }
  }

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

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text)]">Offres abonnement</h2>
            <p className="text-xs text-[var(--muted)]">
              Tarifs mensuels réutilisables pour créer un contrat client
            </p>
          </div>
          <Button variant="secondary" onClick={openCreateOffer}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            Nouvelle offre
          </Button>
        </div>
        {offers.length === 0 ? (
          <EmptyState
            title="Aucune offre abonnement"
            hint="Définissez vos forfaits mensuels (maintenance, hébergement, etc.) avant de créer un contrat."
          />
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {offers.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 hover:bg-[var(--surface-hover)]"
              >
                <div className="min-w-0">
                  <p className="font-medium text-[var(--text)]">{o.name}</p>
                  {o.description ? (
                    <p className="mt-1 text-sm text-[var(--muted)]">{o.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Facturation le {o.defaultBillingDay ?? 1} de chaque mois
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-lg font-semibold tabular-nums">{formatEUR(o.unitPriceCents)}</p>
                    <p className="text-xs text-[var(--muted)]">HT / mois</p>
                  </div>
                  {!o.active ? <Badge tone="red">Inactive</Badge> : null}
                  <Button
                    variant="ghost"
                    className="h-8 px-3 text-xs"
                    onClick={() => openEditOffer(o)}
                  >
                    Modifier
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="Aucun abonnement"
            hint="Créez un contrat de maintenance mensuel : une facture sera émise automatiquement chaque mois."
          />
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="nowrap">Client</th>
                  <th className="wrap">Libellé</th>
                  <th className="nowrap text-right">Montant/mois</th>
                  <th className="nowrap">Jour</th>
                  <th className="nowrap">Prochaine facture</th>
                  <th className="nowrap">Statut</th>
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const badge = statusBadge[s.status];
                  return (
                    <tr key={s.id}>
                      <td className="nowrap">
                        <p className="font-medium">{s.client.displayName}</p>
                        <p className="text-xs text-[var(--muted)]">{s.service.name}</p>
                      </td>
                      <td className="wrap">{s.label}</td>
                      <td className="nowrap text-right tabular-nums font-medium">
                        {formatEUR(s.amountCents)}
                      </td>
                      <td className="nowrap">{s.billingDay}</td>
                      <td className="nowrap text-[var(--muted)]">
                        {formatDate(s.nextInvoiceAt)}
                      </td>
                      <td className="nowrap">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td className="col-actions">
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
          </div>
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
          <Field label="Offre abonnement">
            <Select
              required
              value={form.serviceId}
              onChange={(e) => {
                const id = e.target.value;
                const svc = services.find((s) => s.id === id);
                setForm({
                  ...form,
                  serviceId: id,
                  amountEuros: svc
                    ? (svc.unitPriceCents / 100).toFixed(2)
                    : form.amountEuros,
                  label: form.label || (svc ? `${svc.name} : mensuel` : ""),
                  billingDay: svc?.defaultBillingDay
                    ? String(svc.defaultBillingDay)
                    : form.billingDay,
                });
              }}
              disabled={!!editingId}
            >
              <option value="">Choisir une offre…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} - {(s.unitPriceCents / 100).toFixed(2)} € / mois
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

      <Modal
        open={offerOpen}
        onClose={() => setOfferOpen(false)}
        title={editingOffer ? "Modifier l'offre abonnement" : "Nouvelle offre abonnement"}
      >
        <form onSubmit={onOfferSubmit} className="space-y-4">
          <Field label="Nom">
            <Input
              required
              value={offerForm.name}
              onChange={(e) => setOfferForm({ ...offerForm, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Input
              value={offerForm.description}
              onChange={(e) => setOfferForm({ ...offerForm, description: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prix HT / mois (€)">
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={offerForm.unitPriceEuros}
                onChange={(e) =>
                  setOfferForm({ ...offerForm, unitPriceEuros: e.target.value })
                }
              />
            </Field>
            <Field label="Jour de facturation">
              <Select
                value={offerForm.defaultBillingDay}
                onChange={(e) =>
                  setOfferForm({ ...offerForm, defaultBillingDay: e.target.value })
                }
              >
                {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                  <option key={d} value={String(d)}>
                    Le {d} de chaque mois
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={offerForm.active}
              onChange={(e) => setOfferForm({ ...offerForm, active: e.target.checked })}
            />
            Active (proposée à la création d'un contrat)
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOfferOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={offerBusy}>
              {offerBusy ? "…" : "Enregistrer"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
