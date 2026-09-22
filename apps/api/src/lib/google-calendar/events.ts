import type { calendar_v3 } from "googleapis";
import type { Obligation } from "@prisma/client";

const TZ = "Europe/Paris";

/** Rappels popup : J-7, J-3, J-1, jour J (minuit du jour d'échéance, événement journée entière). */
export const OBLIGATION_EVENT_REMINDERS: calendar_v3.Schema$EventReminder[] = [
  { method: "popup", minutes: 7 * 24 * 60 },
  { method: "popup", minutes: 3 * 24 * 60 },
  { method: "popup", minutes: 1 * 24 * 60 },
  { method: "popup", minutes: 0 },
];

/** Date locale YYYY-MM-DD (Europe/Paris). */
export function dueDateYmd(dueDate: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(dueDate);
}

/** Jour suivant (fin exclusive Google pour événement journée entière). */
export function nextDayYmd(ymd: string): string {
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
 * Payload Google Calendar (sans appels réseau) : journée entière.
 * Les échéances fiscales sont des dates, pas des créneaux horaires ;
 * `start.date` / `end.date` évite les 400 Bad Request sur dateTime+timeZone.
 */
export function buildObligationEventPayload(
  input: ObligationEventInput,
): calendar_v3.Schema$Event {
  const ymd = dueDateYmd(input.dueDate);
  return {
    summary: input.label,
    description: input.description,
    start: { date: ymd },
    end: { date: nextDayYmd(ymd) },
    reminders: {
      useDefault: false,
      overrides: OBLIGATION_EVENT_REMINDERS,
    },
  };
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
      data?: {
        error?: {
          message?: string;
          status?: string;
          errors?: Array<{ reason?: string; message?: string; domain?: string }>;
        };
      };
    };
  };
  const data = g.response?.data?.error;
  if (data) {
    const parts: string[] = [];
    if (data.message) parts.push(data.message);
    if (data.errors?.length) {
      for (const e of data.errors) {
        parts.push([e.reason, e.message].filter(Boolean).join(": "));
      }
    }
    const joined = parts.filter(Boolean).join(" | ");
    if (joined) {
      const status = g.response?.status;
      return status ? `HTTP ${status}: ${joined}` : joined;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export async function upsertObligationEvent(
  calendar: calendar_v3.Calendar,
  obligation: Pick<Obligation, "id" | "label" | "dueDate" | "type" | "period" | "googleCalendarEventId">,
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
      const status = (err as { code?: number; response?: { status?: number } })?.code
        ?? (err as { response?: { status?: number } })?.response?.status;
      if (status !== 404) throw err;
      // événement disparu côté Google : recréer
    }
  }

  const created = await calendar.events.insert({
    calendarId: "primary",
    requestBody: body,
  });
  if (!created.data.id) {
    throw new Error(`Création événement Google échouée pour obligation ${obligation.id}`);
  }
  return created.data.id;
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
    const status = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return;
    throw err;
  }
}
