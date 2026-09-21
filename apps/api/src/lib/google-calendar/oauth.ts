import { google } from "googleapis";
import { encryptOptional, decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { prisma } from "@/lib/prisma.js";
import { secretHint } from "@/lib/settings/secrets.js";
import {
  GOOGLE_CALENDAR_SCOPE,
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleRedirectUri,
  isGoogleCalendarConfigured,
} from "@/lib/google-calendar/config.js";

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

let tokenCache: TokenCache | null = null;

function oauthClient() {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants");
  }
  return new google.auth.OAuth2(clientId, clientSecret, getGoogleRedirectUri());
}

/** URL de consentement Google (access_type=offline pour refresh token). */
export function getGoogleAuthUrl(): string {
  if (!isGoogleCalendarConfigured()) {
    throw new Error("Google Calendar non configuré");
  }
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GOOGLE_CALENDAR_SCOPE, "openid", "email"],
  });
}

export async function exchangeGoogleCode(code: string): Promise<{ email: string | null }> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Aucun refresh token Google reçu. Révoquez l'accès Kouzia dans votre compte Google puis reconnectez.",
    );
  }
  client.setCredentials(tokens);

  let email: string | null = null;
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: getGoogleClientId() ?? undefined,
    });
    email = ticket.getPayload()?.email ?? null;
  }
  if (!email && tokens.access_token) {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email ?? null;
  }

  const settings = await getCompanySettings();
  const encrypted = encryptOptional(tokens.refresh_token);
  await prisma.companySettings.update({
    where: { id: settings.id },
    data: {
      googleCalendarRefreshTokenEncrypted: encrypted,
      googleCalendarRefreshTokenHint: secretHint(tokens.refresh_token),
      googleCalendarConnectedEmail: email,
      googleCalendarEnabled: true,
    },
  });
  invalidateCompanySettingsCache();
  tokenCache = null;

  if (tokens.access_token) {
    tokenCache = {
      accessToken: tokens.access_token,
      expiresAtMs: tokens.expiry_date ?? Date.now() + 50 * 60 * 1000,
    };
  }

  return { email };
}

export async function disconnectGoogleCalendar(): Promise<void> {
  const settings = await getCompanySettings();
  await prisma.companySettings.update({
    where: { id: settings.id },
    data: {
      googleCalendarRefreshTokenEncrypted: null,
      googleCalendarRefreshTokenHint: null,
      googleCalendarConnectedEmail: null,
      googleCalendarEnabled: false,
    },
  });
  invalidateCompanySettingsCache();
  tokenCache = null;
}

export async function isGoogleCalendarConnected(): Promise<boolean> {
  const settings = await getCompanySettings();
  return Boolean(
    settings.googleCalendarEnabled && settings.googleCalendarRefreshTokenEncrypted,
  );
}

/** Access token Google (refresh si besoin), ou null si non connecté. */
export async function getGoogleAccessToken(): Promise<string | null> {
  if (!isGoogleCalendarConfigured()) return null;
  const settings = await getCompanySettings();
  if (!settings.googleCalendarEnabled || !settings.googleCalendarRefreshTokenEncrypted) {
    return null;
  }

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 60_000) {
    return tokenCache.accessToken;
  }

  const refreshToken = decryptOptional(settings.googleCalendarRefreshTokenEncrypted);
  if (!refreshToken) return null;

  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error("Impossible de rafraîchir le token Google");
  }
  tokenCache = {
    accessToken: credentials.access_token,
    expiresAtMs: credentials.expiry_date ?? now + 50 * 60 * 1000,
  };
  return tokenCache.accessToken;
}

export async function getAuthedCalendarClient() {
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return null;
  const client = oauthClient();
  client.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth: client });
}
