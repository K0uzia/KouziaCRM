import { describe, expect, it } from "vitest";
import {
  buildObligationEventPayload,
  buildObligationDescription,
  dueDateYmd,
  eventStartIso,
  nextDayYmd,
  OBLIGATION_EVENT_REMINDERS,
} from "@/lib/google-calendar/events.js";
import {
  buildObligationReminderEmail,
  stageTargetYmd,
} from "@/lib/obligations/email-reminders.js";

describe("google-calendar event payload", () => {
  it("construit un événement journée entière Europe/Paris avec 4 rappels popup", () => {
    const due = new Date("2026-04-15T12:00:00.000Z");
    const ymd = dueDateYmd(due);
    const payload = buildObligationEventPayload({
      label: "Déclaration URSSAF : mars 2026",
      dueDate: due,
      description: buildObligationDescription({
        label: "Déclaration URSSAF : mars 2026",
        type: "URSSAF_DECLARATION",
        period: "2026-03",
        officialUrl: "https://autoentrepreneur.urssaf.fr",
      }),
    });

    expect(payload.summary).toBe("Déclaration URSSAF : mars 2026");
    expect(payload.start?.date).toBe(ymd);
    expect(payload.end?.date).toBe(nextDayYmd(ymd));
    expect(payload.start?.dateTime).toBeUndefined();
    expect(payload.reminders?.useDefault).toBe(false);
    expect(payload.reminders?.overrides).toEqual(OBLIGATION_EVENT_REMINDERS);
    expect(payload.reminders?.overrides).toHaveLength(4);
    expect(payload.description).toContain("https://autoentrepreneur.urssaf.fr");
    // helpers horaires encore exportés (compat)
    expect(eventStartIso(due)).toBe(`${ymd}T09:00:00`);
  });
});

describe("obligation email reminders", () => {
  it("calcule les jalons J-7 / J-3 / J-1 / jour J", () => {
    const due = new Date("2026-04-15T10:00:00.000Z");
    const dueYmd = dueDateYmd(due);
    expect(stageTargetYmd(due, 0)).toBe(dueYmd);
    expect(stageTargetYmd(due, -1)).toBe(
      // veille
      (() => {
        const [y, m, d] = dueYmd.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - 1);
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
      })(),
    );
    expect(stageTargetYmd(due, -7)).not.toBe(dueYmd);
  });

  it("construit un email de rappel sans tiret cadratin", () => {
    const mail = buildObligationReminderEmail({
      label: "Déclaration URSSAF : mars 2026",
      stageLabel: "J-7",
      dueYmd: "2026-04-15",
      officialUrl: "https://autoentrepreneur.urssaf.fr",
      brandName: "Kouzia",
    });
    expect(mail.subject).toContain("J-7");
    expect(mail.subject).toContain("Déclaration URSSAF");
    expect(mail.text).toContain("https://autoentrepreneur.urssaf.fr");
    expect(mail.html).toContain("Ouvrir la démarche officielle");
    expect(mail.subject + mail.text + mail.html).not.toMatch(/\u2014/);
  });
});
