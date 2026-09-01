import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(process.cwd(), "data", "uploads", "email-attachments");

export function emailAttachmentsRoot(): string {
  return ROOT;
}

export function attachmentAbsPath(storagePath: string): string {
  return path.resolve(process.cwd(), "data", "uploads", storagePath);
}

export async function saveEmailAttachment(opts: {
  messageId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): Promise<{ storagePath: string; sizeBytes: number }> {
  const safeName = opts.filename.replace(/[^\w.\-()+ ]/g, "_").slice(0, 180) || "file";
  const relDir = path.join("email-attachments", opts.messageId);
  const absDir = path.join(process.cwd(), "data", "uploads", relDir);
  await mkdir(absDir, { recursive: true });
  const stored = `${randomUUID()}-${safeName}`;
  const abs = path.join(absDir, stored);
  await writeFile(abs, opts.content);
  return {
    storagePath: path.join(relDir, stored),
    sizeBytes: opts.content.length,
  };
}

export function openAttachmentStream(storagePath: string) {
  const abs = attachmentAbsPath(storagePath);
  if (!existsSync(abs)) return null;
  return createReadStream(abs);
}

export async function ensureAttachmentsDir() {
  await mkdir(ROOT, { recursive: true });
}
