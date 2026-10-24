import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSettings } from "@/lib/settings-request";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Checkbox, DateInput, Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { useMediaQuery } from "@/lib/use-media-query";
import { ResendDocumentDialog } from "@/components/messaging/document-email-dialogs";

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
  /** Reste dû (avoirs compris) : la part de l'avoir jusqu'à ce montant est déduite, le reste est remboursé. */
  dueCents: number;
  /** Encaissé net (paiements moins remboursements). */
  cashInCents: number;
  isAcompte: boolean;
  requiresCgvCheck: boolean;
  nextNumberPreview: string | null;
};

type CreatedCreditNote = {
  id: string;
  number: string | null;
  totalCents: number;
  issueDate: string | null;
  emailed?: boolean;
  emailReason?: string | null;
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
/** Modes possibles quand une part de l'avoir est à rembourser (au-delà du reste dû). */
const REFUND_CHOICES = REFUNDS.filter((r) => r.value !== "DEDUCT_FROM_BALANCE");

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
  // Avoir créé : e-mail au client relu dans « Vérifier l'e-mail » (jamais envoyé d'office).
  const [sendCreditFor, setSendCreditFor] = useState<string | null>(null);

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

  // Mention de TVA des réglages (jamais en dur) ; absente tant qu'elle n'est pas lue.
  const [vatMention, setVatMention] = useState<string | null>(null);
  useEffect(() => {
    fetchSettings<{ vatMention?: string }>()
      .then((s) => setVatMention(s.vatMention?.trim() || null))
      .catch(() => setVatMention(null));
  }, []);

  // onClose change d'identité à chaque rendu de la fiche (rechargée après l'émission) : lu par une référence, pour que
  // l'assistant ne revienne pas au diagnostic au lieu d'afficher le livre des recettes et l'URSSAF.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
        // Par défaut, le reste dû (correction de ce que le client doit) ; facture déjà réglée : le net, à rembourser.
        setAmountEuros(((e.dueCents > 0 ? e.dueCents : e.maxCreditCents) / 100).toFixed(2));
        setReason(
          e.isAcompte ? "REFUND_DEPOSIT" : "AMOUNT_CORRECTION",
        );
      })
      .catch((err: Error) => {
        toast.error(err.message);
        onCloseRef.current();
      })
      .finally(() => setLoading(false));
  }, [open, invoiceId]);

  const amountCents = Math.round(Number(amountEuros || 0) * 100);
  // Part déduite du reste dû et part à rembourser (trop-perçu) : même règle que l'API (creditNoteSplit).
  const deductedCents = elig ? Math.min(amountCents, Math.max(0, elig.dueCents)) : 0;
  const refundCents = Math.max(0, amountCents - deductedCents);
  const effectiveRefund = refundCents === 0 ? "DEDUCT_FROM_BALANCE" : refundMethod === "DEDUCT_FROM_BALANCE" ? "BANK_TRANSFER" : refundMethod;
  const monthReceiptsCents = Math.round(Number(monthReceiptsEuros || 0) * 100);
  const declaredCents = monthReceiptsCents - refundCents;
  const needsCgv =
    !!elig?.requiresCgvCheck && reason === "REFUND_DEPOSIT";

  // Aperçu PDF de l'avoir (étapes Informations et Prévisualiser) : panneau dès 1280 px (D3, comme la fenêtre devis et facture), sinon fenêtre plein écran.
  const widePreview = useMediaQuery("(min-width: 80rem)");
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewStep = Boolean(elig?.allowed) && (step === 3 || step === 4);
  const amountValid = !!elig && amountCents > 0 && amountCents <= elig.maxCreditCents;
  const previewBody = useMemo(
    () =>
      previewStep && amountValid
        ? JSON.stringify({
            documentType: "CREDIT_NOTE",
            invoiceId,
            amountEuros: Number(amountEuros),
            reason,
            reasonDetail: reasonDetail || null,
            refundMethod: effectiveRefund,
            issueDate: issueDate || undefined,
          })
        : null,
    [previewStep, amountValid, invoiceId, amountEuros, reason, reasonDetail, effectiveRefund, issueDate],
  );
  const previewPaused = elig
    ? `Aperçu en pause : montant entre 0,01 € et ${formatEUR(elig.maxCreditCents)}.`
    : "Analyse de la facture…";
  const previewButton =
    previewStep && !widePreview ? (
      <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
        Aperçu
      </Button>
    ) : null;

  // Pied fixe (D4, même gabarit que le devis) : le montant de l'avoir à gauche, les actions à droite.
  const amountSummary = (
    <p className="mr-auto flex min-h-11 flex-col justify-center">
      <span className="text-xs text-[var(--muted)]">Montant de l'avoir</span>
      <span className="font-display text-lg font-semibold tabular-nums">{amountValid ? formatEUR(amountCents) : "À saisir"}</span>
    </p>
  );

  const stepTitle = useMemo(() => {
    const titles: Record<Step, string> = {
      1: "Diagnostic",
      2: "CGV acompte",
      3: "Informations",
      4: "Prévisualiser",
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
      toast.error("Montant invalide");
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
            refundMethod: effectiveRefund,
            cgvDepositRefundable: needsCgv ? true : null,
            issueDate,
            registerRefundPayment:
              effectiveRefund === "BANK_TRANSFER" ? registerRefund : false,
            refundPaidAt: issueDate,
            sendEmail: false,
          }),
        },
      );
      setCreated(cn);
      setChecklist((c) => ({
        ...c,
        sentToClient: Boolean(cn.emailed),
        receiptsLineAdded:
          effectiveRefund === "BANK_TRANSFER" ? registerRefund : false,
      }));
      toast.success(`Avoir ${cn.number} créé`);
      setStep(5);
      onCreated();
      setSendCreditFor(cn.id);
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
      extraWide={previewStep}
    >
      {loading || !elig ? (
        <p className="text-sm text-[var(--muted)]">Analyse de la facture…</p>
      ) : (
        <>
        <div className={previewStep && widePreview ? "lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start lg:gap-8" : ""}>
        <div className="min-w-0 space-y-5">
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
                  Encaissé : <strong>{formatEUR(elig.cashInCents)}</strong> /{" "}
                  {formatEUR(elig.invoiceTotalCents)}
                </li>
                <li>
                  Reste dû : <strong>{formatEUR(elig.dueCents)}</strong>
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
                <div className="space-y-3 rounded-[var(--radius)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] p-4 text-[var(--danger)]">
                  <p className="font-medium">{elig.message}</p>
                  {elig.alternative ? (
                    <p className="text-[var(--text)]">{elig.alternative}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-[var(--muted)]">
                  Un avoir corrige la facture émise, qui reste dans la numérotation. Jusqu&apos;au reste dû, il
                  est déduit de ce que le client doit ; au-delà, la différence lui est remboursée. Montants en euros.
                </p>
              )}

              <ModalActions>
                <Button variant="secondary" onClick={onClose}>
                  Fermer
                </Button>
                {elig.allowed ? (
                  <Button onClick={goNextFromDiagnostic}>Continuer</Button>
                ) : null}
              </ModalActions>
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
              <ModalActions>
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
              </ModalActions>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Montant de l'avoir (€)"
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
                  <DateInput
                    value={issueDate}
                    onChange={(v) => setIssueDate(v)}
                  />
                </Field>
              </div>
              {refundCents === 0 ? (
                <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3 text-sm">
                  Déduction sur le solde restant dû : le client doit {formatEUR(Math.max(0, elig.dueCents - amountCents))} après
                  cet avoir. Rien à rembourser.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    {deductedCents > 0 ? <>Déduit du reste dû : <strong>{formatEUR(deductedCents)}</strong>. </> : null}
                    À rembourser au client : <strong>{formatEUR(refundCents)}</strong>.
                  </p>
                  <Field label="Mode de remboursement">
                    <Select value={effectiveRefund} onChange={(e) => setRefundMethod(e.target.value)}>
                      {REFUND_CHOICES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              {effectiveRefund === "BANK_TRANSFER" ? (
                <Checkbox
                  label="Enregistrer la ligne négative dans le livre des recettes (virement)"
                  checked={registerRefund}
                  onChange={(e) => setRegisterRefund(e.target.checked)}
                />
              ) : null}
              <p className="text-xs text-[var(--muted)]">
                Prochain numéro : {elig.nextNumberPreview}. Conservez tous les
                documents 10 ans.
              </p>
              <ModalActions>
                {amountSummary}
                <Button variant="secondary" onClick={() => setStep(needsCgv ? 2 : 1)}>
                  Retour
                </Button>
                {previewButton}
                <Button onClick={() => setStep(4)} disabled={!amountValid}>
                  Continuer
                </Button>
              </ModalActions>
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
                  Montant : <strong>{formatEUR(amountCents)}</strong>
                </p>
                <p>
                  Remboursement :{" "}
                  {REFUNDS.find((r) => r.value === effectiveRefund)?.label}
                  {refundCents > 0 && deductedCents > 0 ? ` (${formatEUR(deductedCents)} déduits, ${formatEUR(refundCents)} remboursés)` : ""}
                </p>
                {vatMention ? <p className="text-[var(--muted)]">{vatMention}</p> : null}
                {effectiveRefund === "BANK_TRANSFER" ? (
                  <p className="font-medium">Vous n&apos;avez rien à payer.</p>
                ) : null}
              </div>
              <ModalActions>
                {amountSummary}
                <Button variant="secondary" onClick={() => setStep(3)}>
                  Retour
                </Button>
                {previewButton}
                <Button variant="danger" disabled={busy} onClick={() => void generate()}>
                  {busy ? "Création…" : "Émettre l'avoir"}
                </Button>
              </ModalActions>
            </div>
          ) : null}

          {step === 5 && created ? (
            <div className="space-y-4 text-sm">
              {refundCents === 0 ? (
                <p>
                  Aucune ligne au livre des recettes : rien n&apos;a été encaissé ni remboursé, l&apos;avoir réduit
                  ce que le client doit.
                </p>
              ) : (
                <>
                  <p>Ligne à retrouver dans le livre des recettes :</p>
                  <ul className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4 space-y-1 font-mono text-xs">
                    <li>Date : {issueDate}</li>
                    <li>N° : {created.number}</li>
                    <li>Réf. facture : {elig.invoiceNumber}</li>
                    <li>
                      Montant :{" "}
                      <strong className="text-[var(--danger)]">-{formatEUR(refundCents)}</strong> (remboursement)
                    </li>
                    <li>Nature : avoir</li>
                  </ul>
                </>
              )}
              {refundCents === 0 ? null : effectiveRefund !== "BANK_TRANSFER" || !registerRefund ? (
                <p className="text-[var(--muted)]">
                  Aucune ligne négative automatique : quand le virement part réellement, enregistrez-le depuis la fiche
                  de la facture (« Enregistrer un remboursement »).
                </p>
              ) : (
                <p className="text-[var(--muted)]">
                  Ligne négative déjà enregistrée (cohérente avec le virement).
                </p>
              )}
              <ModalActions>
                <Button onClick={() => setStep(6)}>Suite URSSAF</Button>
              </ModalActions>
            </div>
          ) : null}

          {step === 6 && created ? (
            <div className="space-y-4 text-sm">
              {refundCents === 0 ? (
                <p>
                  Aucun impact URSSAF : vous déclarez ce que vous encaissez, et cet avoir ne rembourse rien. Le
                  reste dû diminue, la recette sera déclarée quand le client paiera.
                </p>
              ) : (
              <p>
                Le mois du remboursement, déduisez la part remboursée ({formatEUR(refundCents)}) des recettes
                encaissées :
              </p>
              )}
              {refundCents === 0 ? null : (
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
              )}
              {refundCents > 0 && monthReceiptsEuros !== "" ? (
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-4 space-y-2">
                  <p>
                    {formatEUR(monthReceiptsCents)} -{" "}
                    {formatEUR(refundCents)} ={" "}
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
              <ModalActions>
                <Button variant="secondary" onClick={() => setStep(5)}>
                  Retour
                </Button>
                <Button onClick={() => setStep(7)}>Checklist</Button>
              </ModalActions>
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
                <Checkbox
                  key={key}
                  label={label}
                  checked={checklist[key]}
                  onChange={(e) => setChecklist((c) => ({ ...c, [key]: e.target.checked }))}
                />
              ))}
              <ModalActions>
                <Button variant="secondary" onClick={() => setStep(6)}>
                  Retour
                </Button>
                <Button variant="secondary" onClick={() => void saveChecklist()}>
                  Enregistrer la checklist
                </Button>
                <Button
                  onClick={() => {
                    onClose();
                    navigate(`/invoices/${created.id}`);
                  }}
                >
                  Ouvrir l&apos;avoir
                </Button>
              </ModalActions>
            </div>
          ) : null}
        </div>
        {previewStep && widePreview ? (
          <aside
            aria-labelledby="avoir-recap"
            className="sticky top-0 space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-4"
          >
            <h3 id="avoir-recap" className="font-display text-base font-semibold text-[var(--text)]">
              Récapitulatif
            </h3>
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--muted)]">Facture d&apos;origine</dt>
                <dd className="tabular-nums">{elig.invoiceNumber ?? "?"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--muted)]">Montant de l&apos;avoir</dt>
                <dd className="font-semibold tabular-nums">{amountValid ? formatEUR(amountCents) : "À saisir"}</dd>
              </div>
              {amountValid ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--muted)]">Déduit du reste dû</dt>
                    <dd className="tabular-nums">{formatEUR(deductedCents)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--muted)]">À rembourser</dt>
                    <dd className="tabular-nums">{formatEUR(refundCents)}</dd>
                  </div>
                </>
              ) : null}
            </dl>
            <div className="space-y-2 border-t border-[var(--border)] pt-3">
              <p className="text-sm font-medium">Aperçu</p>
              <DocumentPreview body={previewBody} pausedReason={previewPaused} active kindLabel="Avoir" />
            </div>
          </aside>
        ) : null}
        </div>
        <Modal
          open={previewOpen && previewStep && !widePreview}
          onClose={() => setPreviewOpen(false)}
          title="Aperçu de l'avoir"
          description="L'avoir tel qu'il sera émis. Rien n'est enregistré."
          fullScreenMobile
        >
          <DocumentPreview
            body={previewBody}
            pausedReason={previewPaused}
            active={previewOpen && previewStep && !widePreview}
            kindLabel="Avoir"
          />
        </Modal>
        </>
      )}
      <ResendDocumentDialog
        documentId={sendCreditFor}
        onClose={() => setSendCreditFor(null)}
        onSent={() => setChecklist((c) => ({ ...c, sentToClient: true }))}
      />
    </Modal>
  );
}
