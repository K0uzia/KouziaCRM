import type { ClientProject } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";

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
  steps: z.array(stepSchema).max(30).default([]),
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

export function serializeProject(p: ClientProject) {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    progress: p.progress,
    steps: parseList(p.steps, stepSchema),
    links: parseList(p.links, linkSchema),
    checklist: parseList(p.checklist, checklistItemSchema),
    visibleOnPortal: p.visibleOnPortal,
    position: p.position,
    quoteId: p.quoteId,
    status: p.status,
    startedAt: p.startedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toData(input: ProjectInput) {
  return {
    name: input.name,
    progress: input.progress,
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
  return projects.map(serializeProject);
}

export async function createClientProject(clientId: string, input: ProjectInput) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new ProjectError("Client introuvable", 404);
  const last = await prisma.clientProject.findFirst({
    where: { clientId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const created = await prisma.clientProject.create({
    data: { clientId, position: (last?.position ?? -1) + 1, ...toData(input) },
  });
  return serializeProject(created);
}

export async function updateClientProject(id: string, input: ProjectInput) {
  const existing = await prisma.clientProject.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new ProjectError("Projet introuvable", 404);
  const updated = await prisma.clientProject.update({ where: { id }, data: toData(input) });
  return serializeProject(updated);
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
