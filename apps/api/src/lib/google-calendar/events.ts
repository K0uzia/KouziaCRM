import type { calendar_v3 } from "googleapis";
import type { Obligation } from "@prisma/client";

const TZ = "Europe/Paris";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rappels : email pour les délais longs (plus fiable que popup J-7),
 * popup pour J-1 / jour J. Max 5 overrides, minutes 0-40320.
 */
export const OBLIGATION_EVENT_REMINDERS: calendar_v3.Schema$EventReminder[] = [
  { method: "email", minutes: 7 * 24 * 60 },
  { method: "email", minutes: 3 * 24 * 60 },
  { method: "popup", minutes: 1 * 24 * 60 },
  { method: "popup", minutes: 0 },
];

/** Date locale YYYY-MM-DD (Europe/Paris), via formatToParts (fiable sur Alpine/musl). */
export function dueDateYmd(dueDate: Date): string {
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`dueDate invalide: ${String(dueDate)}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  const ymd = `${year}-${month}-${day}`;
  if (!YMD_RE.test(ymd)) {
    throw new Error(`Format date Google invalide: ${ymd} (due=${d.toISOString()})`);
  }
  return ymd;
}

/** Jour suivant (fin exclusive Google pour événement journée entière). */
export function nextDayYmd(ymd: string): string {
  if (!YMD_RE.test(ymd)) {
    throw new Error(`nextDayYmd: date invalide ${ymd}`);
  }
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** @deprecated Conservé pour les tests / anciens appels ; les syncs utilisent des journées entières. */
export function eventStartIso(dueDate: Date): string {
  const ymd = dueDateYmd(dueDate);
  return `${ymd}T09:00:00`;
}

/** @deprecated Voir eventStartIso. */
export function eventEndIso(dueDate: Date): string {
  const ymd = dueDateYmd(dueDate);
  return `${ymd}T09:30:00`;
}

export type ObligationEventInput = {
  label: string;
  dueDate: Date;
  description: string;
};

/**
 * Payload Google Calendar : journée entière + rappels.
 * Objets start/end volontairement minimalistes (pas de dateTime/timeZone: null).
 */
export function buildObligationEventPayload(
  input: ObligationEventInput,
  opts?: { withReminders?: boolean },
): calendar_v3.Schema$Event {
  const ymd = dueDateYmd(input.dueDate);
  const summary = (input.label || "Obligation KouziaCRM").slice(0, 1024);
  const description = (input.description || "").slice(0, 8000);
  const event: calendar_v3.Schema$Event = {
    summary,
    description,
    start: { date: ymd },
    end: { date: nextDayYmd(ymd) },
  };
  if (opts?.withReminders !== false) {
    event.reminders = {
      useDefault: false,
      overrides: OBLIGATION_EVENT_REMINDERS.map((r) => ({
        method: r.method,
        minutes: r.minutes,
      })),
    };
  } else {
    event.reminders = { useDefault: true };
  }
  return event;
}

export function buildObligationDescription(opts: {
  label: string;
  type: string;
  period: string;
  officialUrl: string;
}): string {
  const lines = [
    opts.label,
    `Type : ${opts.type}`,
    `Période : ${opts.period}`,
    "",
    `Démarche officielle : ${opts.officialUrl}`,
    "",
    "Événement synchronisé depuis KouziaCRM (rappels J-7, J-3, J-1, jour J).",
  ];
  return lines.join("\n");
}

/** Message lisible depuis une GaxiosError Google. */
export function formatGoogleApiError(err: unknown): string {
  const g = err as {
    message?: string;
    response?: {
      status?: number;
      data?: unknown;
    };
  };
  const data = g.response?.data as
    | {
        error?: {
          message?: string;
          status?: string;
          errors?: Array<{
            reason?: string;
            message?: string;
            domain?: string;
            location?: string;
          }>;
        };
      }
    | undefined;
  const error = data?.error;
  if (error) {
    const parts: string[] = [];
    if (error.message) parts.push(error.message);
    if (error.errors?.length) {
      for (const e of error.errors) {
        parts.push(
          [e.reason, e.location, e.message].filter(Boolean).join(": "),
        );
      }
    }
    const joined = parts.filter(Boolean).join(" | ");
    if (joined) {
      const status = g.response?.status;
      return status ? `HTTP ${status}: ${joined}` : joined;
    }
  }
  if (g.response?.data != null) {
    try {
      return `HTTP ${g.response.status}: ${JSON.stringify(g.response.data)}`;
    } catch {
      /* ignore */
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function httpStatus(err: unknown): number | undefined {
  return (
    (err as { code?: number; response?: { status?: number } })?.code ??
    (err as { response?: { status?: number } })?.response?.status
  );
}

async function insertEventWithFallback(
  calendar: calendar_v3.Calendar,
  fullBody: calendar_v3.Schema$Event,
  obligationId: string,
): Promise<string> {
  const attempts: Array<{ label: string; body: calendar_v3.Schema$Event }> = [
    { label: "with-reminders", body: fullBody },
    {
      label: "default-reminders",
      body: {
        summary: fullBody.summary,
        description: fullBody.description,
        start: { date: fullBody.start?.date },
        end: { date: fullBody.end?.date },
        reminders: { useDefault: true },
      },
    },
    {
      label: "minimal",
      body: {
        summary: fullBody.summary,
        start: { date: fullBody.start?.date },
        end: { date: fullBody.end?.date },
      },
    },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const created = await calendar.events.insert({
        calendarId: "primary",
        requestBody: attempt.body,
      });
      if (!created.data.id) {
        throw new Error(
          `Création événement Google échouée pour obligation ${obligationId} (${attempt.label})`,
        );
      }
      if (attempt.label !== "with-reminders") {
        console.warn(
          `[google-calendar] insert OK via fallback "${attempt.label}" pour ${obligationId}`,
        );
      }
      return created.data.id;
    } catch (err) {
      lastErr = err;
      const status = httpStatus(err);
      console.error(
        `[google-calendar] insert failed (${attempt.label})`,
        formatGoogleApiError(err),
        "payload=",
        JSON.stringify(attempt.body),
      );
      if (status !== 400) throw err;
    }
  }
  throw lastErr;
}

export async function upsertObligationEvent(
  calendar: calendar_v3.Calendar,
  obligation: Pick<
    Obligation,
    "id" | "label" | "dueDate" | "type" | "period" | "googleCalendarEventId"
  >,
  officialUrl: string,
): Promise<string> {
  const body = buildObligationEventPayload({
    label: obligation.label,
    dueDate: obligation.dueDate,
    description: buildObligationDescription({
      label: obligation.label,
      type: obligation.type,
      period: obligation.period,
      officialUrl,
    }),
  });

  if (obligation.googleCalendarEventId) {
    try {
      const updated = await calendar.events.update({
        calendarId: "primary",
        eventId: obligation.googleCalendarEventId,
        requestBody: body,
      });
      if (updated.data.id) return updated.data.id;
    } catch (err: unknown) {
      const status = httpStatus(err);
      if (status !== 404) {
        // Update d'un ancien événement horodaté peut échouer : on recrée.
        if (status === 400) {
          console.warn(
            `[google-calendar] update 400 pour ${obligation.id}, recréation`,
            formatGoogleApiError(err),
          );
        } else {
          throw err;
        }
      }
    }
  }

  return insertEventWithFallback(calendar, body, obligation.id);
}

export async function deleteObligationEvent(
  calendar: calendar_v3.Calendar,
  eventId: string,
): Promise<void> {
  try {
    await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });
  } catch (err: unknown) {
    const status = httpStatus(err);
    if (status === 404 || status === 410) return;
    throw err;
  }
}
