import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const GAP = 4;
const MARGIN = 8;

/**
 * Panneau ancré à un déclencheur (Combobox, Listbox) : sous lui, ou au-dessus quand la place manque en bas ; recalculé
 * au défilement et au redimensionnement. Position fixe, donc hors de tout conteneur qui rognerait (fenêtre modale).
 */
export function useAnchoredPanel(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  { minWidth, maxHeight, flipBelow = 280 }: { minWidth: number; maxHeight: number; flipBelow?: number },
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(Math.max(rect.width, minWidth), vw - 2 * MARGIN);
      const left = Math.min(Math.max(rect.left, MARGIN), vw - width - MARGIN);
      const below = vh - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const up = below < flipBelow && above > below;
      const height = Math.min(maxHeight, up ? above : below);
      setPosition(up ? { left, width, maxHeight: height, bottom: vh - rect.top + GAP } : { left, width, maxHeight: height, top: rect.bottom + GAP });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open, triggerRef, minWidth, maxHeight, flipBelow]);
  return position;
}
