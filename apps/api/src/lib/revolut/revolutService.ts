import { createPrivateKey, createSign, randomUUID } from "node:crypto";

export type RevolutEnv = "sandbox" | "production";

export type RevolutTransaction = {
  id: string;
  state: string;
  created_at?: string;
  completed_at?: string;
  updated_at?: string;
  reference?: string;
  legs?: Array<{
    amount?: number;
    balance?: number;
    currency?: string;
    description?: string;
    account_id?: string;
    counterparty?: {
      id?: string;
      account_type?: string;
      account_id?: string;
    };
  }>;
  counterparties?: Array<{
    id?: string;
    name?: string;
    account_no?: string;
    iban?: string;
  }>;
  merchant?: { name?: string };
};

export class RevolutApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "RevolutApiError";
  }
}

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

let tokenCache: TokenCache | null = null;
let lastPollAtMs = 0;
const MIN_POLL_INTERVAL_MS = 60 * 60 * 1000;

function normalizePem(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, "\n");
  if (!key.includes("BEGIN")) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
  }
  return key;
}

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** JWT client_assertion RS256 (exp ~2 min), conforme au flux OAuth Revolut Business. */
export function createClientAssertionJwt(now = new Date()): string {
  const clientId = getClientId();
  const privateKeyPem = process.env.REVOLUT_PRIVATE_KEY;
  if (!privateKeyPem?.trim()) {
    throw new Error("REVOLUT_PRIVATE_KEY manquante");
  }
  const iss = process.env.REVOLUT_JWT_ISS?.trim() || clientId;
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + 120;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss,
    sub: clientId,
    aud: "https://revolut.com",
    iat,
    exp,
    jti: randomUUID(),
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  sign.end();
  const key = createPrivateKey(normalizePem(privateKeyPem));
  const signature = sign.sign(key);
  return `${data}.${base64url(signature)}`;
}

export function getRevolutEnv(): RevolutEnv {
  const v = (process.env.REVOLUT_ENV ?? "sandbox").trim().toLowerCase();
  return v === "production" ? "production" : "sandbox";
}

export function getRevolutBaseUrl(): string {
  return getRevolutEnv() === "production"
    ? "https://b2b.revolut.com"
    : "https://sandbox-b2b.revolut.com";
}

export function getClientId(): string {
  const id =
    process.env.REVOLUT_CLIENT_UUID?.trim() ||
    process.env.REVOLUT_CLIENT_ID?.trim();
  if (!id) throw new Error("REVOLUT_CLIENT_UUID (ou REVOLUT_CLIENT_ID) manquant");
  return id;
}

export function isRevolutConfigured(): boolean {
  return Boolean(
    process.env.REVOLUT_PRIVATE_KEY?.trim() &&
      (process.env.REVOLUT_CLIENT_UUID?.trim() ||
        process.env.REVOLUT_CLIENT_ID?.trim()) &&
      process.env.REVOLUT_REFRESH_TOKEN?.trim(),
  );
}

export function isPayoutEnabled(): boolean {
  const v = process.env.REVOLUT_PAYOUT_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function canPollNow(force = false, nowMs = Date.now()): boolean {
  if (force) return true;
  if (!lastPollAtMs) return true;
  return nowMs - lastPollAtMs >= MIN_POLL_INTERVAL_MS;
}

export function markPolled(nowMs = Date.now()): void {
  lastPollAtMs = nowMs;
}

export function getLastPollAtMs(): number {
  return lastPollAtMs;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function exchangeRefreshToken(assertion: string): Promise<TokenCache> {
  const refreshToken = process.env.REVOLUT_REFRESH_TOKEN?.trim();
  if (!refreshToken) throw new Error("REVOLUT_REFRESH_TOKEN manquant");

  const url = `${getRevolutBaseUrl()}/api/1.0/auth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RevolutApiError(
      `Auth Revolut échouée (${res.status})`,
      res.status,
      text,
    );
  }
  const json = JSON.parse(text) as {
    access_token: string;
    expires_in?: number;
  };
  const expiresIn = Number(json.expires_in ?? 2400);
  return {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
}

/** Access token OAuth (~40 min), JWT client_assertion rafraîchi à chaque échange. */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    tokenCache &&
    tokenCache.expiresAtMs > Date.now() + 5_000
  ) {
    return tokenCache.accessToken;
  }
  const assertion = createClientAssertionJwt();
  tokenCache = await exchangeRefreshToken(assertion);
  return tokenCache.accessToken;
}

async function revolutFetch(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const token = await getAccessToken(attempt > 0 && attempt <= 1);
  const url = path.startsWith("http") ? path : `${getRevolutBaseUrl()}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && attempt < 2) {
    tokenCache = null;
    return revolutFetch(path, init, attempt + 1);
  }
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after") || 0);
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await sleep(Math.min(backoff, 60_000));
    return revolutFetch(path, init, attempt + 1);
  }
  return res;
}

export type FetchTransactionsOpts = {
  from: Date;
  to: Date;
  accountId?: string | null;
  /** Inclure les débits (défaut: crédits uniquement). */
  includeDebits?: boolean;
};

/**
 * Récupère les transactions Revolut (fenêtre from/to), pagination via created_before.
 * Filtre par défaut sur montants créditeurs (legs.amount > 0).
 */
export async function fetchTransactions(
  opts: FetchTransactionsOpts,
): Promise<RevolutTransaction[]> {
  const accountId =
    opts.accountId ?? process.env.REVOLUT_ACCOUNT_ID?.trim() ?? null;
  const out: RevolutTransaction[] = [];
  let createdBefore: string | undefined;
  const fromIso = opts.from.toISOString();
  const toIso = opts.to.toISOString();

  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      from: fromIso,
      to: toIso,
      count: "100",
    });
    if (createdBefore) params.set("created_before", createdBefore);
    if (accountId) params.set("account", accountId);

    const res = await revolutFetch(`/api/1.0/transactions?${params}`);
    const text = await res.text();
    if (!res.ok) {
      throw new RevolutApiError(
        `GET /transactions échoué (${res.status})`,
        res.status,
        text,
      );
    }
    const batch = (text ? JSON.parse(text) : []) as RevolutTransaction[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const tx of batch) {
      const amount = creditAmountOf(tx);
      if (!opts.includeDebits && amount <= 0) continue;
      if (accountId) {
        const legs = tx.legs ?? [];
        if (
          legs.length > 0 &&
          !legs.some((l) => l.account_id === accountId)
        ) {
          continue;
        }
      }
      out.push(tx);
    }

    const last = batch[batch.length - 1];
    if (!last?.created_at || batch.length < 100) break;
    createdBefore = last.created_at;
  }

  return out;
}

/** Montant en centimes du crédit net (somme des legs positifs), sinon 0. */
export function creditAmountOf(tx: RevolutTransaction): number {
  const legs = tx.legs ?? [];
  if (legs.length === 0) return 0;
  let sum = 0;
  for (const leg of legs) {
    const a = Number(leg.amount ?? 0);
    if (a > 0) sum += a;
  }
  return Math.round(sum * 100);
}

/** Montant signé en centimes (crédits +, débits -) à partir des legs. */
export function signedAmountCentsOf(tx: RevolutTransaction): number {
  const legs = tx.legs ?? [];
  let sum = 0;
  for (const leg of legs) {
    sum += Number(leg.amount ?? 0);
  }
  return Math.round(sum * 100);
}

export function bookedAtOf(tx: RevolutTransaction): Date {
  const raw = tx.completed_at || tx.updated_at || tx.created_at;
  return raw ? new Date(raw) : new Date();
}

export function counterpartyNameOf(tx: RevolutTransaction): string | null {
  const fromList = tx.counterparties?.find((c) => c.name?.trim())?.name;
  if (fromList?.trim()) return fromList.trim();
  if (tx.merchant?.name?.trim()) return tx.merchant.name.trim();
  const desc = tx.legs?.[0]?.description?.trim();
  return desc || null;
}

export function counterpartyIbanOf(tx: RevolutTransaction): string | null {
  const c = tx.counterparties?.find((x) => x.iban || x.account_no);
  return c?.iban?.trim() || c?.account_no?.trim() || null;
}

export function referenceOf(tx: RevolutTransaction): string | null {
  const parts = [
    tx.reference?.trim(),
    ...(tx.legs ?? []).map((l) => l.description?.trim()).filter(Boolean),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return [...new Set(parts)].join(" | ").slice(0, 500);
}

export type PaymentDraftInput = {
  amountCents: number;
  currency?: string;
  receiverName: string;
  receiverIban: string;
  reference?: string;
};

/** Crée un brouillon de paiement (validation manuelle dans l'app Revolut). */
export async function createPaymentDraft(
  input: PaymentDraftInput,
): Promise<{ id: string; raw: unknown }> {
  const amount = (input.amountCents / 100).toFixed(2);
  const body = {
    title: input.reference ?? "Salaire",
    schedule_for: null,
    payments: [
      {
        account_id: process.env.REVOLUT_ACCOUNT_ID?.trim() || undefined,
        receiver: {
          counterparty_id: undefined,
          account_id: undefined,
          name: input.receiverName,
          iban: input.receiverIban,
        },
        amount,
        currency: input.currency ?? "EUR",
        reference: input.reference ?? "Salaire",
      },
    ],
  };

  const res = await revolutFetch("/api/1.0/payment-drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RevolutApiError(
      `POST /payment-drafts échoué (${res.status})`,
      res.status,
      text,
    );
  }
  const raw = text ? JSON.parse(text) : {};
  const id = String((raw as { id?: string }).id ?? "");
  if (!id) {
    throw new RevolutApiError("Réponse payment-draft sans id", 502, text);
  }
  return { id, raw };
}
