import { EmailDirection, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { REVIEW_FAMILIES, type ReviewFamily } from "@/lib/email/review.js";
import { formatEUR } from "@/lib/money.js";
import { formatDateFr } from "@/lib/format-fr.js";

export type NotificationKind =
  | "mail"
  | "quote_accepted"
  | "quote_rejected"
  | "payment"
  | "deposit_due"
  | "subscription_stripe"
  | "client_onboarded"
  | "google_reauth"
  | "testimonial"
  | "software_request"
  | "email_review"
  | "buyout_offer"
  | "stripe_credit";

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

  const [mails, accepted, rejected, payments, depositsDue, stripeSubs, onboarded, googleReauth, testimonials, withdrawn, softwareRequests, emailReviews] = await Promise.all([
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
    // Connexion Google Agenda refusée : une seule notification (date posée une fois par panne).
    prisma.companySettings.findFirst({
      where: { googleCalendarReauthRequiredAt: { gt: since } },
      select: { googleCalendarReauthRequiredAt: true },
    }),
    // Témoignage déposé ou modifié par un client depuis /suivi : à valider (date d'accord renouvelée à chaque envoi).
    prisma.siteReview.findMany({
      where: { source: "CLIENT_SPACE", status: "DRAFT", rejectedAt: null, consentAt: { gt: since } },
      orderBy: { consentAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, author: true, consentAt: true, project: { select: { name: true } } },
    }),
    // Témoignage publié puis retiré par son auteur depuis /suivi : à sortir du site sous 7 jours.
    prisma.siteReview.findMany({
      where: { source: "CLIENT_SPACE", status: "WITHDRAWN", publishedAt: { not: null }, withdrawalRequestedAt: { gt: since } },
      orderBy: { withdrawalRequestedAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, author: true, withdrawalRequestedAt: true, project: { select: { name: true } } },
    }),
    // Demande d'utilisation d'un logiciel (Tracebay) déposée depuis le site.
    prisma.softwareRequest.findMany({
      where: { status: "PENDING", createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, software: true, companyName: true, createdAt: true },
    }),
    // E-mail automatique au client en attente de validation (E6) : aucun contenu ni destinataire dans la notification.
    prisma.emailOutbox.findMany({
      where: { status: "REVIEW", createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ITEMS,
      select: { id: true, reviewFamily: true, clientWaiting: true, createdAt: true },
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
    ...(googleReauth?.googleCalendarReauthRequiredAt
      ? [
          {
            id: `google_reauth:${googleReauth.googleCalendarReauthRequiredAt.getTime()}`,
            kind: "google_reauth" as const,
            title: "Google Agenda à reconnecter",
            body: "Google a refusé l'accès (jeton expiré ou révoqué). Les événements des démarches ne sont plus mis à jour.",
            href: "/settings?tab=declarations",
            at: googleReauth.googleCalendarReauthRequiredAt.toISOString(),
          },
        ]
      : []),
    ...testimonials.map((t) => ({
      id: `testimonial:${t.id}:${(t.consentAt ?? new Date()).getTime()}`,
      kind: "testimonial" as const,
      title: "Témoignage à valider",
      body: t.project ? `${t.author}, projet « ${t.project.name} »` : t.author,
      href: "/site/avis",
      at: (t.consentAt ?? new Date()).toISOString(),
    })),
    ...withdrawn.map((t) => ({
      id: `testimonial_withdrawn:${t.id}:${t.withdrawalRequestedAt!.getTime()}`,
      kind: "testimonial" as const,
      title: "Témoignage retiré par son auteur",
      body: `${t.author}${t.project ? `, projet « ${t.project.name} »` : ""} : à retirer du site sous 7 jours.`,
      href: "/site",
      at: t.withdrawalRequestedAt!.toISOString(),
    })),
    ...softwareRequests.map((r) => ({
      id: `software_request:${r.id}`,
      kind: "software_request" as const,
      title: `Demande ${r.software === "TRACEBAY" ? "Tracebay" : r.software} : ${r.companyName}`,
      body: "Nouvelle demande d'utilisation depuis le site.",
      href: `/demandes-logiciel/${r.id}`,
      at: r.createdAt.toISOString(),
    })),
    ...emailReviews.map((e) => ({
      id: `email_review:${e.id}`,
      kind: "email_review" as const,
      title: e.clientWaiting ? "E-mail à valider : le client attend" : "E-mail à valider",
      body: `${(e.reviewFamily && REVIEW_FAMILIES[e.reviewFamily as ReviewFamily]) || "E-mail automatique"} : à relire avant l'envoi.`,
      href: `/emails-a-valider?id=${e.id}`,
      at: e.createdAt.toISOString(),
    })),
  ];

  // Avoir automatique du crédit client Stripe (27/10/2026) : jamais envoyé au client d'office, Alexandre décide.
  const stripeCredits = await prisma.invoice.findMany({
    where: { documentType: "CREDIT_NOTE", creditReason: "STRIPE_CUSTOMER_CREDIT", createdAt: { gt: since } },
    orderBy: { createdAt: "desc" },
    take: MAX_ITEMS,
    select: { id: true, number: true, totalCents: true, createdAt: true, client: { select: { displayName: true } }, creditedInvoice: { select: { number: true } } },
  });
  for (const cn of stripeCredits) {
    items.push({
      id: `stripe_credit:${cn.id}`,
      kind: "stripe_credit" as const,
      title: `Avoir ${cn.number ?? ""} : crédit client Stripe appliqué`,
      body: `${cn.client.displayName}, facture ${cn.creditedInvoice?.number ?? ""} : ${eur(Math.abs(cn.totalCents))} réglés par le crédit du client chez Stripe. Avoir non envoyé, à envoyer si besoin.`,
      href: `/invoices/${cn.id}`,
      at: cn.createdAt.toISOString(),
    });
  }

  // Rachat (R3) : rappel de fin du premier engagement mis en file avec le rachat proposé.
  const buyoutReminders = await prisma.emailOutbox.findMany({
    where: { reviewKind: "subscription_term_end_buyout", createdAt: { gt: since }, documentId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_ITEMS,
    select: { id: true, documentId: true, createdAt: true },
  });
  if (buyoutReminders.length) {
    const subs = await prisma.subscription.findMany({
      where: { id: { in: buyoutReminders.map((r) => r.documentId!) } },
      select: { id: true, label: true, commitmentEndsAt: true, client: { select: { displayName: true } } },
    });
    const byId = new Map(subs.map((s) => [s.id, s]));
    for (const r of buyoutReminders) {
      const s = byId.get(r.documentId!);
      if (!s) continue;
      items.push({
        id: `buyout_offer:${r.id}`,
        kind: "buyout_offer" as const,
        title: `Fin d'engagement de ${s.client.displayName}${s.commitmentEndsAt ? ` le ${formatDateFr(s.commitmentEndsAt)}` : ""} : proposer le rachat ?`,
        body: `Abonnement « ${s.label} » : le rappel au client propose le rachat.`,
        href: `/abonnements?tab=contrats&contrat=${s.id}`,
        at: r.createdAt.toISOString(),
      });
    }
  }

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS);
}
