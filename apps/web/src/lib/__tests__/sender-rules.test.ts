import { describe, expect, it } from "vitest";
import { ruleCounter } from "@/pages/messaging/sender-rules";

const fmt = (d: string) => d.slice(0, 10);
const base = { createdAt: "2026-10-01T10:00:00Z", lastHitAt: null, hitCount: 0, source: "MANUAL" };

describe("suivi d'une règle d'expéditeur", () => {
  it("blocage sans message, avec messages, venu d'un signalement", () => {
    expect(ruleCounter({ ...base, action: "BLOCK" }, fmt)).toBe("Ajouté le 2026-10-01. Aucun message bloqué pour l'instant.");
    expect(ruleCounter({ ...base, action: "BLOCK", hitCount: 3, lastHitAt: "2026-10-20T08:00:00Z" }, fmt)).toBe(
      "3 messages bloqués, le dernier le 2026-10-20",
    );
    expect(ruleCounter({ ...base, action: "BLOCK", hitCount: 1, lastHitAt: "2026-10-02T08:00:00Z" }, fmt)).toBe(
      "1 message bloqué, le dernier le 2026-10-02",
    );
    expect(ruleCounter({ ...base, action: "BLOCK", source: "REPORT" }, fmt)).toMatch(/en signalant un indésirable/);
  });

  it("confiance : date d'ajout seulement", () => {
    expect(ruleCounter({ ...base, action: "TRUST" }, fmt)).toBe("Ajouté le 2026-10-01");
  });
});
