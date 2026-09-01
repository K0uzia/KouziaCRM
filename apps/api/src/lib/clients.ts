import { z } from "zod";
import { ClientType } from "@prisma/client";
import { isValidSiren, isValidSiret } from "@kouzia/forms";
import { prisma } from "@/lib/prisma";
import { decryptOptional, encryptOptional } from "@/lib/crypto";
import { allocateClientNumber } from "@/lib/clients/numbering";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import {
  normalizeFrenchAddress,
  verifyCompanyIdentifiers,
} from "@/lib/address/france.js";

export const clientInputSchema = z
  .object({
    type: z.enum(["B2B", "B2C"]),
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
  })
  .superRefine((data, ctx) => {
    if (data.type === "B2B" && !data.companyName?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Raison sociale requise pour B2B",
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
  if (data.type === "B2B") {
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
  accessCodeHash: string | null;
  accessCodeEncrypted?: string | null;
  onboardingCompletedAt: Date | null;
  accessEmailSentAt: Date | null;
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
    hasAccessCode: Boolean(client.accessCodeHash),
    accessCode: decryptOptional(client.accessCodeEncrypted ?? null),
    onboardingCompletedAt: client.onboardingCompletedAt,
    accessEmailSentAt: client.accessEmailSentAt,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export async function toPrismaClientData(data: ClientInput) {
  const addr = await normalizeFrenchAddress({
    addressLine1: data.addressLine1,
    postalCode: data.postalCode,
    city: data.city,
    country: data.country,
    addressCityCode: data.addressCityCode,
    addressLat: data.addressLat,
    addressLon: data.addressLon,
    addressManualConfirmed: data.addressManualConfirmed,
  });
  if (!addr.ok) {
    throw new AddressValidationError(addr.error);
  }

  let siren = data.siren?.replace(/\s/g, "") || null;
  let siret = data.siret?.replace(/\s/g, "") || null;
  let apeCode = data.apeCode?.trim() || null;
  let companyName = data.companyName?.trim() || null;
  let companyVerifiedAt: Date | null = data.companyVerifiedAt
    ? new Date(data.companyVerifiedAt)
    : null;

  if (data.type === "B2B" && (siren || siret)) {
    const verified = await verifyCompanyIdentifiers({
      siren,
      siret,
      companyName,
      apeCode,
    });
    if (!verified.ok) {
      throw new AddressValidationError(verified.error);
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
    notes: data.notes?.trim() || null,
  };
}

export class AddressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressValidationError";
  }
}

export async function createClientWithAccess(data: ClientInput) {
  const clientNumber = await allocateClientNumber();
  const client = await prisma.client.create({
    data: {
      ...(await toPrismaClientData(data)),
      clientNumber,
      accessCodeHash: null,
    },
  });
  return { client: serializeClient(client), accessCode: null as string | null };
}

export async function listClients(opts: { hasCorrespondence?: boolean } = {}) {
  const clients = await prisma.client.findMany({ orderBy: { displayName: "asc" } });

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
