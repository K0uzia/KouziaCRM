-- Dernière lecture des notifications, côté serveur : la même sur le PC et le téléphone.
ALTER TABLE "User" ADD COLUMN "notificationsSeenAt" DATETIME;
