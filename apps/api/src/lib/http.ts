import { Prisma } from "@prisma/client";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

function isDecimal(value: unknown): value is Prisma.Decimal {
  return (
    value instanceof Prisma.Decimal ||
    (typeof value === "object" &&
      value !== null &&
      "toFixed" in value &&
      typeof (value as { d?: unknown }).d !== "undefined")
  );
}

/** Convertit Decimal / bigint pour JSON.stringify */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (isDecimal(value)) return Number(value.toString());
  return value;
}

export function setJsonSerializer(app: {
  setReplySerializer: (fn: (payload: unknown) => string) => void;
}): void {
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
}

/** Message de la limite de débit, lisible par le site et l'admin (json.error). */
export const RATE_LIMITED = "Trop de demandes : réessayez dans quelques minutes.";

export function registerErrorHandler(app: {
  setErrorHandler: (
    handler: (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => void | Promise<void>,
  ) => void;
}): void {
  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode === 429) {
      void reply.code(429).send({ error: RATE_LIMITED });
      return;
    }
    request.log.error({ err: error }, "request error");

    if (error.validation) {
      void reply.code(400).send({ error: "Données invalides", details: error.validation });
      return;
    }

    if (error instanceof ZodError) {
      void reply.code(400).send({ error: error.flatten() });
      return;
    }

    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      void reply.code(409).send({ error: "Conflit: enregistrement déjà existant" });
      return;
    }
    if (code === "P2003") {
      void reply.code(400).send({ error: "Référence invalide" });
      return;
    }
    if (code === "P2025") {
      void reply.code(404).send({ error: "Introuvable" });
      return;
    }
    if (code === "P2023") {
      void reply
        .code(500)
        .send({ error: "Données incohérentes en base (type JSON/TEXT). Relancez les migrations." });
      return;
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const message =
      status < 500 && error.message
        ? error.message
        : status === 500
          ? "Erreur serveur"
          : error.message;

    void reply.code(status).send({ error: message });
  });
}

/**
 * Content-Disposition d'un fichier au nom venu de l'extérieur (pièce jointe reçue, justificatif envoyé) : repli ASCII
 * et nom exact en UTF-8 (RFC 6266, filename*). Un nom hors latin-1 (apostrophe typographique, emoji) faisait refuser
 * l'en-tête par Node, d'où une erreur 500 au téléchargement (audit du 27/10/2026).
 */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
