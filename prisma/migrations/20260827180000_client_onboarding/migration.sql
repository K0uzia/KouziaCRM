-- Onboarding client self-service par invitation email (sans pré-créer de client).
-- Ajoute le suivi de l'onboarding sur Client et crée la table dédiée OnboardingInvitation.

-- AlterTable : champs de suivi sur Client
ALTER TABLE "Client" ADD COLUMN "onboardingCompletedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "accessEmailSentAt" DATETIME;

-- CreateTable : invitations d'onboarding envoyées par email
CREATE TABLE "OnboardingInvitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "existingClientId" TEXT,
    "createdClientId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingInvitation_existingClientId_fkey" FOREIGN KEY ("existingClientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OnboardingInvitation_createdClientId_fkey" FOREIGN KEY ("createdClientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingInvitation_token_key" ON "OnboardingInvitation"("token");
CREATE INDEX "OnboardingInvitation_email_idx" ON "OnboardingInvitation"("email");
