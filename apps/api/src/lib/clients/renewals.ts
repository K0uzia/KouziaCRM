import type { ClientRenewal, CompanySettings } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatLongDate } from "@/lib/money.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import { templateText } from "@/lib/email/template-registry.js";

/**
 * Renouvellements chez un tiers (hébergement et domaine en gestion autonome, au nom du client) : rien n'est
 * facturé par l'ERP. À J-30, tâche interne dans « À traiter » ; e-mail au client seulement si notifyClient.
 */
export const RENEWAL_NOTICE_DAYS = 30;
const DAY_MS = 86_400_000;

export type RenewalInterval = "MONTH" | "YEAR";
export type ClientRenewalInput = {
  label: string;
  provider?: string | null;
  renewsAt: Date;
  interval: RenewalInterval;
  notifyClient: boolean;
};

export class ClientRenewalError extends Error {}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

function addPeriod(d: Date, interval: string): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + (interval === "MONTH" ? 1 : 12));
  return out;
}

function validate(input: ClientRenewalInput): ClientRenewalInput {
  const label = input.label.trim();
  if (!label) throw new ClientRenewalError("Libellé requis");
  if (Number.isNaN(input.renewsAt.getTime())) throw new ClientRenewalError("Date de renouvellement invalide");
  return { ...input, label, provider: input.provider?.trim() || null, renewsAt: startOfDay(input.renewsAt) };
}

export const listClientRenewals = (clientId: string) =>
  prisma.clientRenewal.findMany({ where: { clientId }, orderBy: { renewsAt: "asc" } });

export async function createClientRenewal(clientId: string, input: ClientRenewalInput) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new ClientRenewalError("Client introuvable");
  return prisma.clientRenewal.create({ data: { clientId, ...validate(input) } });
}

export async function updateClientRenewal(clientId: string, id: string, input: ClientRenewalInput) {
  const row = await prisma.clientRenewal.findUnique({ where: { id } });
  if (!row || row.clientId !== clientId) throw new ClientRenewalError("Renouvellement introuvable");
  return prisma.clientRenewal.update({ where: { id }, data: validate(input) });
}

export async function deleteClientRenewal(clientId: string, id: string) {
  const row = await prisma.clientRenewal.findUnique({ where: { id } });
  if (!row || row.clientId !== clientId) throw new ClientRenewalError("Renouvellement introuvable");
  await prisma.clientRenewal.delete({ where: { id } });
}

/** Échéance passée : date suivante (le renouvellement chez le tiers est annuel ou mensuel). */
export async function advancePastClientRenewals(now: Date = new Date()): Promise<number> {
  const today = startOfDay(now);
  const past = await prisma.clientRenewal.findMany({ where: { renewsAt: { lt: today } } });
  for (const r of past) {
    let next = r.renewsAt;
    while (next < today) next = addPeriod(next, r.interval);
    await prisma.clientRenewal.update({ where: { id: r.id }, data: { renewsAt: next } });
  }
  return past.length;
}

/** Tâches « À traiter » : renouvellements des 30 prochains jours (aujourd'hui compris). */
export async function listDueClientRenewals(now: Date = new Date()) {
  const today = startOfDay(now);
  const rows = await prisma.clientRenewal.findMany({
    where: { renewsAt: { gte: today, lte: new Date(today.getTime() + RENEWAL_NOTICE_DAYS * DAY_MS) } },
    orderBy: { renewsAt: "asc" },
    include: { client: { select: { id: true, displayName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client.id,
    displayName: r.client.displayName,
    label: r.label,
    provider: r.provider,
    renewsAt: r.renewsAt,
    notifyClient: r.notifyClient,
  }));
}

export async function renderClientRenewalEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  renewal: Pick<ClientRenewal, "label" | "provider" | "renewsAt">;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const date = formatLongDate(opts.renewal.renewsAt);
  const chez = opts.renewal.provider ? ` chez ${opts.renewal.provider}` : " chez votre hébergeur";
  const callout = `Renouvellement le ${date}`;
  const salutation = name ? `Bonjour ${name},` : "Bonjour,";
  const content = await templateText(
    "client.renewal",
    { salutation, prenom: opts.clientFirstName?.trim() ?? "", client: opts.clientName, prestation: opts.renewal.label, chez, date, date_rappel: callout },
    {
      subject: `Pensez au renouvellement de « ${opts.renewal.label} » le ${date}`,
      body: [
        salutation,
        "",
        `« ${opts.renewal.label} » est à votre nom${chez} et arrive à échéance le ${date}.`,
        "",
        callout,
        "",
        "Pensez à vérifier le renouvellement depuis votre compte, pour que votre site et vos adresses e-mail restent en ligne.",
        "Pour toute question, répondez simplement à cet e-mail.",
      ].join("\n"),
    },
  );
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");
  const html = renderEmailHtml({ text, brand: opts.brand, colors: { brandPrimaryColor: opts.settings.brandPrimaryColor, brandSecondaryColor: opts.settings.brandSecondaryColor }, callout });
  return { subject, text, html };
}

/** E-mail au client à J-30, seulement si notifyClient. Idempotent par échéance (noticeSentFor). */
export async function sendDueClientRenewalNotices(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;
  const due = (await listDueClientRenewals(now)).filter((r) => r.notifyClient);
  if (due.length === 0) return 0;
  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  let queued = 0;
  for (const item of due) {
    const r = await prisma.clientRenewal.findUnique({ where: { id: item.id }, include: { client: true } });
    if (!r || r.noticeSentFor?.getTime() === r.renewsAt.getTime()) continue;
    const to = decryptOptional(r.client.emailEncrypted);
    if (!to) {
      console.warn(`[renouvellements] e-mail ignoré : client sans e-mail (${r.id})`);
      continue;
    }
    const content = await renderClientRenewalEmail({ brand, settings, clientName: r.client.displayName, clientFirstName: r.client.firstName, renewal: r });
    await mailEnqueue({ to, subject: content.subject, text: content.text, html: content.html, clientId: r.clientId, kind: "client_renewal", bodyTextForMessage: content.text }, { review: { family: "subscription_notice", origin: "WORKER" } });
    await prisma.clientRenewal.update({ where: { id: r.id }, data: { noticeSentFor: r.renewsAt } });
    queued += 1;
  }
  return queued;
}
