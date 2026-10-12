import { EmailDirection, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";

export type NotificationKind =
  | "mail"
  | "quote_accepted"
  | "quote_rejected"
  | "payment"
  | "testimonial"
  | "deposit_due"
  | "subscription_stripe"
  | "client_onboarded";

export type NotificationItem = {
  /** Identifiant stable (type + id source) : sert à dédoublonner côté interface. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Écran à ouvrir au clic. */
  href: string;
  at: string;
  /** E-mail : expéditeur, objet et client rattaché, pour la notification en app. */
  mail?: { from: string; subject: string; client: string | null };
};

const MAX_ITEMS = 30;
// Un premier import IMAP peut créer des centaines de messages anciens : seuls les mails
// reçus récemment donnent lieu à une notification.
const MAIL_RECENT_MS = 24 * 60 * 60 * 1000;

function eur(cents: number): string {
  return formatEUR(cents);
}

/** Événements survenus après `since` (création en base), du plus récent au plus ancien. */
export async function listNotifications(since: Date): Promise<NotificationItem[]> {
  const recentMail = new Date(Date.now() - MAIL_RECENT_MS);

  const [mails, accepted, rejected, payments, testimonials, depositsDue, stripeSubs, onboarded] = await Promise.all([
    prisma.emailMessage.findMany({
      where: {
        direction: EmailDirection.INBOUND,
        createdAt: { gt: since },
        receivedAt: { gt: recentMail },
        // Envois de l'ERP synchronisés comme reçus avant la détection (copies, alertes à soi-même).
        NOT: { messageId: { endsWith: "@kouzia.local>" } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        threadId: true,
        fromName: true,
        fromAddress: true,
        replyToAddress: true,
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
    // Paiement en 3 fois : étape de projet faite, 2e acompte à facturer.
    prisma.paymentMilestone.findMany({
      where: { triggeredAt: { gt: since } },
      orderBy: { triggeredAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        amountCents: true,
        triggerStepLabel: true,
        triggeredAt: true,
        quote: { select: { id: true, number: true, client: { select: { displayName: true } } } },
      },
    }),
    // Abonnement clôturé, suspendu ou repris côté Stripe (tableau de bord, impayés).
    prisma.subscription.findMany({
      where: { stripeStatusChangedAt: { gt: since } },
      orderBy: { stripeStatusChangedAt: "desc" },
      take: MAX_ITEMS,
      select: {
        id: true,
        label: true,
        stripeStatusChange: true,
        stripeStatusChangedAt: true,
        client: { select: { displayName: true } },
      },
    }),
    // Fiche remplie par le client depuis le site (/nouveau-client ou invitation) : pas les
    // clients créés par l'administrateur lui-même.
    prisma.client.findMany({
      where: { onboardingCompletedAt: { gt: since } },
      orderBy: { onboardingCompletedAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, displayName: true, onboardingCompletedAt: true },
    }),
  ]);

  const items: NotificationItem[] = [
    ...mails.map((m) => ({
      id: `mail:${m.id}`,
      kind: "mail" as const,
      title: `Nouveau message${m.thread?.client ? ` de ${m.thread.client.displayName}` : ""}`,
      // Formulaire du site (Web3Forms) : le prospect est dans Reply-To.
      body: `${m.replyToAddress || m.fromName || m.fromAddress} : ${m.subject}`,
      href: `/inbox/${m.threadId}`,
      at: m.createdAt.toISOString(),
      mail: {
        from: m.replyToAddress || m.fromName || m.fromAddress,
        subject: m.subject,
        client: m.thread?.client?.displayName ?? null,
      },
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
    ...depositsDue.map((d) => ({
      id: `deposit_due:${d.id}`,
      kind: "deposit_due" as const,
      title: `2e acompte exigible : ${eur(d.amountCents)}`,
      body: `${d.quote.client.displayName}, devis ${d.quote.number ?? ""} : étape « ${d.triggerStepLabel ?? ""} » faite. Facture à émettre.`,
      href: `/quotes/${d.quote.id}`,
      at: (d.triggeredAt ?? new Date()).toISOString(),
    })),
    ...stripeSubs.map((s) => {
      const state = s.stripeStatusChange === "ENDED" ? "clôturé" : s.stripeStatusChange === "PAUSED" ? "suspendu" : "repris";
      return {
        id: `subscription_stripe:${s.id}:${(s.stripeStatusChangedAt ?? new Date()).getTime()}`,
        kind: "subscription_stripe" as const,
        title: `Abonnement ${state} depuis Stripe`,
        body: `${s.client.displayName} : « ${s.label} ».`,
        href: "/abonnements",
        at: (s.stripeStatusChangedAt ?? new Date()).toISOString(),
      };
    }),
    ...onboarded.map((c) => ({
      id: `client_onboarded:${c.id}:${(c.onboardingCompletedAt ?? new Date()).getTime()}`,
      kind: "client_onboarded" as const,
      title: "Nouveau client",
      body: `${c.displayName} a rempli sa fiche depuis le site.`,
      href: `/clients/${c.id}`,
      at: (c.onboardingCompletedAt ?? new Date()).toISOString(),
    })),
  ];

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS);
}
