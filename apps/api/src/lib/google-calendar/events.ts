import type { calendar_v3 } from "googleapis";
import type { Obligation } from "@prisma/client";

const TZ = "Europe/Paris";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rappels popup échéance : J-7, J-3, J-1, jour J (à 9h Europe/Paris). */
export const OBLIGATION_DUE_REMINDERS: calendar_v3.Schema$EventReminder[] = [
  { method: "popup", minutes: 7 * 24 * 60 },
  { method: "popup", minutes: 3 * 24 * 60 },
  { method: "popup", minutes: 1 * 24 * 60 },
  { method: "popup", minutes: 0 },
];

/** Rappel popup ouverture : le jour J à 9h. */
export const OBLIGATION_OPEN_REMINDERS: calendar_v3.Schema$EventReminder[] = [
  { method: "popup", minutes: 0 },
];

/** @deprecated Alias historique des rappels d'échéance. */
export const OBLIGATION_EVENT_REMINDERS = OBLIGATION_DUE_REMINDERS;

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

export function eventStartIso(at: Date): string {
  return `${dueDateYmd(at)}T09:00:00`;
}

export function eventEndIso(at: Date): string {
  return `${dueDateYmd(at)}T09:30:00`;
}

export type ObligationEventKind = "due" | "open";

export type ObligationEventInput = {
  label: string;
  at: Date;
  description: string;
  kind: ObligationEventKind;
};

/**
 * Événement Google à 9h Europe/Paris (créneau 30 min).
 * Les rappels popup sont appliqués ensuite via patch (plus fiable que insert).
 */
export function buildObligationEventPayload(
  input: ObligationEventInput,
): calendar_v3.Schema$Event {
  const summaryBase = (input.label || "Obligation KouziaCRM").slice(0, 1000);
  const summary =
    input.kind === "open"
      ? `Ouverture : ${summaryBase}`.slice(0, 1024)
      : `Échéance : ${summaryBase}`.slice(0, 1024);
  const description = (input.description || "").slice(0, 8000);
  return {
    summary,
    description,
    start: {
      dateTime: eventStartIso(input.at),
      timeZone: TZ,
    },
    end: {
      dateTime: eventEndIso(input.at),
      timeZone: TZ,
    },
  };
}

/** @deprecated Ancienne API (dueDate only) : mappe vers kind=due. */
export function buildObligationEventPayloadLegacy(input: {
  label: string;
  dueDate: Date;
  description: string;
}): calendar_v3.Schema$Event {
  return buildObligationEventPayload({
    label: input.label,
    at: input.dueDate,
    description: input.description,
    kind: "due",
  });
}

export function buildObligationDescription(opts: {
  label: string;
  type: string;
  period: string;
  officialUrl: string;
  kind: ObligationEventKind;
}): string {
  const role =
    opts.kind === "open"
      ? "Ouverture de la fenêtre déclarative"
      : "Échéance / clôture (dernier délai)";
  const reminderHint =
    opts.kind === "open"
      ? "Rappel Google : jour J à 9h."
      : "Rappels Google : J-7, J-3, J-1, jour J à 9h.";
  const lines = [
    opts.label,
    role,
    `Type : ${opts.type}`,
    `Période : ${opts.period}`,
    "",
    `Démarche officielle : ${opts.officialUrl}`,
    "",
    `Événement synchronisé depuis KouziaCRM. ${reminderHint}`,
  ];
  return lines.join("\n");
}

export function remindersForKind(
  kind: ObligationEventKind,
): calendar_v3.Schema$EventReminder[] {
  return kind === "open" ? OBLIGATION_OPEN_REMINDERS : OBLIGATION_DUE_REMINDERS;
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

async function patchEventReminders(
  calendar: calendar_v3.Calendar,
  eventId: string,
  reminders: calendar_v3.Schema$EventReminder[],
): Promise<boolean> {
  try {
    await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: {
        reminders: {
          useDefault: false,
          overrides: reminders.map((r) => ({
            method: r.method,
            minutes: r.minutes,
          })),
        },
      },
    });
    return true;
  } catch (err) {
    console.warn(
      `[google-calendar] patch reminders failed for ${eventId}`,
      formatGoogleApiError(err),
    );
    return false;
  }
}

async function insertEventThenReminders(
  calendar: calendar_v3.Calendar,
  body: calendar_v3.Schema$Event,
  reminders: calendar_v3.Schema$EventReminder[],
  obligationId: string,
  kind: ObligationEventKind,
): Promise<string> {
  // 1) Insert sans overrides (évite le 400 observé sur certains comptes)
  const created = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      ...body,
      reminders: { useDefault: true },
    },
  });
  if (!created.data.id) {
    throw new Error(
      `Création événement Google échouée (${kind}) pour obligation ${obligationId}`,
    );
  }
  const eventId = created.data.id;
  // 2) Appliquer les rappels Kouzia via patch
  const ok = await patchEventReminders(calendar, eventId, reminders);
  if (!ok) {
    console.warn(
      `[google-calendar] événement ${kind} créé sans rappels custom (${obligationId})`,
    );
  }
  return eventId;
}

export type UpsertObligationEventsResult = {
  dueEventId: string;
  openEventId: string | null;
};

/**
 * Crée / met à jour l'événement d'échéance et, si la fenêtre a un début distinct,
 * l'événement d'ouverture.
 */
export async function upsertObligationEvents(
  calendar: calendar_v3.Calendar,
  obligation: Pick<
    Obligation,
    | "id"
    | "label"
    | "dueDate"
    | "type"
    | "period"
    | "googleCalendarEventId"
    | "googleCalendarOpenEventId"
  >,
  officialUrl: string,
  window: { opensAt: Date; closesAt: Date },
): Promise<UpsertObligationEventsResult> {
  const dueBody = buildObligationEventPayload({
    label: obligation.label,
    at: window.closesAt,
    description: buildObligationDescription({
      label: obligation.label,
      type: obligation.type,
      period: obligation.period,
      officialUrl,
      kind: "due",
    }),
    kind: "due",
  });
  const dueReminders = remindersForKind("due");

  const dueEventId = await upsertSingleEvent(
    calendar,
    obligation.googleCalendarEventId,
    dueBody,
    dueReminders,
    obligation.id,
    "due",
  );

  const openYmd = dueDateYmd(window.opensAt);
  const closeYmd = dueDateYmd(window.closesAt);
  const needOpen = openYmd !== closeYmd;

  if (!needOpen) {
    if (obligation.googleCalendarOpenEventId) {
      await deleteObligationEvent(calendar, obligation.googleCalendarOpenEventId);
    }
    return { dueEventId, openEventId: null };
  }

  const openBody = buildObligationEventPayload({
    label: obligation.label,
    at: window.opensAt,
    description: buildObligationDescription({
      label: obligation.label,
      type: obligation.type,
      period: obligation.period,
      officialUrl,
      kind: "open",
    }),
    kind: "open",
  });
  const openEventId = await upsertSingleEvent(
    calendar,
    obligation.googleCalendarOpenEventId,
    openBody,
    remindersForKind("open"),
    obligation.id,
    "open",
  );

  return { dueEventId, openEventId };
}

async function upsertSingleEvent(
  calendar: calendar_v3.Calendar,
  existingId: string | null | undefined,
  body: calendar_v3.Schema$Event,
  reminders: calendar_v3.Schema$EventReminder[],
  obligationId: string,
  kind: ObligationEventKind,
): Promise<string> {
  if (existingId) {
    try {
      const updated = await calendar.events.update({
        calendarId: "primary",
        eventId: existingId,
        requestBody: {
          ...body,
          reminders: {
            useDefault: false,
            overrides: reminders.map((r) => ({
              method: r.method,
              minutes: r.minutes,
            })),
          },
        },
      });
      if (updated.data.id) return updated.data.id;
    } catch (err: unknown) {
      const status = httpStatus(err);
      if (status !== 404 && status !== 400) throw err;
      console.warn(
        `[google-calendar] update ${kind} ${status} pour ${obligationId}, recréation`,
        formatGoogleApiError(err),
      );
      if (status === 400) {
        // Ancien événement incompatible : supprimer puis recréer
        await deleteObligationEvent(calendar, existingId);
      }
    }
  }

  return insertEventThenReminders(
    calendar,
    body,
    reminders,
    obligationId,
    kind,
  );
}

/** @deprecated Préférer upsertObligationEvents (ouverture + échéance). */
export async function upsertObligationEvent(
  calendar: calendar_v3.Calendar,
  obligation: Pick<
    Obligation,
    | "id"
    | "label"
    | "dueDate"
    | "type"
    | "period"
    | "googleCalendarEventId"
    | "googleCalendarOpenEventId"
  >,
  officialUrl: string,
): Promise<string> {
  const result = await upsertObligationEvents(
    calendar,
    obligation,
    officialUrl,
    { opensAt: obligation.dueDate, closesAt: obligation.dueDate },
  );
  return result.dueEventId;
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
