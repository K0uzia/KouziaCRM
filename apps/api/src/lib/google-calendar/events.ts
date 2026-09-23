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
 * Marqué avec extendedProperties.private pour éviter les doublons à la sync.
 * Les rappels popup sont appliqués ensuite via patch (plus fiable que insert).
 */
export function buildObligationEventPayload(
  input: ObligationEventInput & { obligationId?: string },
): calendar_v3.Schema$Event {
  const summaryBase = (input.label || "Obligation KouziaCRM").slice(0, 1000);
  const summary =
    input.kind === "open"
      ? `Ouverture : ${summaryBase}`.slice(0, 1024)
      : `Échéance : ${summaryBase}`.slice(0, 1024);
  const description = (input.description || "").slice(0, 8000);
  const event: calendar_v3.Schema$Event = {
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
  if (input.obligationId) {
    event.extendedProperties = {
      private: {
        kouziaObligationId: input.obligationId,
        kouziaKind: input.kind,
      },
    };
  }
  return event;
}

export function kouziaPrivateProps(
  obligationId: string,
  kind: ObligationEventKind,
): NonNullable<calendar_v3.Schema$Event["extendedProperties"]> {
  return {
    private: {
      kouziaObligationId: obligationId,
      kouziaKind: kind,
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

/** Retrouve un événement Kouzia déjà créé (évite les doublons si l'id DB est perdu). */
export async function findExistingKouziaEventId(
  calendar: calendar_v3.Calendar,
  obligationId: string,
  kind: ObligationEventKind,
): Promise<string | null> {
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      privateExtendedProperty: [
        `kouziaObligationId=${obligationId}`,
        `kouziaKind=${kind}`,
      ],
      singleEvents: true,
      maxResults: 5,
      showDeleted: false,
    });
    const items = (res.data.items ?? []).filter((e) => e.id && e.status !== "cancelled");
    if (items.length === 0) return null;
    // Garder le plus récent, supprimer les doublons éventuels
    const [keep, ...dupes] = items.sort((a, b) => {
      const ta = a.updated ? Date.parse(a.updated) : 0;
      const tb = b.updated ? Date.parse(b.updated) : 0;
      return tb - ta;
    });
    for (const d of dupes) {
      if (d.id) {
        console.warn(
          `[google-calendar] suppression doublon ${kind} ${d.id} (obligation ${obligationId})`,
        );
        await deleteObligationEvent(calendar, d.id);
      }
    }
    return keep.id ?? null;
  } catch (err) {
    console.warn(
      `[google-calendar] recherche événement existant échouée (${kind})`,
      formatGoogleApiError(err),
    );
    return null;
  }
}

async function patchEventBody(
  calendar: calendar_v3.Calendar,
  eventId: string,
  body: calendar_v3.Schema$Event,
): Promise<string | null> {
  try {
    const updated = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: body,
    });
    return updated.data.id ?? eventId;
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404 || status === 410) return null;
    throw err;
  }
}

async function insertEventThenReminders(
  calendar: calendar_v3.Calendar,
  body: calendar_v3.Schema$Event,
  reminders: calendar_v3.Schema$EventReminder[],
  obligationId: string,
  kind: ObligationEventKind,
): Promise<string> {
  const created = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      ...body,
      extendedProperties: kouziaPrivateProps(obligationId, kind),
      reminders: { useDefault: true },
    },
  });
  if (!created.data.id) {
    throw new Error(
      `Création événement Google échouée (${kind}) pour obligation ${obligationId}`,
    );
  }
  const eventId = created.data.id;
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
 * l'événement d'ouverture. Idempotent : ne recrée pas si l'event existe déjà.
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
    obligationId: obligation.id,
  });

  const dueEventId = await upsertSingleEvent(
    calendar,
    obligation.googleCalendarEventId,
    dueBody,
    remindersForKind("due"),
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
    // Nettoyer un éventuel doublon open marqué
    const strayOpen = await findExistingKouziaEventId(calendar, obligation.id, "open");
    if (strayOpen) await deleteObligationEvent(calendar, strayOpen);
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
    obligationId: obligation.id,
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

/**
 * Met à jour l'événement existant, sinon le retrouve via extendedProperties,
 * sinon le crée. Ne crée jamais un doublon volontairement.
 */
async function upsertSingleEvent(
  calendar: calendar_v3.Calendar,
  existingId: string | null | undefined,
  body: calendar_v3.Schema$Event,
  reminders: calendar_v3.Schema$EventReminder[],
  obligationId: string,
  kind: ObligationEventKind,
): Promise<string> {
  const bodyWithMark: calendar_v3.Schema$Event = {
    ...body,
    extendedProperties: kouziaPrivateProps(obligationId, kind),
  };

  let eventId = existingId?.trim() || null;

  if (!eventId) {
    eventId = await findExistingKouziaEventId(calendar, obligationId, kind);
  }

  if (eventId) {
    try {
      // Patch du corps (sans rappels) puis patch rappels : évite le 400 full-update
      const patchedId = await patchEventBody(calendar, eventId, bodyWithMark);
      if (patchedId) {
        await patchEventReminders(calendar, patchedId, reminders);
        // Au cas où des doublons existent encore pour cette obligation
        const again = await findExistingKouziaEventId(calendar, obligationId, kind);
        return again ?? patchedId;
      }
      // 404 : l'id stocké est mort, chercher / créer
      eventId = await findExistingKouziaEventId(calendar, obligationId, kind);
      if (eventId) {
        const revived = await patchEventBody(calendar, eventId, bodyWithMark);
        if (revived) {
          await patchEventReminders(calendar, revived, reminders);
          return revived;
        }
      }
    } catch (err: unknown) {
      const status = httpStatus(err);
      if (status !== 400) throw err;
      console.warn(
        `[google-calendar] patch ${kind} 400 pour ${obligationId}, tentative insert si absent`,
        formatGoogleApiError(err),
      );
      const found = await findExistingKouziaEventId(calendar, obligationId, kind);
      if (found) return found;
    }
  }

  // Dernière chance avant insert : re-scan (course / sync parallèle)
  const preexisting = await findExistingKouziaEventId(calendar, obligationId, kind);
  if (preexisting) {
    const patched = await patchEventBody(calendar, preexisting, bodyWithMark);
    if (patched) {
      await patchEventReminders(calendar, patched, reminders);
      return patched;
    }
  }

  // Anciens events sans extendedProperties : même titre + même jour
  const legacy = await findLegacyEventBySummaryAndDay(
    calendar,
    bodyWithMark.summary ?? "",
    bodyWithMark.start?.dateTime?.slice(0, 10) ?? "",
  );
  if (legacy) {
    const patched = await patchEventBody(calendar, legacy, bodyWithMark);
    if (patched) {
      await patchEventReminders(calendar, patched, reminders);
      return patched;
    }
  }

  return insertEventThenReminders(
    calendar,
    bodyWithMark,
    reminders,
    obligationId,
    kind,
  );
}

/** Events créés avant le marquage kouzia* : match titre + jour. */
async function findLegacyEventBySummaryAndDay(
  calendar: calendar_v3.Calendar,
  summary: string,
  ymd: string,
): Promise<string | null> {
  if (!summary || !YMD_RE.test(ymd)) return null;
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      q: summary,
      singleEvents: true,
      maxResults: 15,
      timeMin: `${ymd}T00:00:00Z`,
      timeMax: `${nextDayYmd(ymd)}T00:00:00Z`,
      showDeleted: false,
    });
    const matches = (res.data.items ?? []).filter((e) => {
      if (!e.id || e.status === "cancelled") return false;
      if (e.summary !== summary) return false;
      const start =
        e.start?.dateTime?.slice(0, 10) ?? e.start?.date?.slice(0, 10) ?? "";
      return start === ymd;
    });
    if (matches.length === 0) return null;
    const [keep, ...dupes] = matches;
    for (const d of dupes) {
      if (d.id) await deleteObligationEvent(calendar, d.id);
    }
    return keep.id ?? null;
  } catch {
    return null;
  }
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
