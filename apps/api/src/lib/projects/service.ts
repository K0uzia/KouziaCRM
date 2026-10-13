import { MilestoneStatus, type ClientProject } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { sendReviewInviteOnDone } from "@/lib/projects/review-invite.js";

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith("https://"), "Le lien doit être en https://");

const stepSchema = z.object({
  label: z.string().trim().min(1).max(120),
  status: z.enum(["done", "current", "todo"]),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .transform((v) => v || null),
  /** Paiement en 3 fois : cette étape, une fois faite, rend le 2e acompte exigible. */
  triggersDeposit2: z
    .boolean()
    .optional()
    .transform((v) => (v ? true : undefined)),
});

const linkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: httpsUrl,
});

const checklistItemSchema = z.object({
  label: z.string().trim().min(1).max(160),
  done: z.boolean(),
  note: z
    .string()
    .trim()
    .max(240)
    .nullish()
    .transform((v) => v || null),
});

export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  progress: z.number().int().min(0).max(100),
  steps: z
    .array(stepSchema)
    .max(30)
    .default([])
    .refine((steps) => steps.filter((s) => s.triggersDeposit2).length <= 1, {
      message: "Une seule étape peut déclencher le 2e acompte.",
    }),
  links: z.array(linkSchema).max(20).default([]),
  checklist: z.array(checklistItemSchema).max(50).default([]),
  visibleOnPortal: z.boolean().default(true),
  status: z.enum(["PLANNED", "ACTIVE", "DONE"]).optional(),
});

export type ProjectInput = z.infer<typeof projectInputSchema>;
export type ProjectStep = z.infer<typeof stepSchema>;
export type ProjectLink = z.infer<typeof linkSchema>;
export type ProjectChecklistItem = z.infer<typeof checklistItemSchema>;

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

/** Relit une liste JSON stockée ; une valeur corrompue donne une liste vide plutôt qu'une erreur. */
function parseList<T>(raw: string, schema: z.ZodType<T>): T[] {
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Projet terminé = livré : la jauge affiche 100 %, quelle que soit la valeur saisie avant.
 * Les étapes ne sont pas cochées d'office (une étape faite peut rendre le 2e acompte exigible).
 */
const progressOf = (status: string, progress: number) => (status === "DONE" ? 100 : progress);

export function serializeProject(p: ClientProject) {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    progress: progressOf(p.status, p.progress),
    steps: parseList(p.steps, stepSchema),
    links: parseList(p.links, linkSchema),
    checklist: parseList(p.checklist, checklistItemSchema),
    visibleOnPortal: p.visibleOnPortal,
    position: p.position,
    quoteId: p.quoteId,
    status: p.status,
    startedAt: p.startedAt,
    reviewInviteSentAt: p.reviewInviteSentAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toData(input: ProjectInput) {
  return {
    name: input.name,
    progress: input.status ? progressOf(input.status, input.progress) : input.progress,
    steps: JSON.stringify(input.steps),
    links: JSON.stringify(input.links),
    checklist: JSON.stringify(input.checklist),
    visibleOnPortal: input.visibleOnPortal,
    ...(input.status ? { status: input.status } : {}),
  };
}

export async function listClientProjects(clientId: string) {
  const projects = await prisma.clientProject.findMany({
    where: { clientId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return Promise.all(projects.map(serializeAdminProject));
}

/** Fiche admin : état du 2e acompte (case « Déclenche le 2e acompte » et alerte sans étape). */
async function serializeAdminProject(p: ClientProject) {
  const s = serializeProject(p);
  const trigger = await depositTriggerState(p.quoteId);
  return {
    ...s,
    deposit2: trigger.eligible
      ? { locked: trigger.locked, missingStep: !s.steps.some((step) => step.triggersDeposit2) }
      : null,
  };
}

/**
 * 2e acompte du paiement en 3 fois, rattaché au projet par son devis d'origine.
 * eligible : le devis a été accepté en 3 fois ; locked : le jalon n'est plus en attente.
 */
async function deposit2Of(quoteId: string | null) {
  if (!quoteId) return null;
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { paymentPlan: true, milestones: { where: { position: 2 } } },
  });
  if (quote?.paymentPlan !== "THREE") return null;
  return quote.milestones[0] ?? null;
}

export async function depositTriggerState(quoteId: string | null) {
  const m = await deposit2Of(quoteId);
  return { eligible: Boolean(m), locked: Boolean(m && m.status !== MilestoneStatus.PENDING) };
}

const flaggedStep = (steps: ProjectStep[]) => steps.find((s) => s.triggersDeposit2) ?? null;

/**
 * Contrôle l'étape déclencheuse, puis rend le 2e acompte exigible si elle est faite.
 * Jamais de facture émise ici : la facture reste une action humaine (fiche devis, « Facturer »).
 * Le jalon ne revient pas en attente si l'étape repasse « à faire » (pas d'oscillation).
 */
async function applyDepositTrigger(quoteId: string | null, before: ProjectStep[], after: ProjectStep[]) {
  const next = flaggedStep(after);
  const m = await deposit2Of(quoteId);
  if (!m) {
    if (next) throw new ProjectError("Ce projet ne vient pas d'un devis accepté en 3 fois.", 400);
    return;
  }
  if (m.status !== MilestoneStatus.PENDING) {
    const prev = flaggedStep(before);
    if (prev && next?.label !== prev.label) {
      throw new ProjectError(
        "Le 2e acompte est déjà exigible : l'étape qui l'a déclenché ne peut plus être changée.",
        409,
      );
    }
    return;
  }
  if (next?.status === "done") {
    await prisma.paymentMilestone.update({
      where: { id: m.id },
      data: {
        status: MilestoneStatus.DUE,
        dueDate: new Date(),
        triggerStepLabel: next.label,
        triggeredAt: new Date(),
      },
    });
  }
}

export async function createClientProject(clientId: string, input: ProjectInput) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new ProjectError("Client introuvable", 404);
  const last = await prisma.clientProject.findFirst({
    where: { clientId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  if (flaggedStep(input.steps)) {
    throw new ProjectError("Ce projet ne vient pas d'un devis accepté en 3 fois.", 400);
  }
  const created = await prisma.clientProject.create({
    data: { clientId, position: (last?.position ?? -1) + 1, ...toData(input) },
  });
  return serializeProject(created);
}

export async function updateClientProject(id: string, input: ProjectInput) {
  const existing = await prisma.clientProject.findUnique({ where: { id } });
  if (!existing) throw new ProjectError("Projet introuvable", 404);
  await applyDepositTrigger(existing.quoteId, parseList(existing.steps, stepSchema), input.steps);
  const updated = await prisma.clientProject.update({ where: { id }, data: toData(input) });
  if (existing.status !== "DONE" && updated.status === "DONE") {
    // L'invitation ne bloque jamais l'enregistrement du projet.
    const sent = await sendReviewInviteOnDone(id).catch((err) => {
      console.error(`[projets] invitation à laisser un avis : ${id}`, err);
      return false;
    });
    if (sent) return serializeAdminProject((await prisma.clientProject.findUnique({ where: { id } })) ?? updated);
  }
  return serializeAdminProject(updated);
}

export async function deleteClientProject(id: string) {
  const existing = await prisma.clientProject.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new ProjectError("Projet introuvable", 404);
  await prisma.clientProject.delete({ where: { id } });
}

/** Format attendu par la page /suivi du site (champ `projects` de /api/public/tracking). */
export async function listPortalProjects(clientId: string) {
  const projects = await prisma.clientProject.findMany({
    where: { clientId, visibleOnPortal: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return projects.map((p) => {
    const s = serializeProject(p);
    return {
      name: s.name,
      progress: s.progress,
      steps: s.steps,
      links: s.links,
      checklist: s.checklist,
    };
  });
}
