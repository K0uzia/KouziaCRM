// Répare les messages reçus classés à tort comme envois (règle « expéditeur = adresse de l'ERP »,
// retirée) : hors dossier Envoyés, sans Message-ID de l'ERP (<id@kouzia.local>).
//   npm run mail:repair -- --dry-run                 liste les candidats, sans rien écrire
//   npm run mail:repair -- --since=2026-10-11        repasse les candidats en « reçu »
// Sur le CT : kouziactl mail-repair [--dry-run] [--since=AAAA-MM-JJ]
// L'état lu n'est pas modifié : il n'y a pas de preuve qu'il vienne du filtre (la synchro des
// indicateurs IMAP le réaligne ensuite sur le serveur).
import { EmailDirection, MailFolderRole, PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sinceArg = args.find((a) => a.startsWith("--since="))?.slice("--since=".length) ?? "2026-10-11";
const unknown = args.filter((a) => a !== "--dry-run" && !a.startsWith("--since="));
const since = new Date(`${sinceArg}T00:00:00Z`);
if (unknown.length > 0 || Number.isNaN(since.getTime())) {
  console.error("Usage : mail-repair [--dry-run] [--since=AAAA-MM-JJ]");
  process.exit(2);
}

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.emailMessage.findMany({
    where: {
      direction: EmailDirection.OUTBOUND,
      createdAt: { gte: since },
      folder: { role: { not: MailFolderRole.SENT } },
      NOT: { messageId: { endsWith: "@kouzia.local>" } },
    },
    select: { id: true, receivedAt: true, fromAddress: true, subject: true, isRead: true, folder: { select: { imapPath: true } } },
    orderBy: { receivedAt: "asc" },
  });
  for (const m of candidates) {
    console.log(
      `${m.receivedAt.toISOString()}  ${m.folder?.imapPath ?? "?"}  ${m.fromAddress}  ${m.subject.slice(0, 60)}${m.isRead ? "  (lu)" : ""}`,
    );
  }
  if (!dryRun && candidates.length > 0) {
    await prisma.emailMessage.updateMany({
      where: { id: { in: candidates.map((m) => m.id) } },
      data: { direction: EmailDirection.INBOUND },
    });
  }
  console.log(
    `\n${candidates.length} message(s) depuis le ${sinceArg}${dryRun ? " : simulation, rien n'est écrit." : " repassé(s) en « reçu »."}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
