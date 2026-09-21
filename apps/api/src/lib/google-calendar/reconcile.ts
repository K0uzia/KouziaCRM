import { ObligationStatus } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import {
  officialLinkForObligationType,
  resolveOfficialLinks,
} from "@/lib/obligations/links.js";
import { prisma } from "@/lib/prisma.js";
import { getAuthedCalendarClient } from "@/lib/google-calendar/oauth.js";
import {
  deleteObligationEvent,
  upsertObligationEvent,
} from "@/lib/google-calendar/events.js";

export type ReconcileResult = {
  upserted: number;
  deleted: number;
  skipped: boolean;
  error?: string;
};

/**
 * Aligne les événements Google avec les obligations ouvertes.
 * No-op si Google non connecté. Ne lance pas : log + retour d'erreur.
 */
export async function reconcileObligationCalendarEvents(): Promise<ReconcileResult> {
  try {
    const calendar = await getAuthedCalendarClient();
    if (!calendar) {
      return { upserted: 0, deleted: 0, skipped: true };
    }

    const settings = await getCompanySettings();
    const links = resolveOfficialLinks(settings.officialLinks);

    const open = await prisma.obligation.findMany({
      where: { status: { not: ObligationStatus.DONE } },
    });
    const doneWithEvent = await prisma.obligation.findMany({
      where: {
        status: ObligationStatus.DONE,
        googleCalendarEventId: { not: null },
      },
    });

    let upserted = 0;
    let deleted = 0;

    for (const obl of open) {
      const url = officialLinkForObligationType(obl.type, links);
      const eventId = await upsertObligationEvent(calendar, obl, url);
      if (eventId !== obl.googleCalendarEventId) {
        await prisma.obligation.update({
          where: { id: obl.id },
          data: { googleCalendarEventId: eventId },
        });
      }
      upserted += 1;
    }

    for (const obl of doneWithEvent) {
      if (!obl.googleCalendarEventId) continue;
      await deleteObligationEvent(calendar, obl.googleCalendarEventId);
      await prisma.obligation.update({
        where: { id: obl.id },
        data: { googleCalendarEventId: null },
      });
      deleted += 1;
    }

    return { upserted, deleted, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google-calendar] reconcile failed", err);
    return { upserted: 0, deleted: 0, skipped: false, error: message };
  }
}

/** Supprime l'événement Google d'une obligation confirmée. */
export async function removeObligationCalendarEvent(
  obligationId: string,
  eventId: string | null | undefined,
): Promise<void> {
  if (!eventId) return;
  try {
    const calendar = await getAuthedCalendarClient();
    if (calendar) {
      await deleteObligationEvent(calendar, eventId);
    }
  } catch (err) {
    console.error("[google-calendar] delete event failed", err);
  }
  await prisma.obligation.update({
    where: { id: obligationId },
    data: { googleCalendarEventId: null },
  });
}
