import { formatEUR } from "@/lib/api";

type IssueEmailDoc = {
  client: { displayName: string; email?: string | null };
  totalCents: number;
  lines?: Array<{
    description: string;
    isSubscription?: boolean;
    billingDay?: number | null;
    billingInterval?: string | null;
    unitPriceCents: number;
  }>;
};

/** Brouillon d'email d'émission. {{numero}} est remplacé côté serveur après attribution. */
export function buildIssueEmailDraft(
  doc: IssueEmailDoc,
  kind: "QUOTE" | "INVOICE",
  companyName = "Alexandre Kouziaeff",
): { subject: string; body: string } {
  const label = kind === "QUOTE" ? "devis" : "facture";
  const firstName = doc.client.displayName.trim().split(/\s+/)[0] || "";
  const subs = (doc.lines ?? []).filter((l) => l.isSubscription);
  // Devis d'abonnement seul : rien n'est facturé par le devis lui-même.
  const subscriptionOnly = kind === "QUOTE" && subs.length > 0 && subs.length === (doc.lines ?? []).length;

  const lines: string[] = [
    firstName ? `Bonjour ${firstName},` : "Bonjour,",
    "",
    `Veuillez trouver ci-joint votre ${label} {{numero}}, d'un montant de ${formatEUR(doc.totalCents)}.`,
    "",
  ];

  if (subs.length > 0) {
    const yearly = (s: (typeof subs)[number]) => s.billingInterval === "YEAR";
    const kindLabel = subs.every(yearly) ? "annuel" : subs.some(yearly) ? "" : "mensuel";
    lines.push(
      subscriptionOnly
        ? `Ce devis porte sur un abonnement${kindLabel ? ` ${kindLabel}` : ""}, sans acompte :`
        : `Ce document inclut un engagement d'abonnement${kindLabel ? ` ${kindLabel}` : ""} :`,
    );
    lines.push("");
    for (const s of subs) {
      const day = s.billingDay ? ` le ${s.billingDay}` : "";
      const when = yearly(s) ? "chaque année à la date anniversaire" : `chaque mois${day}`;
      lines.push(
        subscriptionOnly
          ? `- ${s.description} : ${formatEUR(s.unitPriceCents)} facturés ${yearly(s) ? "chaque année" : "chaque mois"} à partir de la signature, sans acompte.`
          : `- ${s.description} : ${formatEUR(s.unitPriceCents)} facturés ${when}. La 1re échéance est incluse dans ce document.`,
      );
    }
    lines.push("");
    lines.push(
      subscriptionOnly
        ? "Après votre signature, chaque échéance fera l'objet d'une facture, envoyée automatiquement."
        : "Les échéances suivantes feront l'objet de factures séparées, envoyées automatiquement.",
    );
    lines.push("");
  }

  lines.push("Le PDF est joint à ce message.");
  lines.push("");
  lines.push("Cordialement,");
  lines.push(companyName);

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
