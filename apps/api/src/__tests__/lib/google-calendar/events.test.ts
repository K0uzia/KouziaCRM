import { describe, expect, it } from "vitest";
import {
  buildObligationEventPayload,
  buildObligationDescription,
  dueDateYmd,
  eventStartIso,
  nextDayYmd,
  OBLIGATION_DUE_REMINDERS,
  OBLIGATION_EVENT_REMINDERS,
  OBLIGATION_OPEN_REMINDERS,
  remindersForKind,
} from "@/lib/google-calendar/events.js";
import {
  buildObligationReminderEmail,
  stageTargetYmd,
} from "@/lib/obligations/email-reminders.js";

describe("google-calendar event payload", () => {
  it("construit un événement d'échéance à 9h Europe/Paris", () => {
    const due = new Date("2026-04-15T12:00:00.000Z");
    const ymd = dueDateYmd(due);
    const payload = buildObligationEventPayload({
      label: "Déclaration URSSAF : mars 2026",
      at: due,
      description: buildObligationDescription({
        label: "Déclaration URSSAF : mars 2026",
        type: "URSSAF_DECLARATION",
        period: "2026-03",
        officialUrl: "https://autoentrepreneur.urssaf.fr",
        kind: "due",
      }),
      kind: "due",
    });

    expect(payload.summary).toBe("Échéance : Déclaration URSSAF : mars 2026");
    expect(payload.start?.dateTime).toBe(`${ymd}T09:00:00`);
    expect(payload.start?.timeZone).toBe("Europe/Paris");
    expect(payload.end?.dateTime).toBe(`${ymd}T09:30:00`);
    expect(payload.reminders).toBeUndefined();
    expect(payload.description).toContain("https://autoentrepreneur.urssaf.fr");
    expect(payload.description).toContain("Échéance / clôture");
    expect(eventStartIso(due)).toBe(`${ymd}T09:00:00`);
  });

  it("construit un événement d'ouverture distinct", () => {
    const opens = new Date("2026-04-01T10:00:00.000Z");
    const payload = buildObligationEventPayload({
      label: "Déclaration URSSAF : mars 2026",
      at: opens,
      description: buildObligationDescription({
        label: "Déclaration URSSAF : mars 2026",
        type: "URSSAF_DECLARATION",
        period: "2026-03",
        officialUrl: "https://autoentrepreneur.urssaf.fr",
        kind: "open",
      }),
      kind: "open",
    });
    expect(payload.summary).toBe("Ouverture : Déclaration URSSAF : mars 2026");
    expect(payload.description).toContain("Ouverture de la fenêtre");
    expect(remindersForKind("open")).toEqual(OBLIGATION_OPEN_REMINDERS);
    expect(remindersForKind("due")).toEqual(OBLIGATION_DUE_REMINDERS);
    expect(OBLIGATION_EVENT_REMINDERS).toEqual(OBLIGATION_DUE_REMINDERS);
  });

  it("dueDateYmd produit toujours YYYY-MM-DD", () => {
    expect(dueDateYmd(new Date("2026-04-15T12:00:00.000Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    const ymd = dueDateYmd(new Date("2026-04-15T12:00:00.000Z"));
    expect(nextDayYmd(ymd)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("obligation email reminders", () => {
  it("calcule les jalons J-7 / J-3 / J-1 / jour J", () => {
    const due = new Date("2026-04-15T10:00:00.000Z");
    const dueYmd = dueDateYmd(due);
    expect(stageTargetYmd(due, 0)).toBe(dueYmd);
    expect(stageTargetYmd(due, -1)).toBe(
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
