import { z } from "zod";
import { ClientType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional, encryptOptional } from "@/lib/crypto";
import { allocateClientNumber, generateAccessCode } from "@/lib/clients/numbering";

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
      .refine((v) => !v || /^\d{14}$/.test(v.replace(/\s/g, "")), {
        message: "SIRET invalide (14 chiffres)",
      }),
    addressLine1: z.string().optional().nullable(),
    addressLine2: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "B2B" && !data.companyName?.trim()) {
      ctx.addIssue({ code: "custom", message: "Raison sociale requise pour B2B", path: ["companyName"] });
    }
    if (data.type === "B2C" && !data.lastName?.trim()) {
      ctx.addIssue({ code: "custom", message: "Nom requis pour B2C", path: ["lastName"] });
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
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  notes: string | null;
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
    addressLine1: client.addressLine1,
    addressLine2: client.addressLine2,
    postalCode: client.postalCode,
    city: client.city,
    country: client.country,
    notes: client.notes,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export function toPrismaClientData(data: ClientInput) {
  const siret = data.siret?.replace(/\s/g, "") || null;
  return {
    type: data.type as ClientType,
    displayName: buildDisplayName(data),
    firstName: data.firstName?.trim() || null,
    lastName: data.lastName?.trim() || null,
    companyName: data.companyName?.trim() || null,
    emailEncrypted: encryptOptional(data.email || null),
    phoneEncrypted: encryptOptional(data.phone || null),
    siretEncrypted: encryptOptional(siret),
    addressLine1: data.addressLine1?.trim() || null,
    addressLine2: data.addressLine2?.trim() || null,
    postalCode: data.postalCode?.trim() || null,
    city: data.city?.trim() || null,
    country: data.country?.trim() || "FRANCE",
    notes: data.notes?.trim() || null,
  };
}

export async function createClientWithAccess(data: ClientInput) {
  const clientNumber = await allocateClientNumber();
  const access = await generateAccessCode();
  const client = await prisma.client.create({
    data: {
      ...toPrismaClientData(data),
      clientNumber,
      accessCodeHash: access.hash,
    },
  });
  return { client: serializeClient(client), accessCode: access.code };
}

export async function listClients() {
  const clients = await prisma.client.findMany({ orderBy: { displayName: "asc" } });
  return clients.map(serializeClient);
}
