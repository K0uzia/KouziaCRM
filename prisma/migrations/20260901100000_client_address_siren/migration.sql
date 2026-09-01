-- AlterTable
ALTER TABLE "Client" ADD COLUMN "sirenEncrypted" TEXT;
ALTER TABLE "Client" ADD COLUMN "apeCode" TEXT;
ALTER TABLE "Client" ADD COLUMN "companyVerifiedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "addressCityCode" TEXT;
ALTER TABLE "Client" ADD COLUMN "addressLat" REAL;
ALTER TABLE "Client" ADD COLUMN "addressLon" REAL;

-- AlterTable
ALTER TABLE "OnboardingInvitation" ADD COLUMN "jti" TEXT;
CREATE UNIQUE INDEX "OnboardingInvitation_jti_key" ON "OnboardingInvitation"("jti");
