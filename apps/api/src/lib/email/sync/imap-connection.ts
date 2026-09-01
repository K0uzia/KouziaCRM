import type { ImapFlow } from "imapflow";
import { formatImapError, resolveImapConfig, type ImapRuntimeConfig } from "@/lib/email/imap-config.js";

export type ManagedImapClient = {
  client: ImapFlow;
  config: ImapRuntimeConfig;
};

let sharedClient: ManagedImapClient | null = null;
let connecting: Promise<ManagedImapClient> | null = null;

export async function withImapClient<T>(
  fn: (ctx: ManagedImapClient) => Promise<T>,
): Promise<T> {
  const ctx = await getImapClient();
  try {
    return await fn(ctx);
  } catch (err) {
    await disconnectImapClient();
    throw err;
  }
}

export async function getImapClient(): Promise<ManagedImapClient> {
  if (sharedClient) return sharedClient;
  if (connecting) return connecting;

  connecting = (async () => {
    const config = await resolveImapConfig();
    if (!config?.pass) {
      throw new Error("IMAP non configuré ou mot de passe absent");
    }
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      logger: false,
      emitLogs: false,
    });
    await client.connect();
    sharedClient = { client, config };
    return sharedClient;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnectImapClient(): Promise<void> {
  if (!sharedClient) return;
  try {
    await sharedClient.client.logout();
  } catch {
    /* ignore */
  }
  sharedClient = null;
}

export function formatConnectionError(error: unknown): string {
  return formatImapError(error);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(Math.min(baseMs * 2 ** attempt, 300_000));
      }
    }
  }
  throw lastError;
}
