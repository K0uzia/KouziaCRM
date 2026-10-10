import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Besoins notés pour un client (rendez-vous, appel) : rappel pour le devis et le projet. */
export const MAX_NEEDS = 50;

export type ClientNeed = { id: string; label: string; done: boolean };

export const needInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  label: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1, "Besoin vide")
        .max(200, "Besoin trop long (200 caractères au plus)")
        // eslint-disable-next-line no-control-regex
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Caractères non autorisés"),
    ),
  done: z.boolean().optional().default(false),
});

export const needsInputSchema = z
  .array(needInputSchema)
  .max(MAX_NEEDS, `${MAX_NEEDS} besoins au plus`);

/** Identifiant attribué côté serveur s'il manque ; l'ordre du tableau est l'ordre affiché. */
export function normalizeNeeds(input: z.output<typeof needsInputSchema>): ClientNeed[] {
  return input.map((n) => ({ id: n.id ?? randomUUID(), label: n.label, done: n.done }));
}

/** Lecture tolérante de la colonne JSON (valeur absente ou abîmée : liste vide). */
export function parseNeeds(raw: string | null | undefined): ClientNeed[] {
  if (!raw) return [];
  try {
    const parsed = needsInputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? normalizeNeeds(parsed.data) : [];
  } catch {
    return [];
  }
}
