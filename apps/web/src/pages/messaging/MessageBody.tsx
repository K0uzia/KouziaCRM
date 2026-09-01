import { useMemo } from "react";
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
        className="mt-4 block w-full border-0 bg-white [color-scheme:light]"
        style={{ colorScheme: "light", width: "100%", height: 480, minHeight: 320 }}
        onLoad={(event) => bindIframeResize(event.currentTarget)}
      />
    );
  }

  return (
    <pre className="mt-4 whitespace-pre-wrap font-[family-name:var(--font)]">
      {bodyText?.trim() ? bodyText : "Aucun contenu texte pour ce message."}
    </pre>
  );
}
