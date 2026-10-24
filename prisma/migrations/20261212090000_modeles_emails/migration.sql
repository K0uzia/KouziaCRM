-- Modèles d'e-mails modifiables (Réglages) : seules les modifications sont stockées, le texte d'origine reste dans le code.
-- Migration additive : table vide, tous les e-mails gardent leur texte d'origine.
CREATE TABLE "EmailTemplate" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "subject" TEXT,
    "body" TEXT,
    "updatedAt" DATETIME NOT NULL
);
