import { randomBytes } from "node:crypto";
import {
  InvoiceDocumentType,
  NumberingDocumentType,
  type CompanySettings,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";

function newCounterId(): string {
  return `c${randomBytes(12).toString("hex")}`;
}

export type AllocatedNumber = {
  number: string;
  sequenceYear: number;
  sequenceNumber: number;
  documentType: NumberingDocumentType;
};

export type NumberingPreview = {
  series: NumberingDocumentType;
  year: number;
  lastValue: number;
  nextValue: number;
  nextPreview: string;
  template: string;
};

export type AuditHole = { expected: number; missing: true };
export type AuditDuplicate = { value: number; numbers: string[]; count: number };
export type SeriesAudit = {
  series: NumberingDocumentType;
  year: number;
  counterLastValue: number | null;
  issuedCount: number;
  maxSequence: number | null;
  holes: number[];
  duplicates: AuditDuplicate[];
  orphanNumbers: string[];
  ok: boolean;
};

const SERIES = [
  NumberingDocumentType.FACTURE,
  NumberingDocumentType.DEVIS,
  NumberingDocumentType.AVOIR,
] as const;

export function invoiceDocTypeToSeries(
  documentType: InvoiceDocumentType,
): NumberingDocumentType {
  switch (documentType) {
    case InvoiceDocumentType.QUOTE:
      return NumberingDocumentType.DEVIS;
    case InvoiceDocumentType.CREDIT_NOTE:
      return NumberingDocumentType.AVOIR;
    default:
      return NumberingDocumentType.FACTURE;
  }
}

function templateFor(
  settings: CompanySettings,
  series: NumberingDocumentType,
): string {
  switch (series) {
    case NumberingDocumentType.DEVIS:
      return settings.quoteNumberTemplate || "D-{year}-{counter}";
    case NumberingDocumentType.AVOIR:
      return settings.creditNoteNumberTemplate || "A-{year}-{counter}";
    default:
      return settings.invoiceNumberTemplate || "F-{year}-{counter}";
  }
}

function prefixFromTemplate(template: string): string {
  const m = template.match(/^([^{}\-]+)/);
  return (m?.[1] ?? "F").replace(/-$/, "") || "F";
}

/** Formate un numéro depuis le template Settings ({prefix}, {year}, {counter}). */
export function formatDocumentNumber(params: {
  template: string;
  year: number;
  counter: number;
  width: number;
}): string {
  const width = Math.min(8, Math.max(1, params.width || 4));
  const counterStr = String(params.counter).padStart(width, "0");
  const prefix = prefixFromTemplate(params.template);
  return params.template
    .replaceAll("{prefix}", prefix)
    .replaceAll("{year}", String(params.year))
    .replaceAll("{counter}", counterStr);
}

function legacyKey(series: NumberingDocumentType, year: number): string {
  return `${series}:${year}`;
}

function legacyStartFor(
  settings: CompanySettings,
  series: NumberingDocumentType,
  year: number,
): number {
  const raw = settings.numberingLegacyStarts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  const map = raw as Record<string, unknown>;
  const v = map[legacyKey(series, year)];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return 0;
}

/**
 * Incrémente atomiquement le compteur (type, année) dans la transaction courante.
 * SQLite : un seul writer ; upsert + UPDATE RETURNING dans $transaction = tout-ou-rien.
 */
export async function generateDocumentNumber(
  series: NumberingDocumentType,
  opts: {
    issueDate?: Date;
    tx: Prisma.TransactionClient;
    settings?: CompanySettings;
  },
): Promise<AllocatedNumber> {
  const settings = opts.settings ?? (await getCompanySettings());
  const sequenceYear = (opts.issueDate ?? new Date()).getFullYear();
  const width = settings.numberCounterWidth || 4;
  const template = templateFor(settings, series);
  const initial = legacyStartFor(settings, series, sequenceYear);

  // INSERT OR IGNORE puis UPDATE ... RETURNING (atomique sous le lock writer SQLite)
  await opts.tx.$executeRaw`
    INSERT OR IGNORE INTO "Counter" ("id", "documentType", "year", "lastValue")
    VALUES (${newCounterId()}, ${series}, ${sequenceYear}, ${initial})
  `;

  const rows = await opts.tx.$queryRaw<Array<{ lastValue: number | bigint }>>`
    UPDATE "Counter"
    SET "lastValue" = "lastValue" + 1
    WHERE "documentType" = ${series} AND "year" = ${sequenceYear}
    RETURNING "lastValue"
  `;

  const last = rows[0]?.lastValue;
  if (last == null) {
    throw new Error(`Compteur introuvable pour ${series}/${sequenceYear}`);
  }
  const sequenceNumber = Number(last);
  if (!Number.isFinite(sequenceNumber) || sequenceNumber < 1) {
    throw new Error("Incrément de compteur invalide");
  }

  return {
    number: formatDocumentNumber({
      template,
      year: sequenceYear,
      counter: sequenceNumber,
      width,
    }),
    sequenceYear,
    sequenceNumber,
    documentType: series,
  };
}

/** Raccourcis métier (même série FACTURE pour factures et acomptes). */
export async function allocateInvoiceNumber(
  issueDate: Date = new Date(),
  tx: Prisma.TransactionClient,
  settings?: CompanySettings,
): Promise<AllocatedNumber> {
  return generateDocumentNumber(NumberingDocumentType.FACTURE, {
    issueDate,
    tx,
    settings,
  });
}

export async function allocateQuoteNumber(
  issueDate: Date = new Date(),
  tx: Prisma.TransactionClient,
  settings?: CompanySettings,
): Promise<AllocatedNumber> {
  return generateDocumentNumber(NumberingDocumentType.DEVIS, {
    issueDate,
    tx,
    settings,
  });
}

export async function allocateCreditNoteNumber(
  issueDate: Date = new Date(),
  tx: Prisma.TransactionClient,
  settings?: CompanySettings,
): Promise<AllocatedNumber> {
  return generateDocumentNumber(NumberingDocumentType.AVOIR, {
    issueDate,
    tx,
    settings,
  });
}

export async function previewNextNumbers(
  settings?: CompanySettings,
  at = new Date(),
): Promise<NumberingPreview[]> {
  const s = settings ?? (await getCompanySettings());
  const year = at.getFullYear();
  const width = s.numberCounterWidth || 4;
  const out: NumberingPreview[] = [];

  for (const series of SERIES) {
    const row = await prisma.counter.findUnique({
      where: { documentType_year: { documentType: series, year } },
    });
    const lastValue =
      row?.lastValue ?? legacyStartFor(s, series, year);
    const nextValue = lastValue + 1;
    const template = templateFor(s, series);
    out.push({
      series,
      year,
      lastValue,
      nextValue,
      nextPreview: formatDocumentNumber({
        template,
        year,
        counter: nextValue,
        width,
      }),
      template,
    });
  }
  return out;
}

/**
 * Recalcule lastValue = max(sequenceNumber) émis pour chaque série/année,
 * sans jamais baisser un compteur déjà plus haut (évite collision).
 */
export async function reseedCountersFromDatabase(): Promise<{
  updated: Array<{ series: NumberingDocumentType; year: number; lastValue: number }>;
}> {
  const groups = await prisma.invoice.groupBy({
    by: ["documentType", "sequenceYear"],
    where: {
      number: { not: null },
      sequenceYear: { not: null },
      sequenceNumber: { not: null },
      status: { not: "DRAFT" },
    },
    _max: { sequenceNumber: true },
  });

  const updated: Array<{
    series: NumberingDocumentType;
    year: number;
    lastValue: number;
  }> = [];

  await prisma.$transaction(async (tx) => {
    for (const g of groups) {
      if (g.sequenceYear == null || g._max.sequenceNumber == null) continue;
      const series = invoiceDocTypeToSeries(g.documentType);
      const year = g.sequenceYear;
      const fromDb = g._max.sequenceNumber;

      await tx.$executeRaw`
        INSERT OR IGNORE INTO "Counter" ("id", "documentType", "year", "lastValue")
        VALUES (${newCounterId()}, ${series}, ${year}, ${fromDb})
      `;

      const existing = await tx.counter.findUnique({
        where: { documentType_year: { documentType: series, year } },
      });
      const nextLast = Math.max(existing?.lastValue ?? 0, fromDb);
      await tx.counter.update({
        where: { documentType_year: { documentType: series, year } },
        data: { lastValue: nextLast },
      });
      updated.push({ series, year, lastValue: nextLast });
    }
  });

  return { updated };
}

/** Audit d'intégrité : trous et doublons par série / exercice. */
export async function auditNumberingIntegrity(): Promise<{
  generatedAt: string;
  series: SeriesAudit[];
  ok: boolean;
}> {
  const counters = await prisma.counter.findMany();
  const issued = await prisma.invoice.findMany({
    where: {
      number: { not: null },
      sequenceYear: { not: null },
      sequenceNumber: { not: null },
      status: { not: "DRAFT" },
    },
    select: {
      number: true,
      documentType: true,
      sequenceYear: true,
      sequenceNumber: true,
    },
    orderBy: [{ sequenceYear: "asc" }, { sequenceNumber: "asc" }],
  });

  const keyOf = (series: NumberingDocumentType, year: number) =>
    `${series}:${year}`;

  const byKey = new Map<
    string,
    { series: NumberingDocumentType; year: number; seqs: Map<number, string[]> }
  >();

  for (const inv of issued) {
    if (inv.sequenceYear == null || inv.sequenceNumber == null || !inv.number) {
      continue;
    }
    const series = invoiceDocTypeToSeries(inv.documentType);
    const k = keyOf(series, inv.sequenceYear);
    let bucket = byKey.get(k);
    if (!bucket) {
      bucket = { series, year: inv.sequenceYear, seqs: new Map() };
      byKey.set(k, bucket);
    }
    const list = bucket.seqs.get(inv.sequenceNumber) ?? [];
    list.push(inv.number);
    bucket.seqs.set(inv.sequenceNumber, list);
  }

  // Inclure les années présentes uniquement en Counter
  for (const c of counters) {
    const k = keyOf(c.documentType, c.year);
    if (!byKey.has(k)) {
      byKey.set(k, { series: c.documentType, year: c.year, seqs: new Map() });
    }
  }

  const seriesReports: SeriesAudit[] = [];

  for (const bucket of [...byKey.values()].sort(
    (a, b) => a.year - b.year || a.series.localeCompare(b.series),
  )) {
    const counter = counters.find(
      (c) => c.documentType === bucket.series && c.year === bucket.year,
    );
    const values = [...bucket.seqs.keys()].sort((a, b) => a - b);
    const maxSequence = values.length ? values[values.length - 1]! : null;
    const holes: number[] = [];
    if (maxSequence != null) {
      for (let n = 1; n <= maxSequence; n++) {
        if (!bucket.seqs.has(n)) holes.push(n);
      }
    }
    const duplicates: AuditDuplicate[] = [];
    for (const [value, numbers] of bucket.seqs) {
      if (numbers.length > 1) {
        duplicates.push({ value, numbers, count: numbers.length });
      }
    }
    const orphanNumbers: string[] = [];
    // Numéros émis hors alignement compteur (sequence > lastValue)
    if (counter && maxSequence != null && maxSequence > counter.lastValue) {
      for (const [value, numbers] of bucket.seqs) {
        if (value > counter.lastValue) orphanNumbers.push(...numbers);
      }
    }

    const ok = holes.length === 0 && duplicates.length === 0;
    seriesReports.push({
      series: bucket.series,
      year: bucket.year,
      counterLastValue: counter?.lastValue ?? null,
      issuedCount: [...bucket.seqs.values()].reduce((s, n) => s + n.length, 0),
      maxSequence,
      holes,
      duplicates,
      orphanNumbers,
      ok,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    series: seriesReports,
    ok: seriesReports.every((s) => s.ok),
  };
}

/** Compat tests / imports historiques */
export function formatInvoiceNumber(year: number, seq: number, width = 4): string {
  return formatDocumentNumber({
    template: "F-{year}-{counter}",
    year,
    counter: seq,
    width,
  });
}

export function formatQuoteNumber(year: number, seq: number, width = 4): string {
  return formatDocumentNumber({
    template: "D-{year}-{counter}",
    year,
    counter: seq,
    width,
  });
}
