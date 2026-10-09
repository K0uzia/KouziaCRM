import { EmailDirection, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export type NotificationKind = "mail" | "quote_accepted" | "quote_rejected" | "payment" | "testimonial";

export type NotificationItem = {
  /** Identifiant stable (type + id source) : sert à dédoublonner côté interface. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Écran à ouvrir au clic. */
  href: string;
  at: string;
};

const MAX_ITEMS = 30;
// Un premier import IMAP peut créer des centaines de messages anciens : seuls les mails
// reçus récemment donnent lieu à une notification.
const MAIL_RECENT_MS = 24 * 60 * 60 * 1000;

function eur(cents: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** Événements survenus après `since` (création en base), du plus récent au plus ancien. */
export async function listNotifications(since: Date): Promise<NotificationItem[]> {
  const recentMail = new Date(Date.now() - MAIL_RECENT_MS);

  const [mails, accepted, rejected, payments, testimonials] = await Promise.all([
    prisma.emailMessage.findMany({
      where: {
        direction: EmailDirection.INBOUND,
        createdAt: { gt: since },
        receivedAt: { gt: recentMail },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        threadId: true,
        fromName: true,
        fromAddress: true,
        subject: true,
        createdAt: true,
        thread: { select: { client: { select: { displayName: true } } } },
      },
    }),
    prisma.quoteAcceptanceAudit.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        signerName: true,
        createdAt: true,
        quote: { select: { id: true, number: true, totalCents: true, client: { select: { displayName: true } } } },
      },
    }),
    prisma.invoice.findMany({
      where: { quoteStatus: QuoteStatus.REJECTED, quoteDecidedAt: { gt: since } },
      orderBy: { quoteDecidedAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        number: true,
        quoteDecidedAt: true,
        quoteRejectReason: true,
        client: { select: { displayName: true } },
      },
    }),
    prisma.payment.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        amountCents: true,
        createdAt: true,
        invoice: { select: { id: true, number: true, client: { select: { displayName: true } } } },
      },
    }),
    prisma.clientTestimonial.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, authorName: true, createdAt: true },
    }),
  ]);

  const items: NotificationItem[] = [
    ...mails.map((m) => ({
      id: `mail:${m.id}`,
      kind: "mail" as const,
      title: `Nouveau message${m.thread?.client ? ` de ${m.thread.client.displayName}` : ""}`,
      body: `${m.fromName || m.fromAddress} : ${m.subject}`,
      href: `/inbox/${m.threadId}`,
      at: m.createdAt.toISOString(),
    })),
    ...accepted.map((a) => ({
      id: `quote_accepted:${a.id}`,
      kind: "quote_accepted" as const,
      title: `Devis ${a.quote.number ?? ""} accepté`,
      body: `${a.quote.client.displayName} a validé ${eur(a.quote.totalCents)} (signé par ${a.signerName}).`,
      href: `/quotes/${a.quote.id}`,
      at: a.createdAt.toISOString(),
    })),
    ...rejected.map((q) => ({
      id: `quote_rejected:${q.id}`,
      kind: "quote_rejected" as const,
      title: `Devis ${q.number ?? ""} refusé`,
      body: `${q.client.displayName}${q.quoteRejectReason ? ` : ${q.quoteRejectReason}` : " a refusé le devis."}`,
      href: `/quotes/${q.id}`,
      at: (q.quoteDecidedAt ?? new Date()).toISOString(),
    })),
    ...payments.map((p) => ({
      id: `payment:${p.id}`,
      kind: "payment" as const,
      title: `Paiement reçu : ${eur(p.amountCents)}`,
      body: p.invoice ? `${p.invoice.client.displayName}, facture ${p.invoice.number ?? ""}` : "Paiement enregistré",
      href: p.invoice ? `/invoices/${p.invoice.id}` : "/payments",
      at: p.createdAt.toISOString(),
    })),
    ...testimonials.map((t) => ({
      id: `testimonial:${t.id}`,
      kind: "testimonial" as const,
      title: "Nouvel avis client",
      body: `${t.authorName} a laissé un avis à relire.`,
      href: "/avis",
      at: t.createdAt.toISOString(),
    })),
  ];

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS);
}
