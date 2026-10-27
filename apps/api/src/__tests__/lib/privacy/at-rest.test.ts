import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

const sent: Array<{ to: string; subject: string }> = [];
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Kouzia <contact@kouzia.test>",
  getSharedTransport: async () => ({
    sendMail: async (opts: { to: string; subject: string }) => {
      sent.push(opts);
      return { messageId: `<${sent.length}@smtp>` };
    },
  }),
}));

const { enqueueEmail } = await import("@/lib/email/mailer/outbox.js");
const { sendOutboxNow } = await import("@/lib/email/mailer/processor.js");
const { backfillEncryptedEmails } = await import("@/lib/privacy/at-rest.js");

const KEY = process.env.ENCRYPTION_KEY!;
beforeEach(async () => {
  sent.length = 0;
  process.env.ENCRYPTION_KEY = KEY;
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  process.env.ENCRYPTION_KEY = KEY;
  await resetDb();
});

/** Lignes écrites avant la migration : tout en clair, colonnes chiffrées vides. */
async function legacyRows() {
  const client = await createClient({ displayName: "Ancien client" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("ancien@exemple.fr") } });
  const event = await prisma.clientEmailEvent.create({ data: { clientId: client.id, kind: "document", subject: "Facture", toAddress: "ancien@exemple.fr" } });
  const invitation = await prisma.onboardingInvitation.create({ data: { email: "invite@exemple.fr", token: "jeton-ancien", expiresAt: new Date(Date.now() + 86_400_000) } });
  const outbox = await prisma.emailOutbox.create({
    data: { status: EmailOutboxStatus.PENDING, payload: JSON.stringify({ to: "ancien@exemple.fr", subject: "En attente", text: "Bonjour", kind: "document", clientId: client.id }) },
  });
  return { client, event, invitation, outbox };
}

describe("e-mails chiffrés au repos (migration 20261109090000)", () => {
  it("nouvel envoi : contenu de la file et adresse du journal chiffrés, anciennes colonnes vides", async () => {
    const client = await createClient({ displayName: "Client" });
    const { outboxId } = await enqueueEmail({ to: "client@exemple.fr", subject: "Devis", text: "Bonjour", kind: "document", clientId: client.id });
    const row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outboxId } });
    expect(row.payload).toBe("");
    expect(row.payloadEncrypted).not.toContain("client@exemple.fr");
    expect(JSON.parse(decrypt(row.payloadEncrypted!)).to).toBe("client@exemple.fr");

    await sendOutboxNow(outboxId);
    expect(sent.at(-1)?.to).toBe("client@exemple.fr");
    const event = await prisma.clientEmailEvent.findFirstOrThrow({ where: { outboxId } });
    expect(event.toAddress).toBe("");
    expect(decrypt(event.toAddressEncrypted!)).toBe("client@exemple.fr");
  });

  it("e-mail en attente écrit avant la migration : il part (lecture de repli), puis la recopie le chiffre", async () => {
    const { outbox } = await legacyRows();
    await sendOutboxNow(outbox.id);
    expect(sent.at(-1)).toMatchObject({ to: "ancien@exemple.fr", subject: "En attente" });
  });

  it("recopie : chiffre puis vide les anciennes colonnes, idempotente", async () => {
    const { event, invitation, outbox } = await legacyRows();
    // Les fabriques de test écrivent aussi des événements en clair : ce sont des lignes anciennes comme les autres.
    expect(await backfillEncryptedEmails()).toMatchObject({ events: expect.any(Number), invitations: 1, outbox: 1 });
    const e = await prisma.clientEmailEvent.findUniqueOrThrow({ where: { id: event.id } });
    const i = await prisma.onboardingInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    const o = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect([e.toAddress, i.email, o.payload]).toEqual(["", "", ""]);
    expect(decrypt(e.toAddressEncrypted!)).toBe("ancien@exemple.fr");
    expect(decrypt(i.emailEncrypted!)).toBe("invite@exemple.fr");
    expect(JSON.parse(decrypt(o.payloadEncrypted!)).subject).toBe("En attente");
    expect(await backfillEncryptedEmails()).toEqual({ events: 0, invitations: 0, outbox: 0, clientSnapshots: 0 });
    // Après recopie, l'e-mail en attente part toujours.
    await sendOutboxNow(outbox.id);
    expect(sent.at(-1)?.to).toBe("ancien@exemple.fr");
  });

  it.each([
    ["clé absente", undefined],
    ["clé différente de celle des données", "f".repeat(64)],
  ])("%s : recopie suspendue, erreur journalisée, aucune colonne vidée", async (_label, key) => {
    const { event, invitation, outbox } = await legacyRows();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    if (key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = key;
    expect(await backfillEncryptedEmails()).toEqual({ events: 0, invitations: 0, outbox: 0, clientSnapshots: 0 });
    process.env.ENCRYPTION_KEY = KEY;
    expect(errors.mock.calls.flat().join(" ")).toMatch(/recopie suspendue, aucune colonne vidée/);
    errors.mockRestore();
    expect((await prisma.clientEmailEvent.findUniqueOrThrow({ where: { id: event.id } })).toAddress).toBe("ancien@exemple.fr");
    expect((await prisma.onboardingInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).email).toBe("invite@exemple.fr");
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).payload).toContain("ancien@exemple.fr");
  });
});
