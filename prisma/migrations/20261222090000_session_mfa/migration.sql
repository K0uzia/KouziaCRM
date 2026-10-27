-- Session admin (décision d'Alexandre du 27/10/2026), additive : vrai seulement si la connexion a passé la double
-- authentification. Par le tunnel, une session non vérifiée (ouverte en LAN par mot de passe seul) est refusée et la
-- double authentification redemandée. Les sessions existantes sont non vérifiées : en LAN rien ne change, par le
-- tunnel une nouvelle connexion avec le code est demandée une fois.
ALTER TABLE "Session" ADD COLUMN "mfaVerified" BOOLEAN NOT NULL DEFAULT false;
