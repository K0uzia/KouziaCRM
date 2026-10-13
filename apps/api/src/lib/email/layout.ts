import type { CompanySettings } from "@prisma/client";
import { readableOn, resolveBrandColors } from "@/lib/brand.js";

/**
 * Version HTML des emails automatiques, construite à partir du texte brut (qui reste la
 * référence : partie text/plain et historique de la messagerie). Charte Kouzia : bandeau
 * nuit, filet ambre, bouton ambre. Tableaux et styles en ligne pour les clients mail
 * (Outlook, Gmail), aucune image distante.
 */

export type EmailLayoutBrand = {
  tradeName: string;
  legalName: string;
  siret: string;
  addressLine1: string;
  postalCode: string;
  city: string;
  website?: string | null;
};

export type EmailLayoutOptions = {
  text: string;
  brand: EmailLayoutBrand;
  colors?: Partial<Pick<CompanySettings, "brandPrimaryColor" | "brandSecondaryColor">> | null;
  /** Lien de paiement : la ligne du texte qui le contient devient un bouton. */
  paymentUrl?: string | null;
  paymentLabel?: string;
  /** Paragraphe du texte (identique) rendu dans un encadré apparent : date limite légale, par exemple. */
  callout?: string | null;
};

const FONT = "'Exo 2','Segoe UI',Arial,Helvetica,sans-serif";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function linkify(escaped: string, linkColor: string): string {
  return escaped.replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
    const url = raw.replace(/[),.;:!?\]]+$/, "");
    const trailing = raw.slice(url.length);
    return `<a href="${url}" style="color:${linkColor};text-decoration:underline;word-break:break-all;">${url}</a>${trailing}`;
  });
}

function button(url: string, label: string, primary: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;"><tr><td style="border-radius:8px;background:${primary};">
<a href="${href}" style="display:inline-block;padding:13px 24px;font-family:${FONT};font-size:15px;font-weight:700;color:${readableOn(primary)};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>
<p style="margin:6px 0 16px;font-family:${FONT};font-size:12px;line-height:1.5;color:#5b6478;">Le bouton ne fonctionne pas ? Copiez ce lien : <span style="word-break:break-all;">${href}</span></p>`;
}

/** Texte brut → paragraphes HTML (ligne vide = nouveau paragraphe, retour simple = <br>). */
function textToHtml(
  text: string,
  opts: { paymentUrl?: string | null; paymentLabel: string; primary: string; secondary: string; callout?: string | null },
) {
  const pay = opts.paymentUrl?.trim();
  const callout = opts.callout?.trim();
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return blocks
    .map((block) => {
      if (callout && block.trim() === callout) {
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;"><tr><td style="padding:14px 18px;border:2px solid ${opts.primary};border-radius:8px;background:#fff8ec;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.5;color:#1f2433;">${escapeHtml(callout)}</td></tr></table>`;
      }
      const lines = block.split("\n");
      const parts: string[] = [];
      let buffer: string[] = [];
      const flush = () => {
        if (!buffer.length) return;
        parts.push(
          `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:#1f2433;">${buffer.join("<br>")}</p>`,
        );
        buffer = [];
      };
      for (const line of lines) {
        // Ligne « Payer en ligne : <url> » ou URL seule de paiement : bouton.
        if (pay && line.includes(pay)) {
          const before = line.slice(0, line.indexOf(pay)).replace(/\s*:?\s*$/, "").trim();
          if (before) buffer.push(escapeHtml(before));
          flush();
          parts.push(button(pay, opts.paymentLabel, opts.primary));
          continue;
        }
        buffer.push(linkify(escapeHtml(line), opts.secondary));
      }
      flush();
      return parts.join("\n");
    })
    .join("\n");
}

export function renderEmailHtml(opts: EmailLayoutOptions): string {
  const { primary, secondary } = resolveBrandColors(opts.colors);
  const name = escapeHtml(opts.brand.tradeName || opts.brand.legalName);
  const body = textToHtml(opts.text, {
    paymentUrl: opts.paymentUrl,
    paymentLabel: opts.paymentLabel ?? "Payer en ligne",
    primary,
    secondary,
    callout: opts.callout,
  });
  const footer = [
    opts.brand.legalName,
    `SIRET ${opts.brand.siret}`,
    [opts.brand.addressLine1, `${opts.brand.postalCode} ${opts.brand.city}`].filter((s) => s.trim()).join(", "),
  ]
    .filter((s) => s.trim())
    .map(escapeHtml)
    .join(" · ");
  const site = opts.brand.website?.trim()
    ? `<br><a href="${escapeHtml(opts.brand.website.trim())}" style="color:#5b6478;">${escapeHtml(opts.brand.website.trim().replace(/^https?:\/\//, ""))}</a>`
    : "";

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${name}</title></head>
<body style="margin:0;padding:0;background:#f2f3f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f3f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e3e6ee;">
<tr><td style="background:${secondary};padding:18px 28px;border-bottom:3px solid ${primary};font-family:${FONT};font-size:18px;font-weight:700;color:${readableOn(secondary)};">${name}</td></tr>
<tr><td style="padding:28px 28px 14px;">
${body}
</td></tr>
<tr><td style="padding:14px 28px 20px;border-top:1px solid #e3e6ee;font-family:${FONT};font-size:11px;line-height:1.5;color:#5b6478;">${footer}${site}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
