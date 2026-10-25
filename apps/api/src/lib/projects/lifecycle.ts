import { prisma } from "@/lib/prisma.js";
import { BILLABLE_LINES_WHERE } from "@/lib/quotes/quote-options.js";

/**
 * Parcours d'un projet né d'un devis :
 * devis validé → acompte facturé (projet créé, PLANNED) → acompte payé (ACTIVE, démarrage)
 * → réalisation → livraison.
 */
type Step = { label: string; status: "done" | "current" | "todo"; date: string | null };

export const PROJECT_STEPS = ["Devis validé", "Acompte facturé", "Acompte payé", "Réalisation", "Livraison"] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function progressOf(steps: Step[]): number {
  return Math.round((steps.filter((s) => s.status === "done").length / steps.length) * 100);
}

/** Toutes les étapes jusqu'à `doneUntil` (incluse) faites, la suivante en cours. */
function stepsUpTo(doneUntil: number, dates: Record<number, string | null>, previous?: Step[]): Step[] {
  return PROJECT_STEPS.map((label, i) => {
    const prev = previous?.find((p) => p.label === label);
    if (i <= doneUntil) return { label, status: "done", date: prev?.date ?? dates[i] ?? today() };
    if (i === doneUntil + 1) return { label, status: "current", date: null };
    return { label, status: "todo", date: null };
  });
}

function parseSteps(raw: string): Step[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Step[]) : [];
  } catch {
    return [];
  }
}

/** Nom du projet : première désignation du devis (avant « : »), sinon son numéro. */
function projectName(quote: { number: string | null; lines: Array<{ description: string }> }): string {
  const first = quote.lines[0]?.description?.split(" : ")[0]?.trim();
  return (first && first.length <= 120 ? first : null) ?? `Projet ${quote.number ?? ""}`.trim();
}

/** Crée (ou fait avancer) le projet du devis au moment où sa facture d'acompte ou totale est générée. */
export async function ensureProjectForQuote(quoteId: string) {
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      number: true,
      clientId: true,
      quoteDecidedAt: true,
      lines: { where: BILLABLE_LINES_WHERE, orderBy: { position: "asc" }, take: 1, select: { description: true } },
      project: true,
    },
  });
  if (!quote) return null;
  const decided = quote.quoteDecidedAt ? quote.quoteDecidedAt.toISOString().slice(0, 10) : null;

  if (quote.project) {
    const prev = parseSteps(quote.project.steps);
    const alreadyFurther = prev.some((s) => s.label === "Acompte facturé" && s.status === "done");
    if (alreadyFurther) return quote.project;
    const steps = stepsUpTo(1, { 0: decided }, prev);
    return prisma.clientProject.update({
      where: { id: quote.project.id },
      data: { steps: JSON.stringify(steps), progress: progressOf(steps) },
    });
  }

  const last = await prisma.clientProject.findFirst({
    where: { clientId: quote.clientId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const steps = stepsUpTo(1, { 0: decided });
  return prisma.clientProject.create({
    data: {
      clientId: quote.clientId,
      quoteId: quote.id,
      name: projectName(quote),
      status: "PLANNED",
      steps: JSON.stringify(steps),
      progress: progressOf(steps),
      position: (last?.position ?? -1) + 1,
    },
  });
}

/** Acompte encaissé : le projet démarre (statut ACTIVE, étape Réalisation en cours). */
export async function startProjectForQuote(quoteId: string) {
  const project = (await prisma.clientProject.findUnique({ where: { quoteId } })) ?? (await ensureProjectForQuote(quoteId));
  if (!project) return null;
  if (project.status !== "PLANNED") return project;
  const steps = stepsUpTo(2, {}, parseSteps(project.steps));
  return prisma.clientProject.update({
    where: { id: project.id },
    data: { status: "ACTIVE", startedAt: new Date(), steps: JSON.stringify(steps), progress: progressOf(steps) },
  });
}

/** Facture payée : si elle vient d'un devis (acompte ou totale), le projet démarre. */
export async function onInvoicePaidForProject(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { quoteId: true, sourceQuoteId: true, invoiceType: true },
  });
  const quoteId = invoice?.quoteId ?? invoice?.sourceQuoteId;
  if (!quoteId || invoice?.invoiceType === "SOLDE") return null;
  return startProjectForQuote(quoteId);
}
