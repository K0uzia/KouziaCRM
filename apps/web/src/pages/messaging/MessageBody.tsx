import { useMemo, type ReactNode } from "react";
import {
  buildEmailSrcDoc,
  sanitizeEmailHtml,
} from "@kouziacrm/email-sanitize";

type Props = {
  bodyText: string | null;
  bodyHtml: string | null;
  allowRemoteImages?: boolean;
};

/**
 * Newsletter / template HTML (layout table + images).
 * Une simple réponse avec <blockquote> ou styles inline n'en est PAS une.
 */
function isLayoutHeavyHtml(html: string): boolean {
  const imgCount = (html.match(/<img[\s>]/gi) ?? []).length;
  const hasLayoutTable =
    /<table[\s>]/i.test(html) && /<(td|th)[\s>]/i.test(html);
  if (hasLayoutTable && imgCount >= 1) return true;
  if (imgCount >= 3) return true;
  if (hasLayoutTable && html.length > 8_000) return true;
  return false;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<hr[^>]*>/gi, "\n---\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resizeIframe(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) return;
  const height = Math.max(
    doc.documentElement.scrollHeight,
    doc.body?.scrollHeight ?? 0,
    160,
  );
  iframe.style.height = `${height}px`;
}

function bindIframeResize(iframe: HTMLIFrameElement) {
  resizeIframe(iframe);
  const doc = iframe.contentDocument;
  if (!doc) return;
  for (const img of Array.from(doc.images)) {
    img.addEventListener("load", () => resizeIframe(iframe), { once: true });
  }
}

function linkify(text: string): ReactNode[] {
  const re = /https?:\/\/[^\s<>"']+/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    let url = match[0];
    let trailing = "";
    const trimmed = url.replace(/[),.;:!?\]]+$/, "");
    if (trimmed.length < url.length) {
      trailing = url.slice(trimmed.length);
      url = trimmed;
    }
    nodes.push(
      <a
        key={`u-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-[var(--primary)] underline decoration-[var(--primary)]/35 underline-offset-2 hover:decoration-[var(--primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isQuoteLine(line: string): boolean {
  if (/^>/.test(line)) return true;
  if (/^(-{2,}|_{2,})\s*$/.test(line)) return true;
  if (/^On .+ wrote:\s*$/i.test(line)) return true;
  if (/^Le .+ a écrit\s*:\s*$/i.test(line)) return true;
  if (/^From:\s+/i.test(line)) return true;
  if (/^-{5,}Original Message-{5,}/i.test(line)) return true;
  return false;
}

/**
 * Rendu type client mail : corps + citations en retrait, sans iframe.
 */
function ConversationBody({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const out: Array<{ quote: boolean; lines: string[] }> = [];
    for (const line of lines) {
      const quote = isQuoteLine(line) || (out.length > 0 && out[out.length - 1]!.quote && /^>/.test(line));
      // Une ligne vide après du quote reste dans le quote si la suivante est quote
      const last = out[out.length - 1];
      if (last && last.quote === quote) {
        last.lines.push(line);
      } else if (last && !line.trim() && last.quote) {
        last.lines.push(line);
      } else {
        out.push({ quote, lines: [line] });
      }
    }
    return out;
  }, [text]);

  return (
    <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-[var(--text)]">
      {blocks.map((block, bi) => {
        const content = block.lines.map((line, i) => {
          const display = line.replace(/^>\s?/, "");
          if (!line.trim()) {
            return <div key={i} className="h-2" aria-hidden />;
          }
          return (
            <p key={i} className="whitespace-pre-wrap break-words">
              {linkify(display)}
            </p>
          );
        });
        if (block.quote) {
          return (
            <div
              key={bi}
              className="border-l-2 border-[var(--border-strong)] pl-3 text-[13px] text-[var(--muted)]"
            >
              {content}
            </div>
          );
        }
        return (
          <div key={bi} className="space-y-0.5">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function IframeBody({
  html,
  allowRemoteImages,
}: {
  html: string;
  allowRemoteImages: boolean;
}) {
  const srcDoc = useMemo(() => {
    try {
      const safe = sanitizeEmailHtml(html, { allowRemoteImages });
      if (!safe.trim()) return null;
      return buildEmailSrcDoc(safe, { allowRemoteImages });
    } catch {
      return null;
    }
  }, [html, allowRemoteImages]);

  if (!srcDoc) return null;

  return (
    <div className="mt-3 w-full min-w-0 overflow-x-auto">
    <iframe
      title="Corps du message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="block w-full min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-white [color-scheme:light]"
      style={{ colorScheme: "light", width: "100%", height: 320, minHeight: 120 }}
      onLoad={(event) => bindIframeResize(event.currentTarget)}
    />
    </div>
  );
}

/**
 * Affichage corps email façon boîte mail :
 * 1. text/plain prioritaire (réponses, conversations)
 * 2. HTML simple → converti en texte
 * 3. HTML layout (newsletter) → iframe isolé
 */
export function MessageBody({
  bodyText,
  bodyHtml,
  allowRemoteImages = true,
}: Props) {
  const decision = useMemo(() => {
    const plain = (bodyText ?? "").trim();
    const html = (bodyHtml ?? "").trim();

    // 1. Texte brut présent → toujours conversation (jamais d'iframe)
    if (plain) {
      return { mode: "text" as const, text: plain };
    }

    if (!html) {
      return { mode: "empty" as const };
    }

    // 2. HTML lourd (newsletter) → iframe
    if (isLayoutHeavyHtml(html)) {
      return { mode: "iframe" as const, html };
    }

    // 3. HTML simple / réponse → texte extrait
    const extracted = htmlToPlainText(html);
    if (extracted) {
      return { mode: "text" as const, text: extracted };
    }

    return { mode: "empty" as const };
  }, [bodyText, bodyHtml]);

  if (decision.mode === "text") {
    return <ConversationBody text={decision.text} />;
  }

  if (decision.mode === "iframe") {
    return (
      <IframeBody html={decision.html} allowRemoteImages={allowRemoteImages} />
    );
  }

  return (
    <p className="mt-3 text-sm text-[var(--muted)]">Aucun contenu pour ce message.</p>
  );
}
