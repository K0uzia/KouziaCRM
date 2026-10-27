import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { derivedKey, encrypt, encryptionKey } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { backfillClientEmailHashes } from "@/lib/clients/backfill-email-hash.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : le hachage de recherche des e-mails (emailHash) utilisait la clé de chiffrement
// elle-même. Il utilise une sous-clé dédiée (HKDF, usage distinct) ; les hachages en base sont recalculés (rattrapage
// idempotent) et la recherche par e-mail reste la même.
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

const EMAIL = "Lea.Martin@Exemple.fr";
const legacyHash = (email: string) => createHmac("sha256", encryptionKey()).update(email.trim().toLowerCase()).digest("hex");

describe("emailHash par sous-clé dédiée", () => {
  it("le hachage n'utilise plus la clé de chiffrement elle-même", () => {
    const expected = createHmac("sha256", derivedKey("email-hash")).update("lea.martin@exemple.fr").digest("hex");
    expect(computeEmailHash(EMAIL)).toBe(expected);
    expect(computeEmailHash(EMAIL)).not.toBe(legacyHash(EMAIL));
  });

  it("hachages anciens recalculés partout (client, contact, demande de logiciel), idempotent, recherche inchangée", async () => {
    const client = await createClient({ displayName: "Léa Martin" });
    await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: legacyHash(EMAIL) } });
    const contact = await prisma.clientContact.create({
      data: { clientId: client.id, firstName: "Paul", lastName: "Martin", emailEncrypted: encrypt("paul@exemple.fr"), emailHash: legacyHash("paul@exemple.fr") },
    });
    const request = await prisma.softwareRequest.create({
      data: {
        software: "TRACEBAY", companyName: "Atelier Martin", contactNameEncrypted: encrypt("Léa Martin"), emailEncrypted: encrypt(EMAIL), emailHash: legacyHash(EMAIL),
        edition: "SERVER", seats: "1", need: "Traçabilité", duration: "UNSURE", noticeVersion: "abcdef012345",
      },
    });

    expect(await backfillClientEmailHashes()).toBe(3);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).emailHash).toBe(computeEmailHash(EMAIL));
    expect((await prisma.clientContact.findUniqueOrThrow({ where: { id: contact.id } })).emailHash).toBe(computeEmailHash("paul@exemple.fr"));
    expect((await prisma.softwareRequest.findUniqueOrThrow({ where: { id: request.id } })).emailHash).toBe(computeEmailHash(EMAIL));
    expect(await backfillClientEmailHashes()).toBe(0);

    // Recherche par e-mail (espace client, rattachement d'un e-mail reçu) : la fiche est retrouvée.
    const found = await prisma.client.findUnique({ where: { emailHash: computeEmailHash("  lea.martin@exemple.fr ")! } });
    expect(found?.id).toBe(client.id);
  });
});
