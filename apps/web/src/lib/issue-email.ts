import { formatEUR } from "@/lib/api";

type IssueEmailDoc = {
  client: { displayName: string; email?: string | null };
  totalCents: number;
  lines?: Array<{
    description: string;
    isSubscription?: boolean;
    billingDay?: number | null;
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

  const lines: string[] = [
    firstName ? `Bonjour ${firstName},` : "Bonjour,",
    "",
    `Veuillez trouver ci-joint votre ${label} {{numero}}, d'un montant de ${formatEUR(doc.totalCents)} HT.`,
    "",
  ];

  if (subs.length > 0) {
    lines.push("Ce document inclut un engagement d'abonnement mensuel :");
    lines.push("");
    for (const s of subs) {
      const day = s.billingDay ? ` le ${s.billingDay}` : "";
      lines.push(
        `- ${s.description} : ${formatEUR(s.unitPriceCents)} HT facturés chaque mois${day}. La 1re échéance est incluse dans ce document.`,
      );
    }
    lines.push("");
    lines.push(
      "Les échéances suivantes feront l'objet de factures séparées, envoyées automatiquement.",
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

export type { IssueEmailDoc };
