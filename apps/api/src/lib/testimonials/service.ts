import { TestimonialStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export class TestimonialError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function clientHasSubmittedTestimonial(clientId: string): Promise<boolean> {
  const existing = await prisma.clientTestimonial.findFirst({
    where: {
      clientId,
      status: { in: [TestimonialStatus.PENDING, TestimonialStatus.PUBLISHED] },
    },
    select: { id: true },
  });
  return Boolean(existing);
}

export async function submitClientTestimonial(opts: {
  clientId: string;
  authorName: string;
  body: string;
}) {
  const authorName = opts.authorName.trim();
  const body = opts.body.trim();
  if (authorName.length < 2) {
    throw new TestimonialError("Indiquez votre nom", 400);
  }
  if (body.length < 20) {
    throw new TestimonialError("Écrivez un avis un peu plus détaillé", 400);
  }
  if (body.length > 800) {
    throw new TestimonialError("Avis trop long (800 caractères maximum)", 400);
  }

  if (await clientHasSubmittedTestimonial(opts.clientId)) {
    throw new TestimonialError("Avis déjà envoyé", 409);
  }

  return prisma.clientTestimonial.create({
    data: {
      clientId: opts.clientId,
      authorName,
      body,
      status: TestimonialStatus.PENDING,
    },
  });
}

export async function listPublishedTestimonials() {
  return prisma.clientTestimonial.findMany({
    where: { status: TestimonialStatus.PUBLISHED },
    orderBy: { publishedAt: "desc" },
    take: 12,
    select: {
      id: true,
      authorName: true,
      body: true,
      publishedAt: true,
    },
  });
}

export async function listAdminTestimonials() {
  return prisma.clientTestimonial.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      client: { select: { id: true, displayName: true, clientNumber: true } },
    },
  });
}

export async function publishTestimonial(id: string) {
  const row = await prisma.clientTestimonial.findUnique({ where: { id } });
  if (!row) throw new TestimonialError("Avis introuvable", 404);
  return prisma.clientTestimonial.update({
    where: { id },
    data: {
      status: TestimonialStatus.PUBLISHED,
      publishedAt: row.publishedAt ?? new Date(),
    },
  });
}

export async function unpublishTestimonial(id: string) {
  const row = await prisma.clientTestimonial.findUnique({ where: { id } });
  if (!row) throw new TestimonialError("Avis introuvable", 404);
  return prisma.clientTestimonial.update({
    where: { id },
    data: { status: TestimonialStatus.PENDING, publishedAt: null },
  });
}

export async function rejectTestimonial(id: string) {
  const row = await prisma.clientTestimonial.findUnique({ where: { id } });
  if (!row) throw new TestimonialError("Avis introuvable", 404);
  return prisma.clientTestimonial.update({
    where: { id },
    data: { status: TestimonialStatus.REJECTED, publishedAt: null },
  });
}
