import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import {
  AddressValidationError,
  clientInputSchema,
  createClientRecord,
  listClients,
  serializeClient,
  toPrismaClientData,
} from "@/lib/clients.js";
import { requireAuth } from "@/lib/auth.js";
import { endPortalAccessAfterEmailChange, revokeAllPortalSessions } from "@/lib/portal/auth.js";
import { onboardingInviteDraft, sendOnboardingInvite } from "@/lib/clients/onboarding.js";
import { portalWelcomeDraft, sendPortalWelcomeEmail } from "@/lib/clients/access-email.js";

/** Objet et texte relus dans « Vérifier l'e-mail » (envois sur clic). Absents : texte de l'ERP. */
const emailEditsSchema = z.object({ subject: z.string().trim().max(300).optional(), text: z.string().trim().max(20000).optional() });
import {
  parseNeeds,
  readServiceNeeds,
  ServiceNeedError,
  serviceNeedsInclude,
  serviceNeedsInputSchema,
  writeServiceNeeds,
} from "@/lib/clients/needs.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { createClientNote, listClientNotes, noteInputSchema, serializeNote } from "@/lib/clients/notes.js";
import { appendToNotepad, notepadInputSchema, readNotepad, saveNotepad, serializeNotepad } from "@/lib/clients/notepad.js";
import { messageBodyText } from "@/lib/email/message-body.js";
import { clientEmailEventTo } from "@/lib/privacy/at-rest.js";
import { ClientErasureError, eraseClient } from "@/lib/clients/erasure.js";
import {
  ContactConflictError,
  contactInputSchema,
  createContact,
  deleteContact,
  listContacts,
  makePrimary,
  syncPrimaryContact,
  updateContact,
} from "@/lib/clients/contacts.js";
import { formatDateTimeShortFr } from "@/lib/format-fr.js";

const createOptionsSchema = z.object({
  /** Case du formulaire (cochée par défaut côté interface) : envoie l'accès si une adresse existe. */
  sendPortalAccess: z.boolean().optional().default(false),
  /** UUID de l'appareil (création préparée hors ligne ou envoi direct) : un renvoi rend la même fiche. */
  clientRequestId: z.string().uuid().optional(),
});

/** 409 « existe déjà » : la fiche existante (id, nom, numéro), pour y rattacher devis et notes. */
function clientExists(client: { id: string; displayName: string; clientNumber: string | null }) {
  return {
    error: `Un client existe déjà avec cette adresse e-mail : ${client.displayName}.`,
    code: "client_exists",
    client: { id: client.id, displayName: client.displayName, clientNumber: client.clientNumber },
  };
}
import { replyEntrepriseLookup } from "@/lib/company/entreprise-route.js";
import {
  ClientRenewalError,
  createClientRenewal,
  deleteClientRenewal,
  listClientRenewals,
  updateClientRenewal,
} from "@/lib/clients/renewals.js";

export const clientsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { hasCorrespondence?: string };
    const hasCorrespondence =
      q.hasCorrespondence === "true"
        ? true
        : q.hasCorrespondence === "false"
          ? false
          : undefined;
    return listClients({ hasCorrespondence });
  });

  app.post("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = clientInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const options = createOptionsSchema.safeParse(request.body);
    if (!options.success) return reply.code(400).send({ error: options.error.flatten() });
    const { clientRequestId, sendPortalAccess } = options.data;
    // Renvoi d'une fiche préparée hors ligne (réponse perdue, double envoi) : la fiche déjà créée, rien de plus.
    const replay = async () => {
      const already = clientRequestId
        ? await prisma.client.findUnique({ where: { clientRequestId }, include: { serviceNeeds: serviceNeedsInclude } })
        : null;
      return already ? reply.code(200).send({ ...serializeClient(already), portalAccess: null, replayed: true }) : null;
    };
    const sent = await replay();
    if (sent) return sent;
    // Adresse e-mail déjà connue : pas de doublon, la fiche existante est désignée.
    const emailHash = computeEmailHash(parsed.data.email || null);
    const known = emailHash ? await prisma.client.findUnique({ where: { emailHash } }) : null;
    if (known) return reply.code(409).send(clientExists(known));
    try {
      let client: Awaited<ReturnType<typeof createClientRecord>>["client"];
      try {
        ({ client } = await createClientRecord(parsed.data, clientRequestId ?? null));
      } catch (e) {
        // Course entre deux envois (même élément ou même adresse) : la fiche créée par l'autre fait foi.
        if ((e as { code?: string }).code !== "P2002") throw e;
        const raced = await replay();
        if (raced) return raced;
        const twin = emailHash ? await prisma.client.findUnique({ where: { emailHash } }) : null;
        if (twin) return reply.code(409).send(clientExists(twin));
        throw e;
      }
      const portalAccess = sendPortalAccess && client.email ? await sendPortalWelcomeEmail(client.id) : null;
      return reply.code(201).send({ ...client, portalAccess });
    } catch (e) {
      if (e instanceof AddressValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  // Renouvellements chez un tiers (hébergement et domaine en gestion autonome) : rappel à J-30, rien de facturé.
  const renewalSchema = z.object({
    label: z.string().trim().min(1).max(200),
    provider: z.string().trim().max(120).optional().nullable(),
    renewsAt: z.string().min(1),
    interval: z.enum(["MONTH", "YEAR"]).default("YEAR"),
    notifyClient: z.boolean().default(false),
  });
  const renewalError = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    if (err instanceof ClientRenewalError) return reply.code(err.message.includes("introuvable") ? 404 : 400).send({ error: err.message });
    throw err;
  };

  app.get<{ Params: { id: string } }>("/api/clients/:id/renewals", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listClientRenewals(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/clients/:id/renewals", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = renewalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const row = await createClientRenewal(request.params.id, { ...parsed.data, renewsAt: new Date(parsed.data.renewsAt) });
      return reply.code(201).send(row);
    } catch (err) {
      return renewalError(reply, err);
    }
  });

  app.put<{ Params: { id: string; renewalId: string } }>("/api/clients/:id/renewals/:renewalId", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = renewalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await updateClientRenewal(request.params.id, request.params.renewalId, { ...parsed.data, renewsAt: new Date(parsed.data.renewsAt) });
    } catch (err) {
      return renewalError(reply, err);
    }
  });

  app.delete<{ Params: { id: string; renewalId: string } }>("/api/clients/:id/renewals/:renewalId", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      await deleteClientRenewal(request.params.id, request.params.renewalId);
      return reply.code(204).send();
    } catch (err) {
      return renewalError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({
      where: { id: request.params.id },
      include: { serviceNeeds: serviceNeedsInclude },
    });
    if (!client) return reply.code(404).send({ error: "Introuvable" });
    return serializeClient(client);
  });

  // Bloc-notes unique de la fiche (chiffré, versionné).
  app.get<{ Params: { id: string } }>("/api/clients/:id/notepad", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const notepad = await readNotepad(request.params.id);
    if (!notepad) return reply.code(404).send({ error: "Introuvable" });
    return serializeNotepad(notepad);
  });

  app.put<{ Params: { id: string } }>("/api/clients/:id/notepad", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = notepadInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const saved = await saveNotepad(request.params.id, parsed.data);
    if (!saved) return reply.code(404).send({ error: "Client introuvable", code: "client_not_found" });
    return { ...serializeNotepad(saved.notepad), conflict: saved.conflict };
  });

  // Contacts du client : le principal reste synchronisé avec les coordonnées de la fiche (espace client, /suivi).
  type ContactParams = { id: string; contactId: string };
  const contactConflict = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) =>
    e instanceof ContactConflictError ? reply.code(409).send({ error: e.message, code: e.code }) : null;

  app.get<{ Params: { id: string } }>("/api/clients/:id/contacts", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!client) return reply.code(404).send({ error: "Introuvable" });
    return listContacts(client.id);
  });

  app.post<{ Params: { id: string } }>("/api/clients/:id/contacts", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = contactInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const client = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!client) return reply.code(404).send({ error: "Client introuvable", code: "client_not_found" });
    const primary = (request.body as { isPrimary?: unknown } | null)?.isPrimary === true;
    try {
      return reply.code(201).send(await createContact(client.id, parsed.data, { primary }));
    } catch (e) {
      if (contactConflict(reply, e)) return;
      throw e;
    }
  });

  app.put<{ Params: ContactParams }>("/api/clients/:id/contacts/:contactId", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = contactInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const contact = await updateContact(request.params.id, request.params.contactId, parsed.data);
      if (!contact) return reply.code(404).send({ error: "Contact introuvable" });
      return contact;
    } catch (e) {
      if (contactConflict(reply, e)) return;
      throw e;
    }
  });

  app.post<{ Params: ContactParams }>("/api/clients/:id/contacts/:contactId/primary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const contact = await makePrimary(request.params.id, request.params.contactId);
      if (!contact) return reply.code(404).send({ error: "Contact introuvable" });
      return contact;
    } catch (e) {
      if (contactConflict(reply, e)) return;
      throw e;
    }
  });

  app.delete<{ Params: ContactParams }>("/api/clients/:id/contacts/:contactId", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      if (!(await deleteContact(request.params.id, request.params.contactId))) return reply.code(404).send({ error: "Contact introuvable" });
      return { ok: true };
    } catch (e) {
      if (contactConflict(reply, e)) return;
      throw e;
    }
  });

  // Anciennes notes de rendez-vous : lecture, et ajout encore accepté d'un appareil pas mis à jour (la note est
  // aussi ajoutée en fin de bloc-notes, une seule fois par clientRequestId).
  app.get<{ Params: { id: string } }>("/api/clients/:id/notes", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!client) return reply.code(404).send({ error: "Introuvable" });
    return listClientNotes(client.id);
  });

  app.post<{ Params: { id: string } }>("/api/clients/:id/notes", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = noteInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const client = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!client) return reply.code(404).send({ error: "Client introuvable", code: "client_not_found" });
    const { note, replayed } = await createClientNote(client.id, parsed.data);
    if (!replayed) await appendToNotepad(client.id, `${formatDateTimeShortFr(note.preparedAt)} : ${note.body}`);
    return reply.code(replayed ? 200 : 201).send({ ...note, replayed });
  });

  app.put<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = clientInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      // Adresse identique à celle enregistrée : reprise telle quelle, sans revérification qui pourrait la réécrire.
      const stored = await prisma.client.findUnique({
        where: { id: request.params.id },
        select: { addressLine1: true, addressLine2: true, postalCode: true, city: true, country: true, emailHash: true },
      });
      const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();
      const addressUnchanged = Boolean(
        stored &&
          same(stored.addressLine1, parsed.data.addressLine1) &&
          same(stored.addressLine2, parsed.data.addressLine2) &&
          same(stored.postalCode, parsed.data.postalCode) &&
          same(stored.city, parsed.data.city) &&
          same(stored.country ?? "FRANCE", parsed.data.country ?? "FRANCE"),
      );
      const client = await prisma.client.update({
        where: { id: request.params.id },
        data: await toPrismaClientData(parsed.data, { addressUnchanged }),
        include: { serviceNeeds: serviceNeedsInclude },
      });
      await syncPrimaryContact(client.id);
      // Adresse e-mail principale changée : les appareils connectés avec l'ancienne adresse sont déconnectés.
      if (stored && stored.emailHash !== client.emailHash) await endPortalAccessAfterEmailChange(client.id);
      return serializeClient(client);
    } catch (e) {
      if (e instanceof AddressValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  app.get<{ Params: { siren: string } }>(
    "/api/entreprises/:siren",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      return replyEntrepriseLookup(request.params.siren, reply);
    },
  );

  // Besoins du client : prestations du catalogue (remplacées en entier, case « traité ») et « Précisions ».
  app.put<{ Params: { id: string } }>("/api/clients/:id/needs", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = serviceNeedsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Besoins invalides" });
    }
    const existing = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    try {
      await prisma.$transaction((tx) => writeServiceNeeds(existing.id, parsed.data, tx));
    } catch (e) {
      if (e instanceof ServiceNeedError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return readServiceNeeds(existing.id);
  });

  // Espace client : (r)envoie l'e-mail d'accès (adresse du site, connexion par code).
  // « Vérifier l'e-mail » : brouillon de l'e-mail d'accès, rien n'est envoyé.
  app.get<{ Params: { id: string } }>("/api/clients/:id/portal/welcome/draft", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const existing = await prisma.client.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    const draft = await portalWelcomeDraft(existing.id);
    if (!draft) return reply.code(409).send({ error: "Ce client n'a pas d'adresse e-mail." });
    return { ...draft, templateKey: "access.welcome" };
  });

  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/portal/welcome",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const edits = emailEditsSchema.safeParse(request.body ?? {});
      if (!edits.success) return reply.code(400).send({ error: "Objet ou message invalide" });
      const existing = await prisma.client.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: "Introuvable" });
      return sendPortalWelcomeEmail(existing.id, edits.data);
    },
  );

  // Espace client : déconnecte tous les appareils du client (appareil perdu, doute).
  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/portal/revoke-sessions",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const existing = await prisma.client.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: "Introuvable" });
      return { revoked: await revokeAllPortalSessions(existing.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/onboarding/invite",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const existing = await prisma.client.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return reply.code(404).send({ error: "Introuvable" });
      const body = (request.body ?? {}) as { email?: string };
      const email = (body.email ?? "").trim();
      if (!email) return reply.code(400).send({ error: "Email requis" });
      const edits = emailEditsSchema.safeParse(request.body ?? {});
      if (!edits.success) return reply.code(400).send({ error: "Objet ou message invalide" });
      try {
        const result = await sendOnboardingInvite({ email, existingClientId: existing.id, ...edits.data });
        return result;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : "Erreur" });
      }
    },
  );

  // « Vérifier l'e-mail » : brouillon de l'invitation (lien d'exemple ; le vrai lien est créé à l'envoi).
  app.get("/api/onboarding/invite/draft", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = z.object({ email: z.string().trim().email(), clientId: z.string().min(1).max(64).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Adresse e-mail invalide" });
    return { ...(await onboardingInviteDraft(q.data.email, q.data.clientId ?? null)), templateKey: "onboarding.invite" };
  });

  app.post("/api/onboarding/invite", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as { email?: string };
    const email = (body.email ?? "").trim();
    if (!email) return reply.code(400).send({ error: "Email requis" });
    const edits = emailEditsSchema.safeParse(request.body ?? {});
    if (!edits.success) return reply.code(400).send({ error: "Objet ou message invalide" });
    try {
      const result = await sendOnboardingInvite({ email, existingClientId: null, ...edits.data });
      return result;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "Erreur" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/clients/:id/emails", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({ where: { id: request.params.id } });
    if (!client) return reply.code(404).send({ error: "Introuvable" });

    // Historique complet du client (borné par ses propres échanges) : pas de limite silencieuse à 50.
    const [threads, events] = await Promise.all([
      prisma.emailThread.findMany({
        where: { clientId: client.id },
        orderBy: { lastMessageAt: "desc" },
        include: {
          messages: {
            orderBy: { receivedAt: "desc" },
            take: 1,
            select: { direction: true },
          },
        },
      }),
      prisma.clientEmailEvent.findMany({
        where: { clientId: client.id },
        orderBy: { sentAt: "desc" },
      }),
    ]);

    const items = [
      ...threads.map((t) => ({
        id: `thread-${t.id}`,
        kind: "thread" as const,
        at: t.lastMessageAt.toISOString(),
        subject: t.subject,
        direction: t.messages[0]?.direction,
        threadId: t.id,
      })),
      ...events.map((e) => ({
        id: `event-${e.id}`,
        kind: "event" as const,
        at: e.sentAt.toISOString(),
        subject: e.subject,
        eventKind: e.kind,
        documentId: e.documentId,
        documentNumber: e.documentNumber,
        success: e.success,
        threadId: e.threadId ?? undefined,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return { items };
  });

  // Effacement à la demande de la personne (RGPD) : suppression, ou anonymisation d'un client facturé (lib/clients/erasure).
  app.delete<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      return await eraseClient(request.params.id);
    } catch (err) {
      if (err instanceof ClientErasureError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/clients/:id/export",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const client = await prisma.client.findUnique({
        where: { id: request.params.id },
        include: {
          invoices: {
            include: {
              lines: true,
              payments: true,
            },
            orderBy: { createdAt: "asc" },
          },
          emailThreads: {
            include: { messages: true },
            orderBy: { lastMessageAt: "asc" },
          },
          subscriptions: {
            include: { service: { select: { name: true } } },
            orderBy: { createdAt: "asc" },
          },
          renewals: { orderBy: { renewsAt: "asc" } },
          appointmentNotes: { orderBy: { preparedAt: "asc" } },
          serviceNeeds: serviceNeedsInclude,
          projects: { orderBy: { createdAt: "asc" } },
          testimonials: { orderBy: { createdAt: "asc" } },
          portalSessions: { orderBy: { createdAt: "asc" } },
          emailEvents: { orderBy: { sentAt: "asc" } },
          softwareRequests: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!client) return reply.code(404).send({ error: "Introuvable" });

      const exportedAt = new Date().toISOString();
      reply.header("Content-Type", "application/json");
      reply.header(
        "Content-Disposition",
        `attachment; filename="client-${client.clientNumber ?? client.id}-${exportedAt.slice(0, 10)}.json"`,
      );
      return {
        exportedAt,
        client: serializeClient(client),
        invoices: client.invoices.map((inv) => ({
          id: inv.id,
          number: inv.number,
          documentType: inv.documentType,
          invoiceType: inv.invoiceType,
          status: inv.status,
          issueDate: inv.issueDate?.toISOString() ?? null,
          dueDate: inv.dueDate?.toISOString() ?? null,
          totalCents: inv.totalCents,
          lines: inv.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            lineTotalCents: l.lineTotalCents,
          })),
          payments: inv.payments.map((p) => ({
            amountCents: p.amountCents,
            paidAt: p.paidAt.toISOString(),
            method: p.method,
            reference: p.reference,
          })),
        })),
        subscriptions: client.subscriptions.map((s) => ({
          label: s.label,
          amountCents: s.amountCents,
          billingDay: s.billingDay,
          billingInterval: s.billingInterval === "YEAR" ? "YEAR" : "MONTH",
          status: s.status,
          startDate: s.startDate.toISOString(),
          endDate: s.endDate?.toISOString() ?? null,
          serviceName: s.service.name,
        })),
        renewals: client.renewals.map((r) => ({
          label: r.label,
          provider: r.provider,
          renewsAt: r.renewsAt.toISOString(),
          interval: r.interval,
          notifyClient: r.notifyClient,
        })),
        notepad: (await readNotepad(client.id))?.text ?? "",
        contacts: await listContacts(client.id),
        // Besoins de l'ancien format, gardés en lecture seule depuis leur reprise dans les Précisions.
        legacyNeeds: parseNeeds(client.needs),
        appointmentNotes: client.appointmentNotes.map((n) => {
          const note = serializeNote(n);
          return { preparedAt: note.preparedAt.toISOString(), body: note.body };
        }),
        emailThreads: client.emailThreads.map((t) => ({
          subject: t.subject,
          lastMessageAt: t.lastMessageAt.toISOString(),
          messages: t.messages.map((m) => ({
            direction: m.direction,
            receivedAt: m.receivedAt.toISOString(),
            subject: m.subject,
            bodyText: messageBodyText(m),
          })),
        })),
        // Export complet (décision du 27/10/2026) : projets, témoignages, connexions à l'espace client, e-mails envoyés,
        // accords sur devis (preuve de signature) et demandes de logiciel.
        projects: client.projects.map((p) => ({ name: p.name, progress: p.progress, createdAt: p.createdAt.toISOString() })),
        testimonials: client.testimonials.map((t) => ({ authorName: t.authorName, body: t.body, status: t.status, createdAt: t.createdAt.toISOString() })),
        portalSessions: client.portalSessions.map((s) => ({
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
        })),
        emailEvents: client.emailEvents.map((e) => ({
          sentAt: e.sentAt.toISOString(),
          kind: e.kind,
          subject: e.subject,
          to: clientEmailEventTo(e),
          documentNumber: e.documentNumber,
          success: e.success,
        })),
        quoteAcceptances: (
          await prisma.quoteAcceptanceAudit.findMany({ where: { quote: { clientId: client.id } }, orderBy: { createdAt: "asc" }, include: { quote: { select: { number: true } } } })
        ).map((a) => ({
          quoteNumber: a.quote.number,
          signerName: a.signerName,
          signerCompany: a.signerCompany,
          source: a.source,
          signedAt: a.createdAt.toISOString(),
          ipAddress: a.ipAddress,
          userAgent: a.userAgent,
          pdfSha256: a.pdfSha256,
        })),
        softwareRequests: client.softwareRequests.map((r) => ({
          software: r.software,
          status: r.status,
          companyName: r.companyName,
          need: r.need,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );
};
