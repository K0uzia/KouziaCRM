import { describe, expect, it } from "vitest";
import {
  buildEmailSrcDoc,
  prepareEmailHtmlForSanitize,
  sanitizeEmailHtml,
} from "@/lib/email/sanitize-html.js";

describe("sanitizeEmailHtml", () => {
  it("neutralise un script injecté", () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const safe = sanitizeEmailHtml(html);
    expect(safe).not.toContain("<script");
    expect(safe).toContain("Hello");
  });

  it("conserve les images distantes par défaut", () => {
    const html = '<img src="https://evil.example/track.png" alt="x">';
    const safe = sanitizeEmailHtml(html);
    expect(safe).toContain("https://evil.example/track.png");
    expect(safe).not.toContain("data-blocked-src");
  });

  it("bloque les images distantes si demandé", () => {
    const html = '<img src="https://evil.example/track.png" alt="x">';
    const safe = sanitizeEmailHtml(html, { allowRemoteImages: false });
    expect(safe).toContain("data:image/svg");
    expect(safe).toContain("data-blocked-src");
  });

  it("autorise les images distantes si demandé", () => {
    const html = '<img src="https://example.com/logo.png" alt="logo">';
    const safe = sanitizeEmailHtml(html, { allowRemoteImages: true });
    expect(safe).toContain("https://example.com/logo.png");
  });

  it("conserve les styles inline et les boutons-liens marketing", () => {
    const html =
      '<a href="https://example.com" style="display:inline-block;background-color:#191C1F;color:#FFFFFF;padding:10px 16px">Action</a>';
    const safe = sanitizeEmailHtml(html, { allowRemoteImages: true });
    expect(safe).toContain("background-color");
    expect(safe).toContain("https://example.com");
    expect(safe).toContain("Action");
  });

  it("conserve un email HTML complet type Revolut", async () => {
    const { prisma } = await import("@/lib/prisma.js");
    const msg = await prisma.emailMessage.findUnique({
      where: { id: "cmtio6fxe001tze52v0l45ow3" },
      select: { bodyHtml: true },
    });
    if (!msg?.bodyHtml) return;

    const safe = sanitizeEmailHtml(msg.bodyHtml, { allowRemoteImages: true });
    expect(safe.length).toBeGreaterThan(10_000);
    expect(safe).toContain("Autoriser cette demande");
    expect(safe).toContain("<style");
    expect(safe).not.toContain("<script");
  });
});

describe("prepareEmailHtmlForSanitize", () => {
  it("supprime background transparent incompatible avec jsdom", () => {
    const html =
      '<a style="background: transparent; line-height: 1.375; font-size: 14px; background-color: #191C1F">x</a>';
    const prepared = prepareEmailHtmlForSanitize(html);
    expect(prepared).not.toContain("background: transparent");
    expect(prepared).toContain("background-color: #191C1F");
  });
});

describe("buildEmailSrcDoc", () => {
  it("ajoute base target blank pour les liens", () => {
    const doc = buildEmailSrcDoc("<p>test</p>");
    expect(doc).toContain('<base target="_blank"');
    expect(doc).toContain("<body>");
  });

  it("force un canvas clair pour contrer le color-scheme dark du CRM", () => {
    const doc = buildEmailSrcDoc(
      '<html><head><meta name="color-scheme" content="dark"></head><body style="color:#fff"><p>Hello</p></body></html>',
    );
    expect(doc).toContain('name="color-scheme" content="light only"');
    expect(doc).toContain("color-scheme:light only");
    expect(doc).toContain("background-color:#ffffff");
    expect(doc).toContain("color:#1a1a1a !important");
    expect(doc).not.toContain('name="color-scheme" content="dark"');
  });

  it("neutralise les media queries prefers-color-scheme dark", () => {
    const doc = buildEmailSrcDoc(
      "<style>@media (prefers-color-scheme: dark){body{color:#fff}}</style><p>x</p>",
    );
    expect(doc).toContain("prefers-color-scheme: never");
    expect(doc).not.toMatch(/prefers-color-scheme:\s*dark/);
  });

  it("neutralise color-scheme light dark resté dans le CSS", () => {
    const doc = buildEmailSrcDoc(
      "<style>:root{color-scheme: light dark}</style><p>x</p>",
    );
    expect(doc).toContain("color-scheme: light");
    expect(doc).not.toMatch(/color-scheme:\s*light dark/);
  });

  it("conserve les images distantes par défaut dans le srcdoc", () => {
    const html = sanitizeEmailHtml('<img src="https://cdn.example/logo.png" alt="logo">');
    const doc = buildEmailSrcDoc(html);
    expect(doc).toContain("https://cdn.example/logo.png");
  });
});
