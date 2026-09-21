import { publicApiBaseUrl } from "@/lib/settings/public.js";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function getGoogleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

export function getGoogleClientSecret(): string | null {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
}

export function getGoogleRedirectUri(): string {
  const fromEnv = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `${publicApiBaseUrl()}/api/google/calendar/callback`;
}

/** Client OAuth Google configuré côté serveur (.env). */
export function isGoogleCalendarConfigured(): boolean {
  return Boolean(getGoogleClientId() && getGoogleClientSecret());
}

export function webAdminOrigin(): string {
  return (
    process.env.WEB_ORIGIN?.trim().replace(/\/$/, "") ||
    "http://localhost:5173"
  );
}
