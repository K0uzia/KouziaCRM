// Messagerie de démonstration pour la recette (check:mobile, captures) : noms, objets et adresses
// longs, formulaire Web3Forms, envoi, pièce jointe, favori, client rattaché. Adresses @example.com.
// Idempotent (Message-ID fixes). Refusé si NODE_ENV=production.
//   DATABASE_URL=file:../data/phase-a.db npm run seed:mail-demo
import { EmailDirection, MailFolderRole, PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("seed:mail-demo est réservé à une base de recette.");
  process.exit(1);
}

const prisma = new PrismaClient();
const HOUR = 3_600_000;

type Demo = {
  id: string;
  fromName: string | null;
  fromAddress: string;
  replyTo?: string;
  subject: string;
  snippet: string;
  hoursAgo: number;
  direction?: EmailDirection;
  to?: string;
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachments?: boolean;
  withClient?: boolean;
};

const DEMOS: Demo[] = [
  {
    id: "demo-1",
    fromName: "Marie-Charlotte de La Rochefoucauld-Montbazon",
    fromAddress: "marie-charlotte.delarochefoucauld-montbazon@association-des-amis-du-patrimoine.example.com",
    subject: "Re: Devis D-2026-0012 : questions sur la page actualités, le formulaire d'adhésion et la mise en ligne",
    snippet: "Bonjour Alexandre, merci pour le devis. Nous aimerions savoir si la page actualités peut être modifiée par plusieurs bénévoles…",
    hoursAgo: 0.3,
    withClient: true,
  },
  {
    id: "demo-2",
    fromName: "Kouzia",
    fromAddress: "contact@kouzia.example.com",
    replyTo: "jean-baptiste.lefebvre-dumoulin@boulangerie-patisserie-du-vieux-port.example.com",
    subject: "Nouveau message depuis kouzia.com : demande de site pour une boulangerie-pâtisserie artisanale",
    snippet: "Nom : Jean-Baptiste Lefebvre-Dumoulin. Message : Bonjour, nous cherchons un site avec la carte des gâteaux…",
    hoursAgo: 2,
  },
  {
    id: "demo-3",
    fromName: null,
    fromAddress: "notifications-noreply-compte-professionnel@facturation.fournisseur-hebergement.example.com",
    subject: "Votre facture d'hébergement du mois d'octobre est disponible dans votre espace client",
    snippet: "Bonjour, votre facture n° 2026-10-004512 d'un montant de 12,99 € est disponible. Prélèvement le 15 octobre.",
    hoursAgo: 26,
    isRead: true,
    hasAttachments: true,
  },
  {
    id: "demo-4",
    fromName: "Kouzia",
    fromAddress: "contact@kouzia.example.com",
    direction: EmailDirection.OUTBOUND,
    to: "sophie.martin-durand@cabinet-osteopathie-martin-durand.example.com",
    subject: "Votre devis D-2026-0011 : site vitrine et fiche Google Maps",
    snippet: "Bonjour Sophie, vous trouverez ci-joint le devis pour le site vitrine. Vous pouvez le signer depuis votre espace…",
    hoursAgo: 50,
    isRead: true,
    hasAttachments: true,
    withClient: true,
  },
  {
    id: "demo-5",
    fromName: "Service Comptabilité et Gestion Administrative de la Mairie",
    fromAddress: "comptabilite.gestion-administrative@mairie-de-saint-remy-de-provence.example.com",
    subject: "Bon de commande n° BC-2026-000457 pour la refonte du site de l'office de tourisme",
    snippet: "Madame, Monsieur, veuillez trouver ci-joint le bon de commande validé par le conseil municipal…",
    hoursAgo: 24 * 9,
    isStarred: true,
    hasAttachments: true,
  },
  {
    id: "demo-6",
    fromName: "Lou",
    fromAddress: "lou@example.com",
    subject: "Merci !",
    snippet: "Le site est super, merci beaucoup.",
    hoursAgo: 24 * 400,
    isRead: true,
  },
];

async function main() {
  const account =
    (await prisma.mailAccount.findFirst({ where: { isDefault: true } })) ??
    (await prisma.mailAccount.create({ data: { email: "contact@kouzia.example.com", isDefault: true } }));
  const inbox =
    (await prisma.mailFolder.findFirst({ where: { role: MailFolderRole.INBOX, isVirtual: false } })) ??
    (await prisma.mailFolder.create({
      data: { accountId: account.id, imapPath: "INBOX", displayName: "INBOX", role: MailFolderRole.INBOX },
    }));
  const client = await prisma.client.findFirst({ orderBy: { createdAt: "asc" } });
  const now = Date.now();
  let created = 0;

  for (const [i, d] of DEMOS.entries()) {
    const messageId = `<${d.id}@demo.example.com>`;
    if (await prisma.emailMessage.findUnique({ where: { messageId } })) continue;
    const receivedAt = new Date(now - d.hoursAgo * HOUR);
    const direction = d.direction ?? EmailDirection.INBOUND;
    const thread = await prisma.emailThread.create({
      data: {
        subject: d.subject,
        participants: JSON.stringify([d.fromAddress, d.to ?? "contact@kouzia.example.com"]),
        lastMessageAt: receivedAt,
        unreadCount: d.isRead || direction === EmailDirection.OUTBOUND ? 0 : 1,
        clientId: d.withClient ? (client?.id ?? null) : null,
      },
    });
    await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        folderId: inbox.id,
        imapUid: 90_000 + i,
        direction,
        messageId,
        fromAddress: d.fromAddress,
        fromName: d.fromName,
        replyToAddress: d.replyTo ?? null,
        toAddresses: JSON.stringify([d.to ?? "contact@kouzia.example.com"]),
        subject: d.subject,
        snippet: d.snippet,
        bodyText: `${d.snippet}\n\nhttps://www.example.com/une-adresse-tres-longue-pour-verifier-le-retour-a-la-ligne/${d.id}?suivi=abcdefghijklmnopqrstuvwxyz0123456789`,
        bodyFetched: true,
        receivedAt,
        isRead: d.isRead ?? direction === EmailDirection.OUTBOUND,
        isStarred: d.isStarred ?? false,
        hasAttachments: d.hasAttachments ?? false,
      },
    });
    created++;
  }
  const unread = await prisma.emailMessage.count({ where: { folderId: inbox.id, isRead: false } });
  await prisma.mailFolder.update({ where: { id: inbox.id }, data: { unreadCount: unread } });
  console.log(`Messagerie de démonstration : ${created} message(s) ajouté(s), ${unread} non lu(s) dans INBOX.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
