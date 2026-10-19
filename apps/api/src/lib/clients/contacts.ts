import { z } from "zod";
import type { ClientContact, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encryptOptional } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

/** Libellé d'un contact sans nom (pro connu par son seul e-mail ou téléphone). */
export const UNNAMED_PRIMARY_ROLE = "Contact principal";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => v || null);

export const contactInputSchema = z
  .object({
    firstName: optionalText(80),
    lastName: optionalText(80),
    role: optionalText(80),
    email: z
      .string()
      .trim()
      .max(254)
      .optional()
      .nullable()
      .transform((v) => v?.toLowerCase() || null)
      .refine((v) => v === null || z.email().safeParse(v).success, "Adresse e-mail invalide"),
    phone: optionalText(40),
  })
  .refine((c) => c.firstName || c.lastName || c.email || c.phone, {
    message: "Un nom, un e-mail ou un téléphone au moins",
    path: ["lastName"],
  });

export type ContactInput = z.infer<typeof contactInputSchema>;

export function serializeContact(c: ClientContact) {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    role: c.role,
    email: decryptOptional(c.emailEncrypted),
    phone: decryptOptional(c.phoneEncrypted),
    isPrimary: c.isPrimary,
    position: c.position,
  };
}

export async function listContacts(clientId: string) {
  const rows = await prisma.clientContact.findMany({ where: { clientId }, orderBy: [{ isPrimary: "desc" }, { position: "asc" }, { createdAt: "asc" }] });
  return rows.map(serializeContact);
}

/** Erreur métier rendue en 409 par la route (adresse déjà prise, contact principal non supprimable). */
export class ContactConflictError extends Error {
  constructor(
    message: string,
    readonly code: "email_taken" | "primary_required",
  ) {
    super(message);
    this.name = "ContactConflictError";
  }
}

type Tx = Prisma.TransactionClient;

/**
 * Fiche → contact principal, après toute écriture de Client.email, phone, firstName ou lastName (formulaire,
 * invitation /nouveau-client). Sans contact principal : créé s'il y a un nom, un e-mail ou un téléphone, avec le
 * libellé « Contact principal » s'il n'a pas de nom. Le chiffré est recopié tel quel (même texte au déchiffrement).
 */
export async function syncPrimaryContact(clientId: string, tx: Tx = prisma): Promise<void> {
  const client = await tx.client.findUnique({
    where: { id: clientId },
    select: { firstName: true, lastName: true, emailEncrypted: true, emailHash: true, phoneEncrypted: true },
  });
  if (!client) return;
  const data = {
    firstName: client.firstName?.trim() || null,
    lastName: client.lastName?.trim() || null,
    emailEncrypted: client.emailEncrypted,
    emailHash: client.emailHash ?? computeEmailHash(decryptOptional(client.emailEncrypted)),
    phoneEncrypted: client.phoneEncrypted,
  };
  const primary = await tx.clientContact.findFirst({ where: { clientId, isPrimary: true } });
  if (primary) {
    await tx.clientContact.update({ where: { id: primary.id }, data });
    return;
  }
  if (!data.firstName && !data.lastName && !data.emailEncrypted && !data.phoneEncrypted) return;
  await tx.clientContact.create({
    data: { clientId, ...data, role: data.firstName || data.lastName ? null : UNNAMED_PRIMARY_ROLE, isPrimary: true, position: 0 },
  });
}

/**
 * Contact principal → fiche : ses coordonnées deviennent celles du client (espace client, /suivi). Une adresse
 * déjà portée par une autre fiche est refusée (Client.emailHash est unique). Particulier : le nom affiché suit.
 */
async function applyPrimaryToClient(tx: Tx, clientId: string, contact: ClientContact): Promise<void> {
  if (contact.emailHash) {
    const other = await tx.client.findFirst({ where: { emailHash: contact.emailHash, id: { not: clientId } }, select: { displayName: true } });
    if (other) throw new ContactConflictError(`Adresse déjà utilisée par la fiche « ${other.displayName} ».`, "email_taken");
  }
  const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { type: true, displayName: true } });
  const personName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  await tx.client.update({
    where: { id: clientId },
    data: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      emailEncrypted: contact.emailEncrypted,
      emailHash: contact.emailHash,
      phoneEncrypted: contact.phoneEncrypted,
      ...(client.type === "B2C" && personName ? { displayName: personName } : {}),
    },
  });
}

function contactData(input: ContactInput) {
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role,
    emailEncrypted: encryptOptional(input.email),
    emailHash: computeEmailHash(input.email),
    phoneEncrypted: encryptOptional(input.phone),
  };
}

export async function createContact(clientId: string, input: ContactInput, opts: { primary?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    const count = await tx.clientContact.count({ where: { clientId } });
    const hasPrimary = (await tx.clientContact.count({ where: { clientId, isPrimary: true } })) > 0;
    // Premier contact d'une fiche : principal d'office (la fiche garde toujours un principal dès qu'elle a des contacts).
    const primary = opts.primary || !hasPrimary;
    if (primary) await tx.clientContact.updateMany({ where: { clientId, isPrimary: true }, data: { isPrimary: false } });
    const created = await tx.clientContact.create({ data: { clientId, ...contactData(input), isPrimary: primary, position: count } });
    if (primary) await applyPrimaryToClient(tx, clientId, created);
    return serializeContact(created);
  });
}

export async function updateContact(clientId: string, contactId: string, input: ContactInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.clientContact.findFirst({ where: { id: contactId, clientId } });
    if (!existing) return null;
    const updated = await tx.clientContact.update({ where: { id: contactId }, data: contactData(input) });
    if (updated.isPrimary) await applyPrimaryToClient(tx, clientId, updated);
    return serializeContact(updated);
  });
}

/** Le contact principal ne se supprime pas : en désigner un autre d'abord (la fiche garderait des coordonnées orphelines). */
export async function deleteContact(clientId: string, contactId: string): Promise<boolean> {
  const existing = await prisma.clientContact.findFirst({ where: { id: contactId, clientId } });
  if (!existing) return false;
  if (existing.isPrimary) {
    throw new ContactConflictError("Contact principal : désignez d'abord un autre contact principal.", "primary_required");
  }
  await prisma.clientContact.delete({ where: { id: contactId } });
  return true;
}

/** Un seul principal par client : bascule et recopie vers la fiche dans la même transaction. */
export async function makePrimary(clientId: string, contactId: string) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.clientContact.findFirst({ where: { id: contactId, clientId } });
    if (!target) return null;
    await tx.clientContact.updateMany({ where: { clientId, isPrimary: true, id: { not: contactId } }, data: { isPrimary: false } });
    const updated = await tx.clientContact.update({ where: { id: contactId }, data: { isPrimary: true } });
    await applyPrimaryToClient(tx, clientId, updated);
    return serializeContact(updated);
  });
}

/**
 * Client d'une adresse portée par un contact (messagerie, formulaire du site), après Client.emailHash. Adresse
 * partagée par plusieurs clients (standard commun) : aucun rattachement plutôt qu'un rattachement au hasard.
 */
export async function findClientIdByContactEmail(hash: string): Promise<string | null> {
  const rows = await prisma.clientContact.findMany({ where: { emailHash: hash }, select: { clientId: true } });
  const ids = new Set(rows.map((r) => r.clientId));
  return ids.size === 1 ? [...ids][0]! : null;
}
