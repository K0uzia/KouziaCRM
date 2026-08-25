import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LegalClauseKind } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import {
  ensureDefaultLegalClauses,
  listAllLegalClauses,
} from "@/lib/company/legal-clauses.js";

const clauseSchema = z.object({
  kind: z.nativeEnum(LegalClauseKind).default(LegalClauseKind.CUSTOM),
  title: z.string().min(1),
  body: z.string().min(1),
  active: z.boolean().optional().default(true),
  position: z.number().int().optional(),
});

export const legalClausesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/legal-clauses", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listAllLegalClauses();
  });

  app.post("/api/legal-clauses", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    await ensureDefaultLegalClauses();
    const parsed = clauseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides" });
    }
    const max = await prisma.legalClause.aggregate({ _max: { position: true } });
    const created = await prisma.legalClause.create({
      data: {
        ...parsed.data,
        required: false,
        position: parsed.data.position ?? (max._max.position ?? 0) + 1,
      },
    });
    return reply.code(201).send(created);
  });

  app.put<{ Params: { id: string } }>("/api/legal-clauses/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const existing = await prisma.legalClause.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    const parsed = clauseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides" });
    }
    return prisma.legalClause.update({
      where: { id: existing.id },
      data: {
        title: parsed.data.title,
        body: parsed.data.body,
        kind: existing.required ? existing.kind : parsed.data.kind,
        active: parsed.data.active,
        position: parsed.data.position ?? existing.position,
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/api/legal-clauses/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const existing = await prisma.legalClause.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    if (existing.required) {
      return reply.code(400).send({ error: "Clause légale obligatoire : désactivez-la plutôt" });
    }
    await prisma.legalClause.delete({ where: { id: existing.id } });
    return { ok: true };
  });
};
