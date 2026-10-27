import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Rattrapage URSSAF du 27/10/2026 : les périodes passées ajoutées « à vérifier » ne vont pas dans Google Agenda (des
// dizaines d'événements dans le passé) ; seules les démarches à faire y sont.
const upsertObligationEvents = vi.fn(async () => ({ dueEventId: "evt-due", openEventId: "evt-open" }));
vi.mock("@/lib/google-calendar/oauth.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-calendar/oauth.js")>()),
  getAuthedCalendarClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/google-calendar/events.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-calendar/events.js")>()),
  upsertObligationEvents,
  deleteObligationEvents: vi.fn(async () => undefined),
}));

const { reconcileObligationCalendarEvents } = await import("@/lib/google-calendar/reconcile.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  upsertObligationEvents.mockClear();
});

describe("Google Agenda et périodes à vérifier", () => {
  it("période « à vérifier » : aucun événement ; période à déclarer : événement", async () => {
    await prisma.obligation.create({ data: { type: "URSSAF_DECLARATION", period: "2025-04", dueDate: new Date(2025, 4, 15), label: "Déclaration URSSAF : avril 2025", status: "TO_CHECK" } });
    const pending = await prisma.obligation.create({ data: { type: "URSSAF_DECLARATION", period: "2026-11", dueDate: new Date(2026, 11, 15), label: "Déclaration URSSAF : novembre 2026", status: "PENDING" } });
    await reconcileObligationCalendarEvents();
    expect(upsertObligationEvents).toHaveBeenCalledTimes(1);
    expect((upsertObligationEvents.mock.calls[0] as unknown[]).some((a) => (a as { id?: string })?.id === pending.id)).toBe(true);
  });
});
