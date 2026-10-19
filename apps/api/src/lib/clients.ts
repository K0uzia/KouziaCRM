import { z } from "zod";
import { ClientType } from "@prisma/client";
import { CLIENT_TYPES, isOrganization } from "@/lib/clients/client-type.js";
import { isValidSiren, isValidSiret } from "@kouzia/forms";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encrypt, encryptOptional } from "@/lib/crypto.js";
import { allocateClientNumber } from "@/lib/clients/numbering.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { syncPrimaryContact } from "@/lib/clients/contacts.js";
import {
  legacyNeedsToDetails,
  MAX_NEEDS,
  needsDetailsSchema,
  needsInputSchema,
  normalizeNeeds,
  serializeServiceNeeds,
  serviceNeedsInclude,
  writeServiceNeeds,
} from "@/lib/clients/needs.js";
import {
  type AddressErrorCode,
  type AddressSuggestion,
  type CompanyErrorCode,
  normalizeFrenchAddress,
  type NormalizedAddress,
  verifyCompanyIdentifiers,
} from "@/lib/address/france.js";

export const clientInputSchema = z
  .object({
    type: z.enum(CLIENT_TYPES),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
    email: z.string().email().optional().nullable().or(z.literal("")),
    phone: z.string().optional().nullable(),
    siret: z
      .string()
      .optional()
      .nullable()
      .refine((v) => !v || isValidSiret(v.replace(/\s/g, "")), {
        message: "SIRET invalide (14 chiffres, Luhn)",
      }),
    siren: z
      .string()
      .optional()
      .nullable()
      .refine((v) => !v || isValidSiren(v.replace(/\s/g, "")), {
        message: "SIREN invalide (9 chiffres, Luhn)",
      }),
    apeCode: z.string().optional().nullable(),
    addressLine1: z.string().optional().nullable(),
    addressLine2: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    addressCityCode: z.string().optional().nullable(),
    addressLat: z.number().optional().nullable(),
    addressLon: z.number().optional().nullable(),
    addressManualConfirmed: z.boolean().optional(),
    companyVerifiedAt: z.string().datetime().optional().nullable(),
    notes: z.string().optional().nullable(),
    /** Jour de prélèvement par défaut de ses abonnements (1 à 28) ; null = le 1er. Absent : inchangé. */
    billingDay: z.coerce.number().int().min(1).max(28).optional().nullable(),
    /** Création seulement : prestations du catalogue notées comme besoins, et leurs « Précisions ». */
    serviceNeeds: z.array(z.string().trim().min(1).max(64)).max(MAX_NEEDS).optional(),
    needsDetails: needsDetailsSchema.optional(),
    /** Ancien format (fiche préparée hors ligne avant la mise à jour) : repris dans les Précisions. */
    needs: needsInputSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (isOrganization(data.type) && !data.companyName?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: data.type === "ASSOCIATION" ? "Nom de l'association requis" : "Raison sociale requise pour B2B",
        path: ["companyName"],
      });
    }
    if (data.type === "B2C" && !data.lastName?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Nom requis pour B2C",
        path: ["lastName"],
      });
    }
  });

export type ClientInput = z.infer<typeof clientInputSchema>;

export function buildDisplayName(data: ClientInput): string {
  if (isOrganization(data.type)) {
    return data.companyName!.trim();
  }
  return [data.firstName?.trim(), data.lastName?.trim()].filter(Boolean).join(" ");
}

export function serializeClient(client: {
  id: string;
  clientNumber: string | null;
  type: ClientType;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  emailEncrypted: string | null;
  phoneEncrypted: string | null;
  siretEncrypted: string | null;
  sirenEncrypted: string | null;
  apeCode: string | null;
  companyVerifiedAt: Date | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  addressCityCode: string | null;
  addressLat: number | null;
  addressLon: number | null;
  notes: string | null;
  notepadUpdatedAt?: Date | null;
  billingDay: number | null;
  needsDetails?: string | null;
  serviceNeeds?: Parameters<typeof serializeServiceNeeds>[0];
  onboardingCompletedAt: Date | null;
  accessEmailSentAt: Date | null;
  emailVerifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: client.id,
    clientNumber: client.clientNumber,
    type: client.type,
    displayName: client.displayName,
    firstName: client.firstName,
    lastName: client.lastName,
    companyName: client.companyName,
    email: decryptOptional(client.emailEncrypted),
    phone: decryptOptional(client.phoneEncrypted),
    siret: decryptOptional(client.siretEncrypted),
    siren: decryptOptional(client.sirenEncrypted),
    apeCode: client.apeCode,
    companyVerifiedAt: client.companyVerifiedAt,
    addressLine1: client.addressLine1,
    addressLine2: client.addressLine2,
    postalCode: client.postalCode,
    city: client.city,
    country: client.country,
    addressCityCode: client.addressCityCode,
    addressLat: client.addressLat,
    addressLon: client.addressLon,
    notes: client.notes,
    /** Dernier enregistrement du bloc-notes : la copie hors ligne le compare, la date de la fiche n'en dépend pas. */
    notepadUpdatedAt: client.notepadUpdatedAt ?? null,
    billingDay: client.billingDay ?? null,
    needsDetails: client.needsDetails ?? "",
    ...(client.serviceNeeds ? { serviceNeeds: serializeServiceNeeds(client.serviceNeeds) } : {}),
    emailVerifiedAt: client.emailVerifiedAt ?? null,
    onboardingCompletedAt: client.onboardingCompletedAt,
    accessEmailSentAt: client.accessEmailSentAt,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

/**
 * addressUnchanged : « Modifier » où l'adresse envoyée est celle déjà enregistrée ; elle est reprise telle quelle,
 * sans nouvelle vérification (un autre champ modifié ne doit jamais réécrire l'adresse).
 */
export async function toPrismaClientData(data: ClientInput, opts: { addressUnchanged?: boolean } = {}) {
  const addr = opts.addressUnchanged
    ? {
        ok: true as const,
        address: {
          addressLine1: data.addressLine1?.trim() || null,
          postalCode: data.postalCode?.trim() || null,
          city: data.city?.trim() || null,
          addressCityCode: data.addressCityCode?.trim() || null,
          addressLat: data.addressLat ?? null,
          addressLon: data.addressLon ?? null,
          manual: Boolean(data.addressManualConfirmed),
          unavailable: false,
        },
      }
    : await normalizeFrenchAddressForClient(data);
  if (!addr.ok) {
    throw new AddressValidationError(addr.error);
  }
  return toPrismaClientFields(data, addr.address);
}

function normalizeFrenchAddressForClient(data: ClientInput) {
  return normalizeFrenchAddress({
    addressLine1: data.addressLine1,
    postalCode: data.postalCode,
    city: data.city,
    country: data.country,
    addressCityCode: data.addressCityCode,
    addressLat: data.addressLat,
    addressLon: data.addressLon,
    addressManualConfirmed: data.addressManualConfirmed,
  }, { rejectOtherStreet: true });
}

async function toPrismaClientFields(data: ClientInput, address: NormalizedAddress) {
  const addr = { address };
  let siren = data.siren?.replace(/\s/g, "") || null;
  let siret = data.siret?.replace(/\s/g, "") || null;
  let apeCode = data.apeCode?.trim() || null;
  let companyName = data.companyName?.trim() || null;
  let companyVerifiedAt: Date | null = data.companyVerifiedAt
    ? new Date(data.companyVerifiedAt)
    : null;

  if (isOrganization(data.type) && (siren || siret)) {
    const verified = await verifyCompanyIdentifiers({
      siren,
      siret,
      companyName,
      apeCode,
    });
    if (!verified.ok) {
      throw new AddressValidationError(verified.error, { code: verified.code });
    }
    siren = verified.data.siren;
    siret = verified.data.siret;
    apeCode = verified.data.apeCode;
    companyName = verified.data.companyName;
    companyVerifiedAt = verified.data.companyVerifiedAt;
  }

  return {
    type: data.type as ClientType,
    displayName: buildDisplayName({ ...data, companyName }),
    firstName: data.firstName?.trim() || null,
    lastName: data.lastName?.trim() || null,
    companyName,
    emailEncrypted: encryptOptional(data.email || null),
    emailHash: computeEmailHash(data.email || null),
    phoneEncrypted: encryptOptional(data.phone || null),
    siretEncrypted: encryptOptional(siret),
    sirenEncrypted: encryptOptional(siren),
    apeCode,
    companyVerifiedAt,
    addressLine1: addr.address.addressLine1,
    addressLine2: data.addressLine2?.trim() || null,
    postalCode: addr.address.postalCode,
    city: addr.address.city,
    country: data.country?.trim() || "FRANCE",
    addressCityCode: addr.address.addressCityCode,
    addressLat: addr.address.addressLat,
    addressLon: addr.address.addressLon,
    ...(data.billingDay !== undefined ? { billingDay: data.billingDay } : {}),
  };
}

export class AddressValidationError extends Error {
  constructor(
    message: string,
    /** Refus d'adresse détaillé (code, proposition de la base nationale) : renvoyé par l'API publique. */
    readonly detail: { code?: AddressErrorCode | CompanyErrorCode; suggestion?: AddressSuggestion } = {},
  ) {
    super(message);
    this.name = "AddressValidationError";
  }
}

/**
 * Crée la fiche (numéro attribué). L'accès à l'espace client s'envoie à part (sendPortalWelcomeEmail).
 * clientRequestId : UUID de l'appareil (création préparée hors ligne), unique en base.
 */
export async function createClientRecord(data: ClientInput, clientRequestId: string | null = null) {
  const prepared = await toPrismaClientData(data);
  // Ancien champ « Notes internes » (client préparé hors ligne par un appareil pas encore mis à jour) : il ouvre le
  // bloc-notes. En modification, il est ignoré : le bloc-notes s'écrit par sa propre route.
  const notes = data.notes?.trim();
  const notepad = notes ? { notepadEncrypted: encrypt(notes), notepadVersion: 1, notepadUpdatedAt: new Date() } : {};
  // Numéro et fiche dans la même transaction : un doublon refusé (P2002) ne consomme pas de numéro.
  const client = await prisma.$transaction(async (tx) => {
    const created = await tx.client.create({
      data: {
        ...prepared,
        ...notepad,
        clientNumber: await allocateClientNumber(tx),
        ...(clientRequestId ? { clientRequestId } : {}),
      },
    });
    await syncPrimaryContact(created.id, tx);
    const legacy = data.needs?.length ? legacyNeedsToDetails(normalizeNeeds(data.needs)) : "";
    const details = [data.needsDetails ?? "", legacy].filter(Boolean).join("\n");
    if (data.serviceNeeds?.length || details) {
      await writeServiceNeeds(
        created.id,
        { services: [...new Set(data.serviceNeeds ?? [])].map((serviceId) => ({ serviceId, done: false })), details },
        tx,
        { skipUnavailable: true },
      );
    }
    return tx.client.findUniqueOrThrow({ where: { id: created.id }, include: { serviceNeeds: serviceNeedsInclude } });
  });
  return { client: serializeClient(client) };
}

export async function listClients(opts: { hasCorrespondence?: boolean } = {}) {
  const clients = await prisma.client.findMany({
    orderBy: { displayName: "asc" },
    include: { serviceNeeds: serviceNeedsInclude },
  });

  const threadAgg = await prisma.emailThread.groupBy({
    by: ["clientId"],
    where: { clientId: { not: null } },
    _max: { lastMessageAt: true },
  });
  const threadByClient = new Map(
    threadAgg
      .filter((t) => t.clientId)
      .map((t) => [t.clientId!, t._max.lastMessageAt]),
  );

  const clientIdsWithThreads = new Set(threadByClient.keys());

  const latestThreads = await prisma.emailThread.findMany({
    where: { clientId: { in: [...clientIdsWithThreads] } },
    orderBy: { lastMessageAt: "desc" },
    distinct: ["clientId"],
    select: { clientId: true, id: true, subject: true, lastMessageAt: true },
  });
  const latestByClient = new Map(
    latestThreads.filter((t) => t.clientId).map((t) => [t.clientId!, t]),
  );

  let rows = clients.map((client) => {
    const lastThread = latestByClient.get(client.id);
    return {
      ...serializeClient(client),
      lastExchange: lastThread
        ? {
            threadId: lastThread.id,
            subject: lastThread.subject,
            lastMessageAt: lastThread.lastMessageAt,
          }
        : null,
    };
  });

  if (opts.hasCorrespondence === true) {
    rows = rows.filter((c) => c.lastExchange != null);
  } else if (opts.hasCorrespondence === false) {
    rows = rows.filter((c) => c.lastExchange == null);
  }

  return rows;
}
