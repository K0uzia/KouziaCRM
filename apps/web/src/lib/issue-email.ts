import { formatEUR } from "@/lib/api";
import { normalizeInterval, periodWord } from "@/lib/billing-interval";
import { mixedQuoteTotals, proposalTitle, withoutFinalPeriod } from "@/lib/quote-totals";

type IssueEmailLine = {
  description: string;
  isSubscription?: boolean;
  billingDay?: number | null;
  billingInterval?: string | null;
  unitPriceCents: number;
  lineTotalCents?: number;
  /** Pack : titre sous lequel la ligne est groupée ; ligne de remise du pack. */
  groupTitle?: string | null;
  isPackDiscount?: boolean;
  /** Option au choix du client (28/10/2026) : null tant qu'il n'a pas répondu, false refusée. */
  isOptional?: boolean;
  optionalAccepted?: boolean | null;
  commitmentMonths?: number | null;
  /** Devis à propositions : proposition de la ligne. */
  optionId?: string | null;
};

type IssueEmailDoc = {
  client: { displayName: string; email?: string | null };
  /** Devis avec abonnement : phrase de la clause « date de prélèvement », fournie par l'API. */
  subscriptionDateNotice?: string | null;
  totalCents: number;
  subtotalCents?: number | null;
  depositBaseCents?: number | null;
  lines?: IssueEmailLine[];
  /** Devis à propositions : les formules au choix (une seule retenue à la signature). */
  options?: Array<{ id: string; position: number; label: string }>;
  selectedOptionId?: string | null;
};

const perPeriod = (l: IssueEmailLine) => `${formatEUR(l.unitPriceCents)} par ${periodWord(l.billingInterval)}`;

/** Brouillon d'email d'émission. {{numero}} est remplacé côté serveur après attribution. */
export function buildIssueEmailDraft(
  doc: IssueEmailDoc,
  kind: "QUOTE" | "INVOICE",
  companyName = "Alexandre Kouziaeff",
): { subject: string; body: string } {
  const label = kind === "QUOTE" ? "devis" : "facture";
  const firstName = doc.client.displayName.trim().split(/\s+/)[0] || "";
  const greeting = firstName ? `Bonjour ${firstName},` : "Bonjour,";
  const closing = ["Le PDF est joint à ce message.", "", "Cordialement,", companyName];

  // Devis à propositions non signé : chaque formule à part, sans total commun (les lignes ne s'additionnent pas).
  const proposals = kind === "QUOTE" && !doc.selectedOptionId ? [...(doc.options ?? [])].sort((a, b) => a.position - b.position) : [];
  if (proposals.length >= 2) {
    const lines = [greeting, "", `Veuillez trouver ci-joint votre devis {{numero}}. Il vous propose ${proposals.length} formules au choix :`, ""];
    proposals.forEach((o, i) => {
      const own = (doc.lines ?? []).filter((l) => l.optionId === o.id && !l.isOptional);
      const oneOffCents = own.filter((l) => !l.isSubscription).reduce((sum, l) => sum + (l.lineTotalCents ?? l.unitPriceCents), 0);
      const parts = [oneOffCents > 0 ? formatEUR(oneOffCents) : "", ...own.filter((l) => l.isSubscription).map(perPeriod)].filter(Boolean);
      lines.push(`- ${proposalTitle(String.fromCharCode(65 + i), o.label)}${parts.length ? ` : ${parts.join(" + ")}` : ""}`);
    });
    lines.push("", "Vous choisissez une seule formule en signant le devis depuis votre espace client : seule la formule retenue vous engage.", "");
    if (doc.subscriptionDateNotice && (doc.lines ?? []).some((l) => l.isSubscription)) lines.push(doc.subscriptionDateNotice, "");
    return { subject: "Votre devis {{numero}}", body: [...lines, ...closing].join("\n") };
  }

  // Option au choix encore sans réponse : proposée à part, jamais annoncée comme un abonnement compris.
  const pendingOptions = (doc.lines ?? []).filter((l) => l.isOptional && l.optionalAccepted == null);
  const docLines = (doc.lines ?? []).filter((l) => !l.isOptional || l.optionalAccepted === true);
  const subs = docLines.filter((l) => l.isSubscription);
  // Devis d'abonnement seul : rien n'est facturé par le devis lui-même.
  const subscriptionOnly = kind === "QUOTE" && subs.length > 0 && subs.length === docLines.length;
  // Devis mixte : l'abonnement démarre à la livraison, hors acompte et échéancier.
  const mixedQuote = kind === "QUOTE" && subs.length > 0 && !subscriptionOnly;

  // Devis mixte : le montant annoncé est le total du projet (partie ponctuelle remisée) ; l'abonnement est à part.
  const projectCents = mixedQuote
    ? mixedQuoteTotals(docLines, doc.subtotalCents ?? doc.totalCents, doc.totalCents, doc.depositBaseCents).projectCents
    : doc.totalCents;
  const lines: string[] = [
    greeting,
    "",
    mixedQuote
      ? `Veuillez trouver ci-joint votre ${label} {{numero}} : total du projet ${formatEUR(projectCents)}, abonnement en plus (détail ci-dessous).`
      : `Veuillez trouver ci-joint votre ${label} {{numero}}, d'un montant de ${formatEUR(doc.totalCents)}.`,
    "",
  ];

  // Packs : détail de chaque prestation avec son prix, puis la remise du pack, sous le titre du pack.
  const packs = [...new Set(docLines.map((l) => l.groupTitle).filter((g): g is string => Boolean(g)))];
  for (const pack of packs) {
    lines.push(`${pack} :`);
    for (const l of docLines.filter((x) => x.groupTitle === pack)) {
      const amount = l.isSubscription ? perPeriod(l) : formatEUR(l.lineTotalCents ?? l.unitPriceCents);
      lines.push(`- ${l.description} : ${amount}`);
    }
    lines.push("");
  }

  if (subs.length > 0) {
    const intervals = new Set(subs.map((s) => normalizeInterval(s.billingInterval)));
    const only = intervals.size === 1 ? [...intervals][0] : null;
    const kindLabel = only === "YEAR" ? "annuel" : only === "QUARTER" ? "trimestriel" : only === "MONTH" ? "mensuel" : "";
    lines.push(
      subscriptionOnly
        ? `Ce devis porte sur un abonnement${kindLabel ? ` ${kindLabel}` : ""}, sans acompte :`
        : mixedQuote
          ? `Ce devis comprend aussi un abonnement${kindLabel ? ` ${kindLabel}` : ""}, hors acompte :`
          : `Ce document inclut un engagement d'abonnement${kindLabel ? ` ${kindLabel}` : ""} :`,
    );
    lines.push("");
    for (const s of subs) {
      const iv = normalizeInterval(s.billingInterval);
      const each = iv === "YEAR" ? "chaque année" : iv === "QUARTER" ? "chaque trimestre" : "chaque mois";
      const when = iv === "YEAR" ? "chaque année à la date anniversaire" : `${each}${s.billingDay ? ` le ${s.billingDay}` : ""}`;
      lines.push(
        subscriptionOnly
          ? `- ${s.description} : ${formatEUR(s.unitPriceCents)} facturés ${each} à partir de la signature, sans acompte.`
          : mixedQuote
            ? `- ${s.description} : ${formatEUR(s.unitPriceCents)} facturés ${each} à partir de la livraison.`
            : `- ${s.description} : ${formatEUR(s.unitPriceCents)} facturés ${when}. La 1re échéance est incluse dans ce document.`,
      );
    }
    lines.push("");
    lines.push(
      subscriptionOnly
        ? "Après votre signature, chaque échéance fera l'objet d'une facture, envoyée automatiquement."
        : mixedQuote
          ? "L'acompte et l'échéancier portent sur la partie ponctuelle ; chaque échéance d'abonnement fera l'objet d'une facture."
          : "Les échéances suivantes feront l'objet de factures séparées, envoyées automatiquement.",
    );
    lines.push("");
  }

  if (kind === "QUOTE" && pendingOptions.length > 0) {
    lines.push(
      pendingOptions.length > 1
        ? "Options au choix, que vous acceptez ou refusez en signant le devis :"
        : "Option au choix, que vous acceptez ou refusez en signant le devis :",
    );
    lines.push("");
    for (const o of pendingOptions) {
      lines.push(
        o.isSubscription
          ? `- ${withoutFinalPeriod(o.description)} : ${perPeriod(o)}, engagement de ${o.commitmentMonths ?? 12} mois à partir de la livraison.`
          : `- ${withoutFinalPeriod(o.description)} : ${formatEUR(o.lineTotalCents ?? o.unitPriceCents)}.`,
      );
    }
    lines.push("");
  }

  if (kind === "QUOTE" && doc.subscriptionDateNotice && (subs.length > 0 || pendingOptions.some((o) => o.isSubscription))) {
    lines.push(doc.subscriptionDateNotice);
    lines.push("");
  }

  lines.push(...closing);

  return {
    subject: `Votre ${label} {{numero}}`,
    body: lines.join("\n"),
  };
}

/** Brouillon pour une facture d'acompte ou de solde créée depuis un devis signé. */
export function buildBillingEmailDraft(opts: {
  clientName: string;
  kind: "ACOMPTE" | "SOLDE";
  amountCents: number;
  quoteNumber: string | null;
  companyName?: string;
}): { subject: string; body: string } {
  const label = opts.kind === "ACOMPTE" ? "facture d'acompte" : "facture de solde";
  const firstName = opts.clientName.trim().split(/\s+/)[0] || "";
  const ref = opts.quoteNumber ? ` (devis ${opts.quoteNumber})` : "";
  const body = [
    firstName ? `Bonjour ${firstName},` : "Bonjour,",
    "",
    `Veuillez trouver ci-joint votre ${label} {{numero}}${ref}, d'un montant de ${formatEUR(opts.amountCents)}.`,
    opts.kind === "ACOMPTE"
      ? "Son règlement lance le projet : je reviens vers vous dès réception pour démarrer."
      : "Merci pour votre confiance tout au long du projet.",
    "",
    "Le PDF est joint à ce message.",
    "",
    "Cordialement,",
    opts.companyName ?? "Alexandre Kouziaeff",
  ].join("\n");
  return {
    subject: `${opts.kind === "ACOMPTE" ? "Facture d'acompte" : "Facture de solde"} {{numero}}`,
    body,
  };
}

export type { IssueEmailDoc };
