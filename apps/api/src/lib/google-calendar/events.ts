import type { calendar_v3 } from "googleapis";
import type { Obligation } from "@prisma/client";

const TZ = "Europe/Paris";

/** Rappels popup : J-7, J-3, J-1, à l'heure de l'événement (9h). */
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

/** Début événement : 09:00 Europe/Paris le jour de clôture. */
export function eventStartIso(dueDate: Date): string {
  const ymd = dueDateYmd(dueDate);
  return `${ymd}T09:00:00`;
}

export function eventEndIso(dueDate: Date): string {
  const ymd = dueDateYmd(dueDate);
  return `${ymd}T09:30:00`;
}

export type ObligationEventInput = {
  label: string;
  dueDate: Date;
  description: string;
};

/** Payload Google Calendar (sans appels réseau) : testable unitairement. */
export function buildObligationEventPayload(
  input: ObligationEventInput,
): calendar_v3.Schema$Event {
  return {
    summary: input.label,
    description: input.description,
    start: {
      dateTime: eventStartIso(input.dueDate),
      timeZone: TZ,
    },
    end: {
      dateTime: eventEndIso(input.dueDate),
      timeZone: TZ,
    },
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
