import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

/**
 * Besoins d'un client : prestations du catalogue (case « traité » datée) et « Précisions » en texte libre.
 * L'ancien format (Client.needs, JSON de libellés) n'est plus écrit : lu par la reprise et l'export seulement.
 */
export const MAX_NEEDS = 50;
export const MAX_NEEDS_DETAILS = 5000;

export type ClientNeed = { id: string; label: string; done: boolean };

export const needInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  label: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1, "Besoin vide")
        .max(200, "Besoin trop long (200 caractères au plus)")
        // eslint-disable-next-line no-control-regex
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Caractères non autorisés"),
    ),
  done: z.boolean().optional().default(false),
});

/** Ancien format : accepté encore à la création (fiche préparée hors ligne avant la mise à jour). */
export const needsInputSchema = z
  .array(needInputSchema)
  .max(MAX_NEEDS, `${MAX_NEEDS} besoins au plus`);

/** Identifiant attribué côté serveur s'il manque ; l'ordre du tableau est l'ordre affiché. */
export function normalizeNeeds(input: z.output<typeof needsInputSchema>): ClientNeed[] {
  return input.map((n) => ({ id: n.id ?? randomUUID(), label: n.label, done: n.done }));
}

/** Lecture tolérante de la colonne JSON (valeur absente ou abîmée : liste vide). */
export function parseNeeds(raw: string | null | undefined): ClientNeed[] {
  if (!raw) return [];
  try {
    const parsed = needsInputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? normalizeNeeds(parsed.data) : [];
  } catch {
    return [];
  }
}

/** Anciens besoins en « Précisions » : un par ligne, « (traité) » s'il était coché. */
export function legacyNeedsToDetails(needs: ClientNeed[]): string {
  return needs.map((n) => `- ${n.label}${n.done ? " (traité)" : ""}`).join("\n");
}

export const needsDetailsSchema = z
  .string()
  .max(MAX_NEEDS_DETAILS, `Précisions trop longues (${MAX_NEEDS_DETAILS} caractères au plus)`)
  .transform((s) => s.replace(/\r\n?/g, "\n").trim())
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s), "Caractères non autorisés");

export const serviceNeedsInputSchema = z.object({
  services: z
    .array(z.object({ serviceId: z.string().trim().min(1).max(64), done: z.boolean().optional().default(false) }))
    .max(MAX_NEEDS, `${MAX_NEEDS} besoins au plus`)
    .refine((list) => new Set(list.map((s) => s.serviceId)).size === list.length, "Prestation en double"),
  details: needsDetailsSchema.optional(),
});

export type ServiceNeedView = {
  serviceId: string;
  name: string;
  active: boolean;
  doneAt: Date | null;
  createdAt: Date;
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Relation à inclure pour serializeServiceNeeds (liste et fiche). */
export const serviceNeedsInclude = {
  orderBy: { createdAt: "asc" },
  include: { service: { select: { name: true, active: true } } },
} satisfies Prisma.Client$serviceNeedsArgs;

export function serializeServiceNeeds(
  rows: Array<{ serviceId: string; doneAt: Date | null; createdAt: Date; service: { name: string; active: boolean } }>,
): ServiceNeedView[] {
  return rows.map((r) => ({ serviceId: r.serviceId, name: r.service.name, active: r.service.active, doneAt: r.doneAt, createdAt: r.createdAt }));
}

export class ServiceNeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceNeedError";
  }
}

/**
 * Remplace les besoins du client par la liste reçue. Une prestation déjà notée garde sa date d'ajout et sa date
 * « traité » ; une prestation archivée ne peut pas être ajoutée, mais celle déjà notée reste (skipUnavailable : création,
 * peut-être préparée hors ligne avant l'archivage, la prestation est ignorée au lieu d'être refusée). Précisions absentes :
 * inchangées ; vides : "" (jamais null, qui veut dire « jamais repris »).
 */
export async function writeServiceNeeds(
  clientId: string,
  input: z.output<typeof serviceNeedsInputSchema>,
  db: Db,
  opts: { skipUnavailable?: boolean; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const existing = await db.clientServiceNeed.findMany({ where: { clientId } });
  const byId = new Map(existing.map((n) => [n.serviceId, n]));
  const added = input.services.filter((s) => !byId.has(s.serviceId)).map((s) => s.serviceId);
  let wanted = input.services;
  if (added.length) {
    const services = await db.service.findMany({ where: { id: { in: added } }, select: { id: true, name: true, active: true } });
    const usable = new Set(services.filter((s) => s.active).map((s) => s.id));
    if (opts.skipUnavailable) wanted = wanted.filter((s) => byId.has(s.serviceId) || usable.has(s.serviceId));
    else if (services.length !== added.length) throw new ServiceNeedError("Prestation introuvable");
    else {
      const archived = services.find((s) => !s.active);
      if (archived) throw new ServiceNeedError(`Prestation archivée : « ${archived.name} » ne peut plus être ajoutée`);
    }
  }
  const kept = new Set(wanted.map((s) => s.serviceId));
  await db.clientServiceNeed.deleteMany({ where: { clientId, serviceId: { notIn: [...kept] } } });
  for (const s of wanted) {
    const prev = byId.get(s.serviceId);
    const doneAt = s.done ? (prev?.doneAt ?? now) : null;
    if (!prev) await db.clientServiceNeed.create({ data: { clientId, serviceId: s.serviceId, doneAt } });
    else if ((prev.doneAt?.getTime() ?? null) !== (doneAt?.getTime() ?? null)) {
      await db.clientServiceNeed.update({ where: { clientId_serviceId: { clientId, serviceId: s.serviceId } }, data: { doneAt } });
    }
  }
  if (input.details !== undefined) await db.client.update({ where: { id: clientId }, data: { needsDetails: input.details } });
}

export async function readServiceNeeds(clientId: string, db: Db = prisma) {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { needsDetails: true, serviceNeeds: serviceNeedsInclude },
  });
  if (!client) return null;
  return { services: serializeServiceNeeds(client.serviceNeeds), details: client.needsDetails ?? "" };
}
