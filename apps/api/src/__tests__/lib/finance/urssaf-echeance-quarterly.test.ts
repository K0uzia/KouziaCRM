import { describe, expect, it } from "vitest";
import {
  nextOfficialQuarterlyDeadlineOnOrAfter,
  quarterBoundsOfficial,
  urssafOfficialQuarterlyDeadline,
} from "@/lib/finance/urssaf-echeance.js";

describe("urssaf échéances trimestrielles officielles", () => {
  it("T4 2026 : 31/01/2027 dimanche → 01/02/2027", () => {
    const q4 = quarterBoundsOfficial(2026, 4);
    expect(q4.periodKey).toBe("2026-Q4");
    expect(q4.deadline.getFullYear()).toBe(2027);
    expect(q4.deadline.getMonth()).toBe(1);
    expect(q4.deadline.getDate()).toBe(1);
  });

  it("T2 2027 : 31/07/2027 samedi → 02/08/2027", () => {
    const q2 = quarterBoundsOfficial(2027, 2);
    expect(q2.deadline.getFullYear()).toBe(2027);
    expect(q2.deadline.getMonth()).toBe(7);
    expect(q2.deadline.getDate()).toBe(2);
  });

  it("T1 2027 : 30/04/2027", () => {
    const q1 = quarterBoundsOfficial(2027, 1);
    expect(q1.deadline.getMonth()).toBe(3);
    expect(q1.deadline.getDate()).toBe(30);
  });

  it("délai 90 j : prochaine échéance officielle après grâce", () => {
    // Début ~01/09/2026 + 90 j ≈ fin novembre → prochaine échéance T4 = 01/02/2027
    const grace = new Date(2026, 10, 30, 12, 0, 0, 0);
    const due = nextOfficialQuarterlyDeadlineOnOrAfter(grace);
    expect(due.getFullYear()).toBe(2027);
    expect(due.getMonth()).toBe(1);
    expect(due.getDate()).toBe(1);
  });

  it("urssafOfficialQuarterlyDeadline sur fin de T3", () => {
    const end = new Date(2026, 8, 30, 23, 59, 59, 999);
    const d = urssafOfficialQuarterlyDeadline(end);
    // 31/10/2026 samedi → 02/11/2026
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(2);
  });
});
