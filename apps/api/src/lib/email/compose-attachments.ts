import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OutboxAttachment } from "@/lib/email/mailer/types.js";

const ROOT = path.resolve(process.cwd(), "data", "uploads", "compose-drafts");

export type ComposeDraftAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: string;
};

type Manifest = Record<string, ComposeDraftAttachment>;

const manifestPath = () => path.join(ROOT, "manifest.json");

async function readManifest(): Promise<Manifest> {
  await mkdir(ROOT, { recursive: true });
  if (!existsSync(manifestPath())) return {};
  try {
    const raw = await readFile(manifestPath(), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return {};
  }
}

async function writeManifest(data: Manifest): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await writeFile(manifestPath(), JSON.stringify(data, null, 2), "utf8");
}

function absPath(storagePath: string): string {
  return path.resolve(process.cwd(), "data", "uploads", storagePath);
}

export async function saveComposeDraftAttachment(opts: {
  filename: string;
  mimeType: string;
  content: Buffer;
  maxBytes: number;
}): Promise<ComposeDraftAttachment> {
  if (opts.content.length > opts.maxBytes) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(opts.maxBytes / 1024 / 1024)} Mo)`);
  }
  const safeName = opts.filename.replace(/[^\w.\-()+ ]/g, "_").slice(0, 180) || "file";
  const id = randomUUID();
  const relDir = path.join("compose-drafts", "files");
  const stored = `${id}-${safeName}`;
  const storagePath = path.join(relDir, stored);
  const absDir = path.dirname(absPath(storagePath));
  await mkdir(absDir, { recursive: true });
  await writeFile(absPath(storagePath), opts.content);

  const entry: ComposeDraftAttachment = {
    id,
    filename: safeName,
    mimeType: opts.mimeType || "application/octet-stream",
    sizeBytes: opts.content.length,
    storagePath,
    createdAt: new Date().toISOString(),
  };

  const manifest = await readManifest();
  manifest[id] = entry;
  await writeManifest(manifest);
  return entry;
}

export async function loadComposeAttachments(ids: string[]): Promise<ComposeDraftAttachment[]> {
  const manifest = await readManifest();
  const rows: ComposeDraftAttachment[] = [];
  for (const id of ids) {
    const row = manifest[id];
    if (row && existsSync(absPath(row.storagePath))) rows.push(row);
  }
  return rows;
}

export async function composeAttachmentsToOutbox(
  ids: string[],
): Promise<OutboxAttachment[]> {
  const rows = await loadComposeAttachments(ids);
  const out: OutboxAttachment[] = [];
  for (const row of rows) {
    const content = await readFile(absPath(row.storagePath));
    out.push({
      filename: row.filename,
      contentBase64: content.toString("base64"),
      contentType: row.mimeType,
    });
  }
  return out;
}

export async function deleteComposeAttachments(ids: string[]): Promise<void> {
  const manifest = await readManifest();
  for (const id of ids) {
    const row = manifest[id];
    if (!row) continue;
    try {
      await unlink(absPath(row.storagePath));
    } catch {
      /* ignore */
    }
    delete manifest[id];
  }
  await writeManifest(manifest);
}

export async function cleanupComposeDraftsOlderThan(maxAgeMs: number): Promise<number> {
  const manifest = await readManifest();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [id, row] of Object.entries(manifest)) {
    if (new Date(row.createdAt).getTime() >= cutoff) continue;
    try {
      await unlink(absPath(row.storagePath));
    } catch {
      /* ignore */
    }
    delete manifest[id];
    removed += 1;
  }
  if (removed > 0) await writeManifest(manifest);
  return removed;
}
