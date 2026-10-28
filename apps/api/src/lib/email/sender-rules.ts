import { MailSenderRuleAction, MailSenderRuleKind, type MailSenderRule } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { baseDomain, domainOf, isFreeMailDomain } from "@/lib/email/suspicion.js";
import { isWeb3FormsSender } from "@/lib/email/web3forms.js";

/** Règle refusée (domaine grand public, domaine de l'entreprise, adresse d'un client) : message clair pour l'écran. */
export class SenderRuleError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const ADDRESS = /^[^\s@]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

export function normalizeRuleValue(kind: MailSenderRuleKind, raw: string): string {
  const value = raw.trim().toLowerCase();
  if (kind === MailSenderRuleKind.ADDRESS) {
    if (!ADDRESS.test(value)) throw new SenderRuleError("Adresse e-mail invalide.");
    return value;
  }
  const domain = value.replace(/^.*@/, "").replace(/^\*?\./, "");
  if (!DOMAIN.test(domain)) throw new SenderRuleError("Nom de domaine invalide (ex. exemple.fr).");
  return domain;
}

/** Domaines de l'entreprise : la boîte mail et les adresses d'envoi des réglages. */
async function ownDomains(): Promise<Set<string>> {
  const [accounts, settings] = await Promise.all([
    prisma.mailAccount.findMany({ select: { email: true } }),
    getCompanySettings().catch(() => null),
  ]);
  const addresses = [
    ...accounts.map((a) => a.email),
    settings?.smtpFrom,
    settings?.imapUser,
    (settings as { email?: string | null } | null)?.email,
  ];
  const set = new Set<string>();
  for (const a of addresses) {
    const match = a?.match(/[^\s<@]+@([^\s>]+)/);
    if (match) set.add(baseDomain(match[1]!.toLowerCase()));
  }
  return set;
}

/** Contrôles avant d'enregistrer une règle : domaine grand public ou de l'entreprise, adresse d'un client. */
async function assertRuleAllowed(kind: MailSenderRuleKind, value: string, action: MailSenderRuleAction) {
  const domain = kind === MailSenderRuleKind.DOMAIN ? value : domainOf(value);
  if (isWeb3FormsSender(`x@${domain}`)) {
    throw new SenderRuleError("C'est l'adresse technique du formulaire du site : elle ne peut pas faire l'objet d'une règle.");
  }
  if (kind === MailSenderRuleKind.DOMAIN) {
    if (isFreeMailDomain(value)) {
      throw new SenderRuleError(
        `${value} est une messagerie grand public : choisissez l'adresse précise plutôt que tout le domaine.`,
      );
    }
    if ((await ownDomains()).has(baseDomain(domain))) {
      throw new SenderRuleError(`${value} est le domaine de votre entreprise : il ne peut pas faire l'objet d'une règle.`);
    }
  }
  if (action === MailSenderRuleAction.BLOCK && kind === MailSenderRuleKind.ADDRESS) {
    if ((await prisma.mailAccount.count({ where: { email: value } })) > 0) {
      throw new SenderRuleError("C'est l'adresse de votre boîte mail : elle ne peut pas être bloquée.");
    }
    if (await findClientIdByEmail(value)) {
      throw new SenderRuleError("Cette adresse est celle d'un client : elle ne peut pas être bloquée.", 409);
    }
  }
}

export type SenderRuleInput = { kind: MailSenderRuleKind; value: string; action: MailSenderRuleAction; source?: string };

/** Ajoute la règle, ou change l'action d'une règle existante sur la même adresse ou le même domaine. */
export async function saveSenderRule(input: SenderRuleInput): Promise<MailSenderRule> {
  const value = normalizeRuleValue(input.kind, input.value);
  await assertRuleAllowed(input.kind, value, input.action);
  return prisma.mailSenderRule.upsert({
    where: { kind_value: { kind: input.kind, value } },
    create: { kind: input.kind, value, action: input.action, source: input.source ?? "MANUAL" },
    update: { action: input.action, source: input.source ?? "MANUAL" },
  });
}

export async function deleteSenderRule(id: string): Promise<boolean> {
  const res = await prisma.mailSenderRule.deleteMany({ where: { id } });
  return res.count > 0;
}

export function listSenderRules(): Promise<MailSenderRule[]> {
  return prisma.mailSenderRule.findMany({ orderBy: [{ action: "asc" }, { createdAt: "desc" }] });
}

/** Adresse réelle d'un message reçu : le prospect (Reply-To) pour le formulaire du site, sinon l'expéditeur. */
export function senderAddressOf(m: { fromAddress: string; replyToAddress: string | null }): string {
  return ((isWeb3FormsSender(m.fromAddress) ? m.replyToAddress : null) ?? m.fromAddress).trim().toLowerCase();
}

/** Règle la plus précise qui vise l'adresse : adresse exacte, puis domaine ou domaine parent. */
export function matchRule(rules: MailSenderRule[], address: string): MailSenderRule | null {
  const addr = address.trim().toLowerCase();
  const domain = domainOf(addr);
  const exact = rules.filter((r) => r.kind === MailSenderRuleKind.ADDRESS && r.value === addr);
  const byDomain = rules
    .filter((r) => r.kind === MailSenderRuleKind.DOMAIN && (domain === r.value || domain.endsWith(`.${r.value}`)))
    .sort((a, b) => b.value.length - a.value.length);
  // Une règle TRUST l'emporte toujours sur un blocage, même plus large.
  const trust = [...exact, ...byDomain].find((r) => r.action === MailSenderRuleAction.TRUST);
  return trust ?? exact[0] ?? byDomain[0] ?? null;
}

export type SenderVerdict = { action: "block" | "trust" | null; rule: MailSenderRule | null; isClient: boolean };

/** Décision pour un expéditeur : client ou TRUST passent toujours, BLOCK sinon. */
export async function senderVerdict(
  address: string,
  rules?: MailSenderRule[],
): Promise<SenderVerdict> {
  const all = rules ?? (await prisma.mailSenderRule.findMany());
  const rule = matchRule(all, address);
  const isClient = Boolean(await findClientIdByEmail(address));
  if (isClient) return { action: "trust", rule: rule?.action === MailSenderRuleAction.TRUST ? rule : null, isClient };
  if (!rule) return { action: null, rule: null, isClient };
  return { action: rule.action === MailSenderRuleAction.TRUST ? "trust" : "block", rule, isClient };
}

export async function recordRuleHit(ruleId: string): Promise<void> {
  await prisma.mailSenderRule
    .update({ where: { id: ruleId }, data: { hitCount: { increment: 1 }, lastHitAt: new Date() } })
    .catch(() => undefined);
}

/** Domaine d'une adresse qu'on peut viser par une règle de domaine (null : grand public ou entreprise). */
export async function ruleDomainFor(address: string): Promise<string | null> {
  const domain = domainOf(address);
  if (!domain || isFreeMailDomain(domain)) return null;
  if ((await ownDomains()).has(baseDomain(domain))) return null;
  return domain;
}
