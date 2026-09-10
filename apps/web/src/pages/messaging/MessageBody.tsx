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

function htmlHasVisibleContent(html: string): boolean {
  if (/<img[\s>]/i.test(html) || /<table[\s>]/i.test(html)) return true;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0;
}

function resizeIframe(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc?.documentElement) return;
  const height = Math.max(
    doc.documentElement.scrollHeight,
    doc.body?.scrollHeight ?? 0,
    320,
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
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
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
        className="break-all text-[var(--primary)] underline decoration-[var(--primary)]/40 underline-offset-2 hover:decoration-[var(--primary)]"
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

function PlainTextBody({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\r\n/g, "\n").split("\n"), [text]);

  return (
    <div className="mt-3 space-y-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3.5 text-[15px] leading-relaxed text-[var(--text)]">
      {lines.map((line, i) => {
        const quoteMatch = /^(>+)\s?(.*)$/.exec(line);
        if (quoteMatch) {
          const depth = quoteMatch[1]!.length;
          return (
            <p
              key={i}
              className="border-l-2 border-[var(--border-strong)] pl-3 text-[var(--muted)]"
              style={{ marginLeft: Math.min(depth - 1, 3) * 8 }}
            >
              {quoteMatch[2] ? linkify(quoteMatch[2]) : "\u00A0"}
            </p>
          );
        }
        if (!line.trim()) {
          return <div key={i} className="h-2.5" aria-hidden />;
        }
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            {linkify(line)}
          </p>
        );
      })}
    </div>
  );
}

export function MessageBody({ bodyText, bodyHtml, allowRemoteImages = true }: Props) {
  const srcDoc = useMemo(() => {
    if (!bodyHtml?.trim()) return null;
    try {
      const safe = sanitizeEmailHtml(bodyHtml, { allowRemoteImages });
      if (!safe.trim() || !htmlHasVisibleContent(safe)) return null;
      return buildEmailSrcDoc(safe, { allowRemoteImages });
    } catch {
      return null;
    }
  }, [bodyHtml, allowRemoteImages]);

  if (srcDoc) {
    return (
      <iframe
        title="Corps du message"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        className="mt-4 block w-full rounded-[var(--radius)] border border-[var(--border)] bg-white [color-scheme:light]"
        style={{ colorScheme: "light", width: "100%", height: 480, minHeight: 320 }}
        onLoad={(event) => bindIframeResize(event.currentTarget)}
      />
    );
  }

  const plain = bodyText?.trim();
  if (!plain) {
    return (
      <p className="mt-3 text-sm text-[var(--muted)]">Aucun contenu texte pour ce message.</p>
    );
  }

  return <PlainTextBody text={plain} />;
}
