-- Invitation à laisser un avis Google au passage d'un projet à DONE (additif).
ALTER TABLE "CompanySettings" ADD COLUMN "reviewInviteEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "googleReviewUrl" TEXT DEFAULT 'https://g.page/r/Cb8yzZKdc-SEEBM/review/';
ALTER TABLE "ClientProject" ADD COLUMN "reviewInviteSentAt" DATETIME;
