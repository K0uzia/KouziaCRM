import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encrypt } from "@/lib/crypto.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { secretHint } from "@/lib/settings/secrets.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";

/**
 * Accès au dépôt du site (KouziaWebsite) par l'API GitHub, avec un fine-grained PAT limité à ce dépôt.
 * Le jeton est chiffré en base, jamais renvoyé ni journalisé (indice « ••••ab12 » seulement).
 */

const API = "https://api.github.com";
export const SITE_CONTENT_DIR = "src/content/site";

export function siteRepo(): string {
  const repo = process.env.SITE_GITHUB_REPO?.trim() || "K0uzia/KouziaWebsite";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("SITE_GITHUB_REPO invalide (attendu : propriétaire/dépôt)");
  return repo;
}
export const siteBranch = () => process.env.SITE_GITHUB_BRANCH?.trim() || "main";

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function saveGithubToken(token: string | null): Promise<void> {
  const settings = await getCompanySettings();
  const t = token?.trim() ?? "";
  await prisma.companySettings.update({
    where: { id: settings.id },
    data: t
      ? { githubTokenEncrypted: encrypt(t), githubTokenHint: secretHint(t), githubTokenExpiresAt: null }
      : { githubTokenEncrypted: null, githubTokenHint: null, githubTokenExpiresAt: null },
  });
  invalidateCompanySettingsCache();
}

async function githubToken(): Promise<string> {
  const token = decryptOptional((await getCompanySettings()).githubTokenEncrypted);
  if (!token) throw new GithubError("Jeton GitHub non renseigné (espace Site, Réglages).", 412);
  return token;
}

async function call(token: string, pathname: string, accept = "application/vnd.github+json"): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${pathname}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kouzia-erp",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GithubError("GitHub injoignable.", 502);
  }
  if (res.status === 401) throw new GithubError("Jeton GitHub refusé (expiré ou révoqué).", 401);
  if (res.status === 403 || res.status === 404) {
    throw new GithubError("Dépôt introuvable, ou jeton sans droit de lecture sur ce dépôt.", res.status);
  }
  if (!res.ok) throw new GithubError(`GitHub a répondu ${res.status}.`, res.status);
  return res;
}

/** « 2027-10-14 12:00:00 UTC » ou « 2027-10-14 12:00:00 +0200 » ; null sans en-tête (jeton sans expiration). */
export function parseTokenExpiration(header: string | null): Date | null {
  const m = header?.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!m) return null;
  const zone = m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type GithubConnection = { repo: string; branch: string; headSha: string; expiresAt: Date | null };

/** Test sans écriture : référence de la branche et contrat du contenu. Enregistre l'expiration du jeton. */
export async function testGithubConnection(): Promise<GithubConnection> {
  const token = await githubToken();
  const repo = siteRepo();
  const branch = siteBranch();
  const res = await call(token, `/repos/${repo}/git/ref/heads/${branch}`);
  const ref = (await res.json()) as { object?: { sha?: string } };
  const expiresAt = parseTokenExpiration(res.headers.get("github-authentication-token-expiration"));
  await call(token, `/repos/${repo}/contents/${SITE_CONTENT_DIR}/contenu.schema.json?ref=${branch}`);
  const settings = await getCompanySettings();
  await prisma.companySettings.update({ where: { id: settings.id }, data: { githubTokenExpiresAt: expiresAt } });
  invalidateCompanySettingsCache();
  return { repo, branch, headSha: ref.object?.sha ?? "", expiresAt };
}

/** Lecture seule des 6 fichiers publiés et du contrat (contenu.schema.json) sur la branche du site. */
export async function readSiteRepoFiles(): Promise<{ files: Record<SiteFileName, string>; contract: unknown }> {
  const token = await githubToken();
  const repo = siteRepo();
  const branch = siteBranch();
  const raw = async (name: string) =>
    (await call(token, `/repos/${repo}/contents/${SITE_CONTENT_DIR}/${name}?ref=${branch}`, "application/vnd.github.raw+json")).text();
  const files = {} as Record<SiteFileName, string>;
  for (const name of SITE_FILES) files[name] = await raw(`${name}.json`);
  return { files, contract: JSON.parse(await raw("contenu.schema.json")) };
}
