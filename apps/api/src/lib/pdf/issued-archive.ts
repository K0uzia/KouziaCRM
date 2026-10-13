import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf, type LoadedDocumentForPdf } from "@/lib/pdf/document-pdf.js";

/**
 * PDF des factures et avoirs émis : rendu une fois, archivé (fichier + SHA-256), puis servi tel quel.
 * Un document émis est immuable : modifier un réglage ou une clause ne doit pas changer son PDF.
 * Dossier sous data/uploads : inclus dans la sauvegarde chiffrée (scripts/alpine/backup.sh).
 */
const ISSUED_DIR = "issued-documents";

// Racine du dépôt (KOUZIA_APP_DIR en prod, /app sous Docker) et non process.cwd() : en dev, l'API
// tourne dans apps/api et le worker à la racine ; les deux doivent lire le même dossier.
const UPLOADS_DIR =
  process.env.KOUZIA_UPLOADS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../data/uploads");

export function issuedPdfAbsolutePath(pdfPath: string): string {
  return path.resolve(UPLOADS_DIR, pdfPath);
}

type ArchiveState = {
  id: string;
  documentType: InvoiceDocumentType;
  status: InvoiceStatus;
  number: string | null;
  pdfPath: string | null;
  pdfSha256: string | null;
};

/** Facture ou avoir émis (numéroté, hors brouillon) : son PDF est archivé. Les devis ne le sont pas ici. */
export function isArchivableDocument(doc: Pick<ArchiveState, "documentType" | "status" | "number">): boolean {
  return (
    (doc.documentType === InvoiceDocumentType.INVOICE || doc.documentType === InvoiceDocumentType.CREDIT_NOTE) &&
    doc.status !== InvoiceStatus.DRAFT &&
    Boolean(doc.number)
  );
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function stateOf(id: string): Promise<ArchiveState | null> {
  return prisma.invoice.findUnique({
    where: { id },
    select: { id: true, documentType: true, status: true, number: true, pdfPath: true, pdfSha256: true },
  });
}

async function readArchived(state: ArchiveState): Promise<Buffer | null> {
  try {
    const pdf = await fs.readFile(issuedPdfAbsolutePath(state.pdfPath!));
    if (state.pdfSha256 && sha256(pdf) !== state.pdfSha256) {
      // Jamais de réécriture silencieuse : l'écart est signalé, le fichier archivé reste servi.
      console.error(`[pdf] empreinte du PDF archivé différente pour ${state.number} (${state.pdfPath})`);
      await alertArchiveProblem(state, "son empreinte SHA-256 ne correspond plus au fichier");
    }
    return pdf;
  } catch (err) {
    console.error(`[pdf] PDF archivé illisible pour ${state.number} (${state.pdfPath})`, err);
    await alertArchiveProblem(state, "le fichier archivé est introuvable ou illisible");
    return null;
  }
}

async function alertArchiveProblem(state: ArchiveState, problem: string): Promise<void> {
  try {
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    await alertAdmin(
      `PDF archivé à vérifier : ${state.number}`,
      `Le PDF archivé de ${state.number} pose problème : ${problem}. Restaurez data/uploads/${state.pdfPath} depuis la dernière sauvegarde (kouziactl restore --uploads).`,
    );
  } catch (err) {
    console.error("[pdf] alerte d'archive impossible", err);
  }
}

/** Rend et archive le PDF ; deux rendus simultanés : le premier enregistré est gardé, l'autre fichier supprimé. */
async function archiveNow(state: ArchiveState, loaded?: LoadedDocumentForPdf | null): Promise<Buffer | null> {
  const doc = loaded ?? (await loadDocumentForPdf(state.id));
  if (!doc) return null;
  const pdf = await renderLoadedDocumentPdf(doc);
  const digest = sha256(pdf);
  const safeNumber = (state.number ?? "document").replace(/[^A-Za-z0-9_-]/g, "_");
  const pdfPath = `${ISSUED_DIR}/${safeNumber}-${state.id}-${digest.slice(0, 12)}-${randomBytes(3).toString("hex")}.pdf`;
  const abs = issuedPdfAbsolutePath(pdfPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, pdf, { flag: "wx" });

  const claimed = await prisma.invoice.updateMany({
    where: { id: state.id, pdfPath: null },
    data: { pdfPath, pdfSha256: digest, pdfArchivedAt: new Date() },
  });
  if (claimed.count === 1) return pdf;

  await fs.rm(abs, { force: true });
  const winner = await stateOf(state.id);
  return winner?.pdfPath ? readArchived(winner) : null;
}

/**
 * PDF d'un document : archivé pour une facture ou un avoir émis (créé au premier appel), sinon null
 * (devis, brouillon : à rendre à la volée par l'appelant).
 */
export async function issuedDocumentPdf(id: string, loaded?: LoadedDocumentForPdf | null): Promise<Buffer | null> {
  const state = await stateOf(id);
  if (!state || !isArchivableDocument(state)) return null;
  if (state.pdfPath) {
    const archived = await readArchived(state);
    if (archived) return archived;
    // Fichier perdu : rendu du moment pour ne pas bloquer le client, sans remplacer l'archive (alerte envoyée).
    const doc = loaded ?? (await loadDocumentForPdf(id));
    return doc ? renderLoadedDocumentPdf(doc) : null;
  }
  return archiveNow(state, loaded);
}

/** Archive à l'émission. Ne jette pas : l'émission est acquise, l'archive se refera au premier accès. */
export async function archiveIssuedDocument(id: string): Promise<void> {
  try {
    await issuedDocumentPdf(id);
  } catch (err) {
    console.error(`[pdf] archivage à l'émission impossible pour ${id}`, err);
  }
}

/** Rattrapage (worker, kouziactl archive-pdfs) : factures et avoirs émis sans PDF archivé. */
export async function archivePendingIssuedPdfs(limit = 50): Promise<number> {
  const pending = await prisma.invoice.findMany({
    where: {
      documentType: { in: [InvoiceDocumentType.INVOICE, InvoiceDocumentType.CREDIT_NOTE] },
      status: { not: InvoiceStatus.DRAFT },
      number: { not: null },
      pdfPath: null,
    },
    select: { id: true },
    orderBy: { issuedAt: "asc" },
    take: limit,
  });
  let archived = 0;
  for (const { id } of pending) {
    try {
      if (await issuedDocumentPdf(id)) archived += 1;
    } catch (err) {
      console.error(`[pdf] rattrapage impossible pour ${id}`, err);
    }
  }
  return archived;
}
