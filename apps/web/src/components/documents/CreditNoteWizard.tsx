import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";

type Eligibility = {
  allowed: boolean;
  code?: string;
  message?: string;
  alternative?: string;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceIssueDate: string | null;
  invoiceType: string;
  status: string;
  clientName: string;
  clientNumber: string | null;
  invoiceTotalCents: number;
  paidCents: number;
  alreadyCreditedCents: number;
  maxCreditCents: number;
  isAcompte: boolean;
  requiresCgvCheck: boolean;
  nextNumberPreview: string | null;
};

type CreatedCreditNote = {
  id: string;
  number: string | null;
  totalCents: number;
  issueDate: string | null;
};

const REASONS = [
  {
    value: "REFUND_DEPOSIT",
    label: "Remboursement d'acompte (annulation)",
  },
  { value: "COMMERCIAL_GESTURE", label: "Geste commercial" },
  { value: "AMOUNT_CORRECTION", label: "Correction d'erreur de montant" },
] as const;

const REFUNDS = [
  { value: "BANK_TRANSFER", label: "Virement de remboursement" },
  { value: "DEDUCT_FROM_BALANCE", label: "Déduction sur solde restant dû" },
  { value: "OTHER", label: "Autre" },
] as const;

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function CreditNoteWizard({
  open,
  invoiceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  invoiceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [created, setCreated] = useState<CreatedCreditNote | null>(null);

  const [reason, setReason] = useState<string>("AMOUNT_CORRECTION");
  const [reasonDetail, setReasonDetail] = useState("");
  const [amountEuros, setAmountEuros] = useState("");
  const [refundMethod, setRefundMethod] = useState("BANK_TRANSFER");
  const [cgvRefundable, setCgvRefundable] = useState<"" | "yes" | "no">("");
  const [issueDate, setIssueDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [registerRefund, setRegisterRefund] = useState(true);
  const [monthReceiptsEuros, setMonthReceiptsEuros] = useState("");

  const [checklist, setChecklist] = useState({
    sentToClient: false,
    bankTransferDone: false,
    receiptsLineAdded: false,
    archivedWithOriginal: false,
    urssafImpactNoted: false,
    negativeCarryoverReminder: false,
  });

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setCreated(null);
    setLoading(true);
    setCgvRefundable("");
    setReasonDetail("");
    api<Eligibility>(`/api/invoices/${invoiceId}/credit-note/eligibility`)
      .then((e) => {
        setElig(e);
        setAmountEuros((e.maxCreditCents / 100).toFixed(2));
        setReason(
          e.isAcompte ? "REFUND_DEPOSIT" : "AMOUNT_CORRECTION",
        );
      })
      .catch((err: Error) => {
        toast.error(err.message);
        onClose();
      })
      .finally(() => setLoading(false));
  }, [open, invoiceId, onClose]);

  const amountCents = Math.round(Number(amountEuros || 0) * 100);
  const monthReceiptsCents = Math.round(Number(monthReceiptsEuros || 0) * 100);
  const declaredCents = monthReceiptsCents - Math.abs(created?.totalCents ?? amountCents);
  const needsCgv =
    !!elig?.requiresCgvCheck && reason === "REFUND_DEPOSIT";

  const stepTitle = useMemo(() => {
    const titles: Record<Step, string> = {
      1: "Diagnostic",
      2: "CGV acompte",
      3: "Informations",
      4: "Génération",
      5: "Livre des recettes",
      6: "Déclaration URSSAF",
      7: "Suivi",
    };
    return titles[step];
  }, [step]);

  function goNextFromDiagnostic() {
    if (!elig?.allowed) return;
    if (needsCgv) setStep(2);
    else setStep(3);
  }

  async function generate() {
    if (!elig) return;
    if (amountCents <= 0 || amountCents > elig.maxCreditCents) {
      toast.error("Montant HT invalide");
      return;
    }
    if (needsCgv && cgvRefundable !== "yes") {
      toast.error("Confirmez que l'acompte est remboursable selon vos CGV");
      return;
    }
    setBusy(true);
    try {
      const cn = await api<CreatedCreditNote>(
        `/api/invoices/${invoiceId}/credit-note`,
        {
          method: "POST",
          body: JSON.stringify({
            amountEuros: Number(amountEuros),
            reason,
            reasonDetail: reasonDetail || null,
            refundMethod,
            cgvDepositRefundable: needsCgv ? true : null,
            issueDate,
            registerRefundPayment:
              refundMethod === "BANK_TRANSFER" ? registerRefund : false,
            refundPaidAt: issueDate,
          }),
        },
      );
      setCreated(cn);
      setChecklist((c) => ({
        ...c,
        receiptsLineAdded:
          refundMethod === "BANK_TRANSFER" ? registerRefund : false,
      }));
      toast.success(`Avoir ${cn.number} créé`);
      setStep(5);
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function saveChecklist() {
    if (!created) return;
    try {
      await api(`/api/invoices/${created.id}/credit-note/follow-up`, {
        method: "PATCH",
        body: JSON.stringify(checklist),
      });
      toast.success("Checklist enregistrée");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Avoir · ${stepTitle}`}
      description="Procédure micro-entreprise (franchise TVA art. 293 B)"
      wide
    >
      {loading || !elig ? (
        <p className="text-sm text-[var(--muted)]">Analyse de la facture…</p>
      ) : (
        <div className="space-y-5">
          {step === 1 ? (
            <div className="space-y-4 text-sm">
              <p>
                Facture <strong>{elig.invoiceNumber ?? "?"}</strong>
                {elig.invoiceIssueDate
                  ? ` du ${formatDate(elig.invoiceIssueDate)}`
                  : ""}{" "}
                · {elig.clientName}
              </p>
              <ul className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4">
                <li>
                  Encaissé : <strong>{formatEUR(elig.paidCents)}</strong> /{" "}
                  {formatEUR(elig.invoiceTotalCents)}
                </li>
                <li>
                  Déjà avoirisé : {formatEUR(elig.alreadyCreditedCents)}
                </li>
                <li>
                  Max avoir possible :{" "}
                  <strong>{formatEUR(elig.maxCreditCents)}</strong>
                </li>
                <li>
                  Prochain n° :{" "}
                  <span className="font-mono">{elig.nextNumberPreview}</span>
                </li>
              </ul>

              {!elig.allowed ? (
                <div className="space-y-3 rounded-[var(--radius)] border border-[var(--danger)]/40 bg-red-50 p-4 text-[var(--danger)]">
                  <p className="font-medium">{elig.message}</p>
                  {elig.alternative ? (
                    <p className="text-[var(--text)]">{elig.alternative}</p>
                  ) : null}
                  {elig.code === "UNPAID" ? (
                    <p className="text-[var(--text)]">
                      Règle : si le client n&apos;a rien payé, un avoir n&apos;est
                      pas nécessaire. Conservez la facture dans la numérotation
                      (jamais de suppression) et ne déclarez que les
                      encaissements réels.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-[var(--muted)]">
                  Un avoir est justifié uniquement pour rembourser / corriger un
                  montant déjà encaissé. Montants en euros HT.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Fermer
                </Button>
                {elig.allowed ? (
                  <Button onClick={goNextFromDiagnostic}>Continuer</Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4 text-sm">
              <p>
                Facture d&apos;acompte : que disent vos CGV si le client annule
                ?
              </p>
              <Field label="L'acompte est-il remboursable ?">
                <Select
                  value={cgvRefundable}
                  onChange={(e) =>
                    setCgvRefundable(e.target.value as "" | "yes" | "no")
                  }
                >
                  <option value="">Choisir…</option>
                  <option value="yes">Oui, remboursable → émettre un avoir</option>
                  <option value="no">
                    Non, acompte acquis → pas d&apos;avoir (recette)
                  </option>
                </Select>
              </Field>
              {cgvRefundable === "no" ? (
                <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3">
                  Pas d&apos;avoir à émettre. Déclarez l&apos;acompte comme
                  recette encaissée. Conservez la facture et vos CGV 10 ans.
                </p>
              ) : null}
              <div className="flex justify-between gap-2">
                <Button variant="secondary" onClick={() => setStep(1)}>
                  Retour
                </Button>
                {cgvRefundable === "yes" ? (
                  <Button onClick={() => setStep(3)}>Continuer</Button>
                ) : (
                  <Button variant="secondary" onClick={onClose}>
                    Fermer
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <p>
                  Facture d&apos;origine :{" "}
                  <strong>{elig.invoiceNumber}</strong>
                </p>
                <p>
                  Client : <strong>{elig.clientName}</strong>
                  {elig.clientNumber ? ` (${elig.clientNumber})` : ""}
                </p>
              </div>
              <Field label="Motif">
                <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Précision (optionnel)">
                <Textarea
                  rows={2}
                  value={reasonDetail}
                  onChange={(e) => setReasonDetail(e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Montant HT de l'avoir (€)"
                  hint={`Max ${formatEUR(elig.maxCreditCents)}`}
                >
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={(elig.maxCreditCents / 100).toFixed(2)}
                    value={amountEuros}
                    onChange={(e) => setAmountEuros(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Date d'émission">
                  <Input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Mode de remboursement">
                <Select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                >
                  {REFUNDS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {refundMethod === "BANK_TRANSFER" ? (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={registerRefund}
                    onChange={(e) => setRegisterRefund(e.target.checked)}
                  />
                  <span>
                    Enregistrer la ligne négative dans le livre des recettes
                    (virement)
                  </span>
                </label>
              ) : null}
              <p className="text-xs text-[var(--muted)]">
                Prochain numéro : {elig.nextNumberPreview}. Conservez tous les
                documents 10 ans.
              </p>
              <div className="flex justify-between gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setStep(needsCgv ? 2 : 1)}
                >
                  Retour
                </Button>
                <Button onClick={() => setStep(4)}>Prévisualiser</Button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-4 space-y-2">
                <p className="text-lg font-semibold">AVOIR {elig.nextNumberPreview}</p>
                <p>
                  Réf. facture {elig.invoiceNumber}
                  {elig.invoiceIssueDate
                    ? ` du ${formatDate(elig.invoiceIssueDate)}`
                    : ""}
                </p>
                <p>Client : {elig.clientName}</p>
                <p>
                  Motif :{" "}
                  {REASONS.find((r) => r.value === reason)?.label}
                  {reasonDetail ? ` - ${reasonDetail}` : ""}
                </p>
                <p>
                  Montant HT : <strong>{formatEUR(amountCents)}</strong>
                </p>
                <p>
                  Remboursement :{" "}
                  {REFUNDS.find((r) => r.value === refundMethod)?.label}
                </p>
                <p className="text-[var(--muted)]">
                  TVA non applicable, art. 293 B du CGI
                </p>
                {refundMethod === "BANK_TRANSFER" ? (
                  <p className="font-medium">Vous n&apos;avez rien à payer.</p>
                ) : null}
              </div>
              <div className="flex justify-between gap-2">
                <Button variant="secondary" onClick={() => setStep(3)}>
                  Retour
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => void generate()}>
                  {busy ? "Création…" : "Émettre l'avoir"}
                </Button>
              </div>
            </div>
          ) : null}

          {step === 5 && created ? (
            <div className="space-y-4 text-sm">
              <p>Ligne à retrouver dans le livre des recettes :</p>
              <ul className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4 space-y-1 font-mono text-xs">
                <li>Date : {issueDate}</li>
                <li>N° : {created.number}</li>
                <li>Réf. facture : {elig.invoiceNumber}</li>
                <li>
                  Montant :{" "}
                  <strong className="text-[var(--danger)]">
                    {formatEUR(created.totalCents)}
                  </strong>{" "}
                  (négatif)
                </li>
                <li>Nature : avoir</li>
              </ul>
              {refundMethod !== "BANK_TRANSFER" || !registerRefund ? (
                <p className="text-[var(--muted)]">
                  Aucune ligne négative auto : enregistrez le remboursement quand
                  le virement part réellement.
                </p>
              ) : (
                <p className="text-[var(--muted)]">
                  Ligne négative déjà enregistrée (cohérente avec le virement).
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button onClick={() => setStep(6)}>Suite URSSAF</Button>
              </div>
            </div>
          ) : null}

          {step === 6 && created ? (
            <div className="space-y-4 text-sm">
              <p>
                Le mois du remboursement, déduisez l&apos;avoir des recettes
                encaissées :
              </p>
              <Field label="Recettes encaissées du mois (hors cet avoir) (€)">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={monthReceiptsEuros}
                  onChange={(e) => setMonthReceiptsEuros(e.target.value)}
                  placeholder="ex. 2500"
                />
              </Field>
              {monthReceiptsEuros !== "" ? (
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-4 space-y-2">
                  <p>
                    {formatEUR(monthReceiptsCents)} −{" "}
                    {formatEUR(Math.abs(created.totalCents))} ={" "}
                    <strong>
                      {formatEUR(declaredCents)}
                    </strong>{" "}
                    à déclarer
                  </p>
                  {declaredCents < 0 ? (
                    <p className="text-[var(--danger)]">
                      Résultat négatif : déclarez <strong>0 €</strong> ce mois-ci
                      et reportez {formatEUR(Math.abs(declaredCents))} sur le ou
                      les mois suivants.
                    </p>
                  ) : null}
                  <p className="text-xs text-[var(--muted)]">
                    L&apos;avoir doit coller au mouvement bancaire (virement
                    visible sur le compte pro). Cohérence annuelle : déclarations
                    URSSAF = recettes réelles − avoirs.
                  </p>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <Button variant="secondary" onClick={() => setStep(5)}>
                  Retour
                </Button>
                <Button onClick={() => setStep(7)}>Checklist</Button>
              </div>
            </div>
          ) : null}

          {step === 7 && created ? (
            <div className="space-y-4 text-sm">
              <p className="font-medium">Suivi et preuves (conservation 10 ans)</p>
              {(
                [
                  ["sentToClient", "Avoir envoyé au client (email + AR)"],
                  ["bankTransferDone", "Virement effectué + preuve bancaire"],
                  ["receiptsLineAdded", "Ligne négative livre des recettes"],
                  ["archivedWithOriginal", "Avoir archivé avec la facture d'origine"],
                  ["urssafImpactNoted", "Impact URSSAF noté pour le mois concerné"],
                  [
                    "negativeCarryoverReminder",
                    "Si solde négatif : rappel mois suivant",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checklist[key]}
                    onChange={(e) =>
                      setChecklist((c) => ({ ...c, [key]: e.target.checked }))
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              <div className="flex flex-wrap justify-between gap-2">
                <Button variant="secondary" onClick={() => setStep(6)}>
                  Retour
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void saveChecklist()}>
                    Enregistrer checklist
                  </Button>
                  <Button
                    onClick={() => {
                      onClose();
                      navigate(`/invoices/${created.id}`);
                    }}
                  >
                    Ouvrir l&apos;avoir
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
