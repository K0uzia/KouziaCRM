import { isValidSiren, isValidSiret, normalizeDigits } from "@kouzia/forms";
import { lookupEntrepriseCached } from "@/lib/company/lookup-service.js";
import type { FastifyReply } from "fastify";

/**
 * Accepte un SIREN (9) ou SIRET (14) dans le paramètre d'URL.
 * Retourne le SIREN à interroger, ou null si invalide.
 */
export function resolveSirenParam(raw: string): string | null {
  const digits = normalizeDigits(raw);
  if (digits.length === 9 && isValidSiren(digits)) return digits;
  if (digits.length === 14 && isValidSiret(digits)) return digits.slice(0, 9);
  // SIRET saisi sans Luhn strict : tenter les 9 premiers s'ils forment un SIREN valide
  if (digits.length === 14 && isValidSiren(digits.slice(0, 9))) {
    return digits.slice(0, 9);
  }
  return null;
}

/** Handler commun GET /api/.../entreprises/:sirenOrSiret */
export async function replyEntrepriseLookup(
  param: string,
  reply: FastifyReply,
) {
  const siren = resolveSirenParam(param);
  if (!siren) {
    return reply.code(400).send({
      error: "SIREN (9 chiffres) ou SIRET (14 chiffres) invalide",
    });
  }
  const result = await lookupEntrepriseCached(siren);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return reply.code(404).send({ error: "Entreprise introuvable" });
    }
    if (result.reason === "invalid_siren") {
      return reply.code(400).send({ error: "SIREN invalide" });
    }
    return reply.code(503).send({ error: "API entreprises indisponible" });
  }
  return result.data;
}
