import { ObligationStatus } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import {
  officialLinkForObligationType,
  resolveOfficialLinks,
} from "@/lib/obligations/links.js";
import { resolveObligationWindow } from "@/lib/obligations/window.js";
import { prisma } from "@/lib/prisma.js";
import { getAuthedCalendarClient } from "@/lib/google-calendar/oauth.js";
import {
  deleteObligationEvent,
  formatGoogleApiError,
  upsertObligationEvents,
} from "@/lib/google-calendar/events.js";

export type ReconcileResult = {
  upserted: number;
  deleted: number;
  skipped: boolean;
  error?: string;
};

/**
 * Aligne les événements Google avec les obligations ouvertes
 * (ouverture de fenêtre + échéance / clôture).
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
        OR: [
          { googleCalendarEventId: { not: null } },
          { googleCalendarOpenEventId: { not: null } },
        ],
      },
    });

    let upserted = 0;
    let deleted = 0;

    for (const obl of open) {
      const url = officialLinkForObligationType(obl.type, links);
      const window = resolveObligationWindow(obl, settings);
      const { dueEventId, openEventId } = await upsertObligationEvents(
        calendar,
        obl,
        url,
        window,
      );
      if (
        dueEventId !== obl.googleCalendarEventId ||
        openEventId !== obl.googleCalendarOpenEventId
      ) {
        await prisma.obligation.update({
          where: { id: obl.id },
          data: {
            googleCalendarEventId: dueEventId,
            googleCalendarOpenEventId: openEventId,
          },
        });
      }
      upserted += 1;
    }

    for (const obl of doneWithEvent) {
      if (obl.googleCalendarEventId) {
        await deleteObligationEvent(calendar, obl.googleCalendarEventId);
      }
      if (obl.googleCalendarOpenEventId) {
        await deleteObligationEvent(calendar, obl.googleCalendarOpenEventId);
      }
      await prisma.obligation.update({
        where: { id: obl.id },
        data: {
          googleCalendarEventId: null,
          googleCalendarOpenEventId: null,
        },
      });
      deleted += 1;
    }

    return { upserted, deleted, skipped: false };
  } catch (err) {
    const message = formatGoogleApiError(err);
    console.error("[google-calendar] reconcile failed", message, err);
    return { upserted: 0, deleted: 0, skipped: false, error: message };
  }
}

/** Supprime les événements Google d'une obligation (ouverture + échéance). */
export async function removeObligationCalendarEvent(
  obligationId: string,
  ids: {
    dueId?: string | null;
    openId?: string | null;
  },
): Promise<void> {
  const dueId = ids.dueId;
  const openId = ids.openId;
  if (!dueId && !openId) {
    await prisma.obligation.update({
      where: { id: obligationId },
      data: {
        googleCalendarEventId: null,
        googleCalendarOpenEventId: null,
      },
    });
    return;
  }
  try {
    const calendar = await getAuthedCalendarClient();
    if (calendar) {
      if (dueId) await deleteObligationEvent(calendar, dueId);
      if (openId) await deleteObligationEvent(calendar, openId);
    }
  } catch (err) {
    console.error("[google-calendar] delete event failed", err);
  }
  await prisma.obligation.update({
    where: { id: obligationId },
    data: {
      googleCalendarEventId: null,
      googleCalendarOpenEventId: null,
    },
  });
}
