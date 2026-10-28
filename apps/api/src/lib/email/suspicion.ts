/**
 * Signaux d'un message douteux (hameçonnage, usurpation), calculés à la lecture : aucune donnée enregistrée.
 * Signal fort : la bannière s'affiche. Signal faible : ajouté à la bannière quand elle s'affiche, jamais seul
 * (un premier message d'un prospect sur une messagerie gratuite est courant chez les associations).
 */

export type SuspicionSignal = { code: string; text: string; strong: boolean };

export type SuspicionInput = {
  fromAddress: string;
  fromName: string | null;
  replyToAddress: string | null;
  /** En-têtes Authentication-Results (le premier est celui posé par le serveur de réception). */
  authHeaders: string | null;
  html: string | null;
  /** Client, ou adresse à laquelle un message a déjà été envoyé. */
  knownSender: boolean;
  /** Aucun autre échange avec cette adresse. */
  firstContact: boolean;
  /** Domaines connus (clients, correspondants, domaine de la boîte) pour repérer une imitation. */
  knownDomains: string[];
  /** Formulaire du site : le Reply-To est le prospect, c'est normal. */
  formSender?: boolean;
};

/**
 * Messageries gratuites et grand public (liste maintenue ici, seule source) : jamais bloquées ni approuvées
 * en entier, et sans valeur pour repérer une imitation de domaine.
 */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "ymail.com", "rocketmail.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "aol.fr", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "neuf.fr", "cegetel.net", "laposte.net",
  "bbox.fr", "numericable.fr", "aliceadsl.fr", "club-internet.fr", "noos.fr", "voila.fr", "pm.me", "mail.com",
  "zoho.com", "tutanota.com", "tuta.io", "web.de", "t-online.de", "libero.it", "skynet.be", "bluewin.ch",
  "videotron.ca", "mailo.com", "netcourrier.com",
]);

/** Fournisseurs présents sous plusieurs extensions (yahoo.fr, hotmail.co.uk, gmx.de, proton.me...). */
const FREE_MAIL_NAMES = new Set(["yahoo", "hotmail", "outlook", "live", "gmx", "proton", "protonmail", "yandex"]);

/** Suffixes à deux niveaux courants : « exemple.co.uk » a pour domaine « exemple.co.uk », pas « co.uk ». */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.nz", "co.jp", "com.br", "gouv.fr", "asso.fr", "nom.fr", "co.za",
]);

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/\.$/, "");
}

/** Domaine enregistré (« mail.banque.fr » donne « banque.fr »). */
export function baseDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function isFreeMailDomain(domain: string): boolean {
  const base = baseDomain(domain);
  return FREE_MAIL.has(base) || FREE_MAIL_NAMES.has(base.split(".")[0] ?? "");
}

type AuthResult = { spf: string | null; dkim: string[]; dmarc: string | null };

/** Lit le premier en-tête Authentication-Results (les suivants peuvent venir de l'expéditeur lui-même). */
export function parseAuthenticationResults(raw: string | null): AuthResult | null {
  if (!raw) return null;
  // En-têtes repliés sur plusieurs lignes : une ligne qui commence par un blanc continue la précédente.
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  const first = unfolded
    .split(/\r?\n/)
    .find((line) => /^authentication-results\s*:/i.test(line));
  if (!first) return null;
  const value = first.replace(/^authentication-results\s*:/i, "");
  const result: AuthResult = { spf: null, dkim: [], dmarc: null };
  for (const m of value.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const method = m[1]!.toLowerCase();
    const outcome = m[2]!.toLowerCase();
    if (method === "spf") result.spf ??= outcome;
    else if (method === "dmarc") result.dmarc ??= outcome;
    else result.dkim.push(outcome);
  }
  if (!result.spf && !result.dmarc && result.dkim.length === 0) return null;
  return result;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2e;|&#46;/gi, ".");
}

/** Hôte qu'un texte de lien annonce (« www.banque.fr », « https://banque.fr/compte »), sinon null. */
function announcedHost(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const m = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#].*)?$/i.exec(t);
  return m ? m[1]!.toLowerCase() : null;
}

function hrefHost(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Liens dont le texte affiche une adresse et qui mènent ailleurs. */
export function misleadingLinks(html: string | null): Array<{ shown: string; target: string }> {
  if (!html) return [];
  const out: Array<{ shown: string; target: string }> = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(re)) {
    const target = hrefHost(m[2]!);
    const shown = announcedHost(decodeEntities(m[3]!.replace(/<[^>]+>/g, "")));
    if (!target || !shown) continue;
    if (baseDomain(target) === baseDomain(shown)) continue;
    if (!out.some((o) => o.shown === shown && o.target === target)) out.push({ shown, target });
    if (out.length >= 3) break;
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Forme « squelette » : rn devient m, 0 devient o, 1 et i deviennent l, tirets retirés. */
function skeleton(domain: string): string {
  return domain.replace(/rn/g, "m").replace(/vv/g, "w").replace(/0/g, "o").replace(/[1i|]/g, "l").replace(/-/g, "");
}

/** Domaine connu que celui-ci imite (une ou deux lettres changées, caractères ressemblants). */
export function lookalikeOf(domain: string, knownDomains: string[]): string | null {
  const base = baseDomain(domain);
  if (isFreeMailDomain(base)) return null;
  const name = base.split(".")[0] ?? "";
  for (const known of new Set(knownDomains.map((d) => baseDomain(d)))) {
    if (!known || known === base || isFreeMailDomain(known)) continue;
    const knownName = known.split(".")[0] ?? "";
    if (knownName.length < 4) continue;
    if (skeleton(base) === skeleton(known)) return known;
    // Même nom, autre extension (banque.fr contre banque-fr.com) ou une lettre de différence.
    if (name === knownName) return known;
    const distance = levenshtein(name, knownName);
    if (distance > 0 && distance <= (knownName.length >= 8 ? 2 : 1)) return known;
  }
  return null;
}

export function analyzeSuspicion(input: SuspicionInput): SuspicionSignal[] {
  const signals: SuspicionSignal[] = [];
  const fromDomain = domainOf(input.fromAddress);

  const auth = parseAuthenticationResults(input.authHeaders);
  if (auth) {
    const dkimPass = auth.dkim.includes("pass");
    if (auth.dmarc === "fail") {
      signals.push({
        code: "dmarc_fail",
        text: `Votre boîte mail n'a pas pu confirmer que ce message vient bien de ${fromDomain}.`,
        strong: true,
      });
    } else if ((auth.spf === "fail" || auth.spf === "softfail") && !dkimPass) {
      signals.push({
        code: "spf_fail",
        text: `Le serveur qui a envoyé ce message n'est pas autorisé par ${fromDomain}.`,
        strong: true,
      });
    }
  }

  const nameAddress = input.fromName?.match(/[a-z0-9._%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})/i);
  const nameHost = nameAddress ? nameAddress[1]! : input.fromName ? announcedHostInText(input.fromName) : null;
  if (nameHost && baseDomain(nameHost) !== baseDomain(fromDomain)) {
    signals.push({
      code: "display_name",
      text: `Le nom affiché parle de ${nameHost.toLowerCase()}, mais le message vient de ${input.fromAddress}.`,
      strong: true,
    });
  }

  if (fromDomain.split(".").some((label) => label.startsWith("xn--"))) {
    signals.push({
      code: "punycode",
      text: `L'adresse ${input.fromAddress} contient des lettres spéciales qui peuvent imiter une autre adresse.`,
      strong: true,
    });
  } else {
    const imitated = lookalikeOf(fromDomain, input.knownDomains);
    if (imitated) {
      signals.push({
        code: "lookalike",
        text: `L'adresse ${input.fromAddress} ressemble à ${imitated}, sans être la même.`,
        strong: true,
      });
    }
  }

  for (const link of misleadingLinks(input.html)) {
    signals.push({
      code: "link_mismatch",
      text: `Un lien affiche ${link.shown} mais mène à ${link.target}.`,
      strong: true,
    });
  }

  if (
    input.replyToAddress &&
    !input.formSender &&
    baseDomain(domainOf(input.replyToAddress)) !== baseDomain(fromDomain)
  ) {
    signals.push({
      code: "reply_to",
      text: `Une réponse partirait vers ${input.replyToAddress}, pas vers l'expéditeur.`,
      strong: false,
    });
  }

  if (input.firstContact && !input.knownSender) {
    signals.push({
      code: "first_contact",
      text: isFreeMailDomain(fromDomain)
        ? "Premier message de cette adresse, une messagerie gratuite qui n'est pas celle d'un client."
        : "Premier message de cette adresse, qui n'est pas celle d'un client.",
      strong: false,
    });
  }

  return signals;
}

/** Nom affiché qui contient un nom de domaine (« Service client banque.fr »). */
function announcedHostInText(text: string): string | null {
  const m = /\b((?:[a-z0-9-]+\.)+(?:com|fr|net|org|eu|io|be|ch|de|info|biz))\b/i.exec(text);
  return m ? m[1]! : null;
}

/** Un signal fort au moins : la bannière s'affiche avec tous les signaux. Sinon rien. */
export function suspicionBanner(signals: SuspicionSignal[]): SuspicionSignal[] {
  return signals.some((s) => s.strong) ? signals : [];
}

/**
 * En-têtes Authentication-Results bruts (repli compris) extraits d'un bloc d'en-têtes : seuls ceux-là sont
 * gardés (colonne rawHeaders), le reste des en-têtes n'est pas conservé.
 */
export function extractAuthHeaders(raw: Buffer | string | null | undefined): string | null {
  if (!raw) return null;
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const head = text.split(/\r?\n\r?\n/)[0] ?? "";
  const kept: string[] = [];
  let keeping = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (keeping) kept.push(line);
      continue;
    }
    keeping = /^authentication-results\s*:/i.test(line);
    if (keeping) kept.push(line);
  }
  return kept.length > 0 ? kept.join("\r\n").slice(0, 8000) : null;
}
