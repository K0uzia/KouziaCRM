import { lineTotalCents } from "@/lib/money";

export type LineInput = {
  description: string;
  quantity: number | string;
  unitPriceCents: number;
  position?: number;
};

export function computeLineTotals(lines: LineInput[]) {
  const computed = lines.map((line, index) => {
    const qty = Number(line.quantity);
    const total = lineTotalCents(qty, line.unitPriceCents);
    return {
      position: line.position ?? index + 1,
      description: line.description.trim(),
      quantity: qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: total,
    };
  });

  const subtotalCents = computed.reduce((sum, l) => sum + l.lineTotalCents, 0);
  return { lines: computed, subtotalCents, totalCents: subtotalCents };
}
