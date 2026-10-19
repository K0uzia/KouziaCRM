import type { CSSProperties, ReactNode } from "react";
import { toast, Toaster } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faExclamation, faInfo, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

/**
 * Toasts de l'ERP, un seul style pour tous les types : fond de surface (jamais teinté ni noir), type porté par une
 * pastille ronde colorée à gauche avec son icône (Font Awesome local, aria-hidden) et dit en texte aux lecteurs
 * d'écran ; titre en gras, description en texte secondaire, action en bouton secondaire de 44 px.
 * Pastilles : icône sombre (--bg) sur couleur pleine, contraste AA (au moins 3:1 pour l'icône).
 * Types : toast.success, toast.error, toast.warning, toast.info (information et message neutre), toast.loading.
 * toast() et toast.message() n'ont pas de pastille : à remplacer par toast.info (test toast-style).
 */
const TOASTER_TOKENS = {
  "--normal-bg": "var(--surface-raised)",
  "--normal-bg-hover": "var(--surface-hover)",
  "--normal-border": "var(--border-strong)",
  "--normal-border-hover": "var(--border-strong)",
  "--normal-text": "var(--text)",
} as CSSProperties;

const TOAST_CLASSES = {
  toast: "gap-3! rounded-[var(--radius)]! shadow-[var(--shadow)]! font-[inherit]!",
  title: "font-semibold! text-[var(--text)]!",
  description: "text-[var(--muted)]!",
  icon: "size-6! m-0! shrink-0",
  actionButton:
    "min-h-11! px-3! rounded-[var(--radius-sm)]! border! border-[var(--border-strong)]! bg-[var(--surface)]! text-sm! font-semibold! text-[var(--text)]! hover:bg-[var(--surface-hover)]!",
  cancelButton: "min-h-11! px-3! rounded-[var(--radius-sm)]! bg-transparent! text-sm! text-[var(--muted)]!",
};

function Badge({ icon, tone, word }: { icon: IconDefinition; tone: string; word: string }): ReactNode {
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-full" style={{ background: tone }}>
      <FontAwesomeIcon icon={icon} className="size-3 text-[var(--bg)]" aria-hidden />
      <span className="sr-only">{word} :</span>
    </span>
  );
}

const ICONS = {
  success: <Badge icon={faCheck} tone="var(--success)" word="Réussite" />,
  error: <Badge icon={faExclamation} tone="var(--danger)" word="Erreur" />,
  warning: <Badge icon={faTriangleExclamation} tone="var(--primary)" word="Avertissement" />,
  info: <Badge icon={faInfo} tone="var(--accent-2)" word="Information" />,
  loading: (
    <span className="inline-flex size-6 items-center justify-center" role="presentation">
      <span className="size-4 rounded-full border-2 border-[var(--border-strong)] border-t-[var(--primary)] motion-safe:animate-spin" aria-hidden />
      <span className="sr-only">Chargement :</span>
    </span>
  ),
};

// Développement seulement (absent du build de production) : captures de chaque type de toast.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __kouziaToast?: typeof toast }).__kouziaToast = toast;

export function AppToaster() {
  return (
    <Toaster
      style={TOASTER_TOKENS}
      icons={ICONS}
      // Centré en haut : loin des onglets du bas et de la feuille des notifications sur mobile. Sous la barre du
      // haut et sous le bandeau réseau posé sur son filet (recherche, Publier, Créer et « Hors ligne » restent
      // visibles) ; en bas, il masquerait les actions des modales.
      position="top-center"
      theme="dark"
      offset={{ top: "calc(var(--topbar-h) + 1.5rem)" }}
      mobileOffset={{ top: "calc(var(--topbar-h) + 1.5rem)" }}
      toastOptions={{ className: "max-w-[calc(100vw-2rem)]", classNames: TOAST_CLASSES }}
    />
  );
}
