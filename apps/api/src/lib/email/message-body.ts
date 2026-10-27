import { decrypt, encrypt } from "@/lib/crypto.js";

// Corps des e-mails de la messagerie chiffrés au repos (décision d'Alexandre du 27/10/2026, migration 20261221090000) :
// écrits dans bodyTextEncrypted et bodyHtmlEncrypted, les anciennes colonnes restent vides. Lecture : colonne chiffrée,
// à défaut l'ancienne (messages pas encore recopiés par le worker). L'aperçu (snippet) reste en clair : la recherche
// de la messagerie porte sur l'objet, l'expéditeur et cet aperçu.

type StoredBody = {
  bodyText?: string | null;
  bodyHtml?: string | null;
  bodyTextEncrypted?: string | null;
  bodyHtmlEncrypted?: string | null;
};

/** Colonnes à lire pour retrouver le corps d'un message (select Prisma). */
export const MESSAGE_BODY_SELECT = { bodyText: true, bodyHtml: true, bodyTextEncrypted: true, bodyHtmlEncrypted: true } as const;

/** Champs à écrire pour le corps d'un message. */
export function messageBodyData(text: string | null | undefined, html: string | null | undefined) {
  return {
    bodyText: null,
    bodyHtml: null,
    bodyTextEncrypted: text == null ? null : encrypt(text),
    bodyHtmlEncrypted: html == null ? null : encrypt(html),
  };
}

export function messageBodyText(m: StoredBody): string | null {
  return m.bodyTextEncrypted ? decrypt(m.bodyTextEncrypted) : (m.bodyText ?? null);
}

export function messageBodyHtml(m: StoredBody): string | null {
  return m.bodyHtmlEncrypted ? decrypt(m.bodyHtmlEncrypted) : (m.bodyHtml ?? null);
}

/** Message pour l'API : corps lisibles, comme avant, sans le texte chiffré. */
export function plainMessage<T extends StoredBody>(m: T): Omit<T, "bodyTextEncrypted" | "bodyHtmlEncrypted" | "bodyText" | "bodyHtml"> & { bodyText: string | null; bodyHtml: string | null } {
  const { bodyTextEncrypted: _t, bodyHtmlEncrypted: _h, bodyText: _bt, bodyHtml: _bh, ...rest } = m;
  return { ...rest, bodyText: messageBodyText(m), bodyHtml: messageBodyHtml(m) };
}
