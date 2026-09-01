import DOMPurify from "isomorphic-dompurify";
import type { Config } from "dompurify";

const BLOCKED_REMOTE_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

/** Outlook / broken template CSS that makes jsdom throw during DOMPurify parse. */
export function prepareEmailHtmlForSanitize(html: string): string {
  return html
    .replace(/background:\s*transparent;\s*/gi, "")
    .replace(/mso-[a-z-]+:\s*[^;"']+;?\s*/gi, "")
    .replace(/\sstyle\s+width=/gi, " width=")
    .replace(/NaN(?:NaN)?px/gi, "600px")
    .replace(/\bwidth="NaN"/gi, 'width="600"');
}

const EMAIL_SANITIZE_CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  ADD_TAGS: ["html", "head", "body", "style", "link", "meta", "title"],
  ADD_ATTR: [
    "target",
    "rel",
    "style",
    "class",
    "bgcolor",
    "align",
    "valign",
    "width",
    "height",
    "cellpadding",
    "cellspacing",
    "border",
    "role",
    "aria-label",
    "media",
    "type",
    "href",
    "src",
    "alt",
    "data-blocked-src",
  ],
};

export function applyRemoteImagesPolicy(
  html: string,
  allowRemoteImages: boolean,
): string {
  if (allowRemoteImages) {
    return html.replace(
      /data-blocked-src=(["'])(https?:[^"']+)\1/gi,
      "src=$1$2$1",
    );
  }

  return html
    .replace(
      /data-blocked-src=(["'])(https?:[^"']+)\1/gi,
      'src=$1$2$1 blocked-placeholder=$1true$1',
    )
    .replace(/src=(["'])https?:[^"']+\1/gi, 'src="about:blank" data-blocked="true"');
}

export function sanitizeEmailHtml(
  html: string,
  opts: { allowRemoteImages?: boolean } = {},
): string {
  const prepared = prepareEmailHtmlForSanitize(html);
  const clean = DOMPurify.sanitize(prepared, EMAIL_SANITIZE_CONFIG);

  if (opts.allowRemoteImages !== false) return clean;

  return clean.replace(
    /<img([^>]*)\ssrc=(["'])(https?:[^"']+)\2/gi,
    `<img$1 src=${BLOCKED_REMOTE_IMG} data-blocked-src="$3"`,
  );
}

/** Canvas clair: le CRM est dark (color-scheme), les emails HTML sont conçus pour fond blanc. */
const EMAIL_LIGHT_HEAD =
  '<meta name="color-scheme" content="light only">' +
  '<meta name="supported-color-schemes" content="light">' +
  "<style>" +
  ":root,html,body{color-scheme:light only !important;background-color:#ffffff !important;color:#1a1a1a !important;}" +
  "html,body{min-height:320px;}" +
  "</style>";

function neutralizeEmailDarkMode(html: string): string {
  return html
    .replace(/<meta[^>]*name=["'](?:supported-)?color-schemes?["'][^>]*>/gi, "")
    .replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: never")
    .replace(/color-scheme\s*:\s*(?:only\s+)?(?:light\s+dark|dark)\b/gi, "color-scheme: light");
}

export function buildEmailSrcDoc(
  html: string,
  opts: { allowRemoteImages?: boolean } = {},
): string {
  const withImages = applyRemoteImagesPolicy(html, opts.allowRemoteImages !== false);
  const neutralized = neutralizeEmailDarkMode(withImages);
  let doc = /^\s*(?:<!doctype|<html[\s>])/i.test(neutralized)
    ? neutralized
    : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${neutralized}</body></html>`;

  const base = /<base[\s>]/i.test(doc)
    ? ""
    : '<base target="_blank" rel="noopener noreferrer">';
  const inject = `${EMAIL_LIGHT_HEAD}${base}`;

  if (/<\/head>/i.test(doc)) {
    return doc.replace(/<\/head>/i, `${inject}</head>`);
  }
  if (/<html[^>]*>/i.test(doc)) {
    return doc.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${inject}</head>`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${doc}</body></html>`;
}

export function sanitizePlainText(text: string): string {
  return text.replace(/\0/g, "");
}
