import { useEffect, useRef } from "react";

/** Miniature fidèle : première page du PDF rendu par l'API, dessinée par pdf.js (aussi sur Android). */
export function PdfThumbnail({
  pdf,
  label,
  errorMessage,
  onPages,
  onError,
}: {
  pdf: ArrayBuffer | null;
  /** Nom accessible de la miniature. */
  label: string;
  /** Message si le dessin échoue (le PDF reste ouvrable en grand). */
  errorMessage: string;
  onPages: (n: number) => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    const target = canvas.current;
    let destroy: (() => Promise<void>) | null = null;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const task = pdfjs.getDocument({ data: pdf.slice(0) });
      destroy = () => task.destroy();
      const doc = await task.promise;
      if (cancelled) return;
      onPages(doc.numPages);
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const width = target.parentElement?.clientWidth || 600;
      const viewport = page.getViewport({ scale: (width * Math.min(window.devicePixelRatio || 1, 2)) / base.width });
      const off = document.createElement("canvas");
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      await page.render({ canvas: off, viewport }).promise;
      if (cancelled) return;
      // Copie en une fois : pas de page blanche pendant le dessin du nouvel aperçu.
      target.width = off.width;
      target.height = off.height;
      target.getContext("2d")?.drawImage(off, 0, 0);
    })()
      .catch(() => {
        if (!cancelled) onError(errorMessage);
      })
      .finally(() => void destroy?.());
    return () => {
      cancelled = true;
    };
  }, [pdf, onPages, onError, errorMessage]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      className="block aspect-[210/297] h-auto w-full rounded-[var(--radius-sm)] bg-[var(--apercu-logo-fond)] shadow-[var(--shadow-sm)]"
    />
  );
}
