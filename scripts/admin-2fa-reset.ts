// Récupération sur le serveur (téléphone et codes de secours perdus) : désactive la double
// authentification d'un compte admin et ferme toutes ses sessions.
// Usage : kouziactl 2fa-reset <email>   (ou npm run admin:2fa-reset -- <email>)
import { prisma } from "@/lib/prisma.js";
import { resetTwoFactor } from "@/lib/admin/two-factor.js";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage : kouziactl 2fa-reset <email>");
    process.exitCode = 2;
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Aucun compte admin pour ${email}.`);
    process.exitCode = 1;
    return;
  }
  await resetTwoFactor(user.id);
  console.log(
    `Double authentification désactivée et sessions fermées pour ${email}.\n` +
      "Connexion par Internet refusée tant qu'elle n'est pas réactivée : connectez-vous en LAN ou Tailscale,\n" +
      "puis Réglages > Sécurité. Changez aussi le mot de passe si l'appareil a été perdu ou volé.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
