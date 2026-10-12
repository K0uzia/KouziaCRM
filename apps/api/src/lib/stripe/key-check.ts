/**
 * Contrôle d'une clé collée dans Réglages > Paiements, avant tout appel Stripe : les erreurs
 * de copie courantes (clé publiable, secret de webhook, double collage) ont un message précis.
 */
export class StripeKeyFormatError extends Error {
  statusCode = 400;
}

/** Longueur habituelle d'une clé secrète Stripe (environ 100 caractères). */
const USUAL_MAX_LENGTH = 160;

/** Retire les espaces et retours à la ligne collés avec la valeur. */
export function cleanSecret(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function assertSecretKeyFormat(raw: string): string {
  const key = cleanSecret(raw);
  if (key.startsWith("pk_")) {
    throw new StripeKeyFormatError(
      "C'est une clé publiable (pk_…) : il faut la clé secrète (sk_test_… ou sk_live_…), dans Stripe > Développeurs > Clés API > Clé secrète.",
    );
  }
  if (key.startsWith("whsec_")) {
    throw new StripeKeyFormatError(
      "C'est le secret de signature des webhooks (whsec_…) : collez-le dans le champ « Secret webhook ». Ici, il faut la clé secrète sk_test_… ou sk_live_….",
    );
  }
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    throw new StripeKeyFormatError(
      "Ce n'est pas une clé secrète Stripe : elle commence par sk_test_ ou sk_live_ (rk_ pour une clé restreinte).",
    );
  }
  return key;
}

export function assertWebhookSecretFormat(raw: string): string {
  const secret = cleanSecret(raw);
  if (/^(sk|pk|rk)_/.test(secret)) {
    throw new StripeKeyFormatError(
      "C'est une clé d'API, pas le secret de webhook : le secret de signature commence par whsec_ (Stripe > Webhooks, ou affiché par « stripe listen »).",
    );
  }
  if (!secret.startsWith("whsec_")) {
    throw new StripeKeyFormatError("Le secret de signature des webhooks commence par whsec_.");
  }
  return secret;
}

/** Complément du message quand Stripe refuse une clé de longueur inhabituelle. */
export function lengthHint(key: string): string {
  return key.length > USUAL_MAX_LENGTH
    ? ` Cette clé fait ${key.length} caractères, une clé secrète Stripe en fait d'ordinaire une centaine : elle a sans doute été collée deux fois ou mal copiée. Recopiez-la en entier depuis Stripe (Développeurs > Clés API > Clé secrète > Révéler).`
    : "";
}
