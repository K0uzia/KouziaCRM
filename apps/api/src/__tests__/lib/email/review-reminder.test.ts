import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// E6b : rappel des e-mails à valider depuis plus de 24 h (push, sinon e-mail à l'admin), jamais la nuit ; cloche et push.
const push = vi.hoisted(() => ({ sent: 0 }));
vi.mock("@/lib/push/service.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/push/service.js")>()),
  sendToAll: vi.fn(async () => ({ sent: push.sent, failed: 0, removed: 0 })),
}));

const { isNight, remindStaleReviews } = await import("@/lib/email/review-reminder.js");
const { sendToAll } = await import("@/lib/push/service.js");
const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { listNotifications } = await import("@/lib/notifications/feed.js");
const { PUSHED_KINDS } = await import("@/lib/push/dispatch.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
  await prisma.companySettings.updateMany({ data: { email: "contact@kouzia.test" } });
  vi.mocked(sendToAll).mockClear();
  push.sent = 1;
});

async function inReview(createdAt: Date, clientWaiting = false) {
  const { outboxId } = await mailEnqueue(
    { to: "lou@example.com", subject: "Relance", text: "x", kind: "reminder_soft" },
    { review: { family: "reminder", origin: "WORKER", clientWaiting } },
  );
  await prisma.emailOutbox.update({ where: { id: outboxId }, data: { createdAt } });
  return outboxId;
}

// 24/10/2026 : heure d'été de Paris (UTC+2).
const PARIS_10H = new Date("2026-10-24T08:00:00Z");
const PARIS_23H = new Date("2026-10-24T21:00:00Z");
const PARIS_7H = new Date("2026-10-24T05:00:00Z");

describe("rappel des e-mails à valider", () => {
  it("heures de nuit (22 h à 8 h, heure de Paris)", () => {
    expect(isNight(PARIS_10H)).toBe(false);
    expect(isNight(PARIS_23H)).toBe(true);
    expect(isNight(PARIS_7H)).toBe(true);
  });

  it("après 24 h seulement, jamais la nuit, un rappel groupé puis au plus un par 24 h", async () => {
    await inReview(new Date(PARIS_10H.getTime() - 2 * 3_600_000));
    await inReview(new Date(PARIS_10H.getTime() - 30 * 3_600_000), true);
    await inReview(new Date(PARIS_10H.getTime() - 50 * 3_600_000));

    expect(await remindStaleReviews(PARIS_23H)).toBe(0);
    expect(await remindStaleReviews(PARIS_10H)).toBe(2);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToAll).mock.calls[0]![0]).toMatchObject({
      body: "2 e-mails attendent votre validation depuis plus de 24 h, dont 1 où le client attend.",
      url: "/emails-a-valider",
    });
    expect(await remindStaleReviews(new Date(PARIS_10H.getTime() + 3_600_000))).toBe(0);
    expect(await remindStaleReviews(new Date(PARIS_10H.getTime() + 25 * 3_600_000))).toBe(3);
  });

  it("aucun appareil abonné : e-mail à l'adresse de l'entreprise, qui part sans validation", async () => {
    push.sent = 0;
    await inReview(new Date(PARIS_10H.getTime() - 30 * 3_600_000));
    expect(await remindStaleReviews(PARIS_10H)).toBe(1);
    const alert = await prisma.emailOutbox.findFirst({ where: { reviewKind: "stripe_alert" } });
    expect(alert?.status).toBe(EmailOutboxStatus.PENDING);
  });

  it("cloche et push : chaque e-mail mis en attente, sans contenu ni destinataire", async () => {
    const since = new Date(Date.now() - 60_000);
    const id = await inReview(new Date(), true);
    const items = (await listNotifications(since)).filter((i) => i.kind === "email_review");
    expect(items).toEqual([expect.objectContaining({ id: `email_review:${id}`, title: "E-mail à valider : le client attend", href: `/emails-a-valider?id=${id}` })]);
    expect(items[0]!.body).toBe("Relance : à relire avant l'envoi.");
    expect(JSON.stringify(items)).not.toContain("lou@example.com");
    expect(PUSHED_KINDS.has("email_review")).toBe(true);
  });
});
