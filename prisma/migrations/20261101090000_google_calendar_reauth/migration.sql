-- Connexion Google Agenda refusée par Google (invalid_grant : jeton expiré ou révoqué) :
-- date du constat, l'ERP cesse de retenter jusqu'à la reconnexion. Colonne ajoutée seulement.
ALTER TABLE "CompanySettings" ADD COLUMN "googleCalendarReauthRequiredAt" DATETIME;
