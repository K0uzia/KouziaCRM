import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faCheck, faImage, faQuoteLeft } from "@fortawesome/free-solid-svg-icons";
import { siteImageSrc } from "./shared";
import type { PreviewDevice } from "./editor";

/**
 * Aperçus fidèles des cartes de kouzia.com (dépôt KouziaWebsite : CarteProjet, Avis, MurLogos, ListeQuestions),
 * recopiés avec les valeurs du site : fond nuit, accent ambre, Exo 2, Share Tech Mono. Pas d'iframe : le site est
 * statique et ne montre pas de brouillon. Une évolution de ces composants du site se reporte ici.
 */

const carte =
  "relative flex flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[linear-gradient(180deg,var(--apercu-reflet),transparent_40%),var(--surface)] text-[var(--text)]";

/** Image de l'aperçu ; sans image, ou image non affichable ici, un cadre neutre à la même place. */
function ApercuImage({ path, className, label, compact = false }: { path: string | null | undefined; className: string; label: string; compact?: boolean }) {
  const src = siteImageSrc(path);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 bg-[var(--surface-raised)] text-xs text-[var(--muted)] ${className}`}
        role={compact ? "img" : undefined}
        aria-label={compact ? "Aperçu indisponible ici" : undefined}
      >
        <FontAwesomeIcon icon={faImage} className="h-5 w-5" aria-hidden />
        {compact ? null : src ? "Aperçu indisponible ici" : label}
      </div>
    );
  }
  return <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={className} />;
}

function domaine(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export type ProjectPreviewData = {
  name: string;
  subtitle: string;
  mention: string;
  kindLabel: string;
  text: string;
  role: string;
  tech: string[];
  url: string;
  linkLabel: string;
  imagePath: string | null;
  imageMobilePath: string | null;
};

/** Carte projet (CarteProjet.astro) : capture 16:9 et domaine, téléphone en surimpression à partir de 768 px. */
export function ProjectCardPreview({ p, device }: { p: ProjectPreviewData; device: PreviewDevice }) {
  const dom = domaine(p.url);
  // Sur le site, la capture de téléphone est masquée sous 768 px (illisible).
  const phone = Boolean(p.imageMobilePath) && device === "desktop";
  return (
    <div className={carte}>
      <div className="relative border-b border-[var(--border)]">
        <div className="relative overflow-hidden">
          <ApercuImage path={p.imagePath} label="Capture d'écran obligatoire" className="block aspect-video w-full object-cover object-top" />
          <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,var(--apercu-voile-leger))]" />
          {dom ? (
            <code
              aria-hidden
              className="absolute bottom-3 left-3 z-[1] rounded-full border border-[var(--border-strong)] bg-[var(--apercu-voile)] px-2.5 py-0.5 font-mono text-[0.8125rem] text-[var(--text)]"
            >
              {dom}
            </code>
          ) : null}
        </div>
        {phone ? (
          <div className="absolute -bottom-[30%] right-3 z-[2] w-[22%] overflow-hidden rounded-[0.9rem] border-4 border-[var(--bg)] bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--border-strong),var(--shadow)]">
            <ApercuImage path={p.imageMobilePath} label="" className="block aspect-[390/844] w-full object-cover object-top" />
          </div>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-6">
        <p className={`mb-2 font-mono text-[0.8125rem] uppercase leading-snug tracking-[0.14em] text-[var(--apercu-accent)] ${phone ? "pr-[24%]" : ""}`}>{p.kindLabel}</p>
        <h3 className={`mb-1.5 text-[1.2rem] font-bold leading-tight ${phone ? "pr-[24%]" : ""}`}>
          {p.name || <span className="text-[var(--muted)]">Nom de la réalisation</span>}
          {p.subtitle.trim() ? <span className="mt-1 block text-[0.9rem] font-normal text-[var(--muted)]">{p.subtitle.trim()}</span> : null}
        </h3>
        {p.mention.trim() ? <p className="mb-2 text-[0.9rem] leading-snug text-[var(--muted)]">{p.mention.trim()}</p> : null}
        <p className="mb-4 whitespace-pre-line text-[0.9rem] text-[var(--muted)]">{p.text || "Texte de présentation."}</p>
        {p.role.trim() ? <p className="mb-4 text-[0.9rem] text-[var(--muted)]">{p.role.trim()}</p> : null}
        {p.tech.length ? (
          <ul className="mb-4 flex flex-wrap gap-2" aria-label="Technologies">
            {p.tech.map((t) => (
              <li key={t} className="rounded-full border border-[var(--border-strong)] px-2.5 py-0.5 font-mono text-[0.8125rem] text-[var(--muted)]">
                {t}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-auto border-t border-[var(--border)] pt-4">
          <span className="inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--apercu-accent)]">
            {p.linkLabel || "Libellé du lien"}
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
          </span>
        </p>
      </div>
    </div>
  );
}

const dateLongue = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
/** « 1er septembre 2026 », comme le site. */
const jour = (iso: string) => dateLongue.format(new Date(iso)).replace(/^1 /, "1er ");
const paragraphes = (texte: string) =>
  texte
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Témoignage (Avis.astro) : guillemet ambre, texte exact en paragraphes, auteur et dates. */
export function ReviewCardPreview({ author, text, reviewedOn, experienceOn }: { author: string; text: string; reviewedOn: string | null; experienceOn: string | null }) {
  const blocs = paragraphes(text);
  return (
    <div className={`${carte} p-6`}>
      <figure className="flex h-full flex-col gap-4">
        <span className="text-[1.2rem] text-[var(--apercu-accent)]" aria-hidden>
          <FontAwesomeIcon icon={faQuoteLeft} />
        </span>
        <blockquote className="flex-1 space-y-3">
          {blocs.length ? blocs.map((b, i) => <p key={i}>{b}</p>) : <p className="text-[var(--muted)]">Texte exact de l'auteur.</p>}
        </blockquote>
        <figcaption className="grid gap-1 border-t border-[var(--border)] pt-4 text-[0.9rem] text-[var(--muted)]">
          <span className="font-semibold text-[var(--text)]">{author || "Auteur"}</span>
          <span>
            Publié le {reviewedOn ? jour(reviewedOn) : "(date de publication)"}
            {experienceOn ? `, projet terminé le ${jour(experienceOn)}` : ""}
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

/** Tuile du mur de logos (MurLogos.astro) : logo en couleur sur fond clair, tel que fourni. */
export function LogoTilePreview({ name, logoPath, url }: { name: string; logoPath: string | null; url: string | null }) {
  return (
    <div className="space-y-3">
      <p className="text-center font-mono text-[0.9rem] uppercase tracking-[0.12em] text-[var(--muted)]">Ils m'ont fait confiance</p>
      <div className="mx-auto grid h-[4.5rem] w-[10rem] place-items-center rounded-[var(--radius-sm)] border border-transparent bg-[var(--apercu-logo-fond)] px-4 py-2">
        {logoPath ? (
          <ApercuImage path={logoPath} label="" compact className="h-full max-h-full w-full max-w-full rounded-[var(--radius-sm)] object-contain" />
        ) : (
          <span className="text-center text-xs text-[var(--bg)]">Sans logo : le nom seul, hors du mur</span>
        )}
      </div>
      <p className="text-center text-xs text-[var(--muted)]">
        {url ? `Lien vers ${domaine(url) ?? url}` : "Sans lien"} ; texte alternatif : « {name || "nom de la structure"} »
      </p>
    </div>
  );
}

/** Question dépliante (ListeQuestions.astro), affichée ouverte. */
export function QuestionPreview({ question, answer }: { question: string; answer: string }) {
  return (
    <div className="border-y border-[var(--border)] text-[var(--text)]">
      <div className="flex items-baseline justify-between gap-4 py-4 font-semibold">
        <span>{question || <span className="text-[var(--muted)]">Question</span>}</span>
        <span aria-hidden className="flex-none rotate-45 font-mono text-[1.2rem] leading-none text-[var(--apercu-accent)]">
          +
        </span>
      </div>
      <p className="mb-4 whitespace-pre-line pr-10 text-[var(--muted)]">{answer || "Réponse complète, reprise telle quelle."}</p>
    </div>
  );
}

/**
 * Formule de suivi (OffreMaintenance.astro, partie droite) : titre, points cochés, phrase sur le tarif, bouton.
 * La partie gauche (surveillance) est écrite dans le site et ne se modifie pas ici.
 */
export function OfferCardPreview({ titre, items, tarif }: { titre: string; items: string[]; tarif: string }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-6 text-[var(--text)]">
      <h3 className="mb-3 text-[1.2rem] font-bold leading-tight">{titre || <span className="text-[var(--muted)]">Titre de la formule</span>}</h3>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-baseline gap-2.5">
              <FontAwesomeIcon icon={faCheck} className="h-3 w-3 flex-none text-[var(--apercu-accent)]" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--muted)]">Ce qui est compris, un point par ligne.</p>
      )}
      <p className="mb-6 mt-4 text-[0.9rem] text-[var(--muted)]">{tarif || "Phrase sur le tarif."}</p>
      <span className="inline-flex min-h-11 items-center rounded-[var(--radius)] border border-[var(--border-strong)] px-4 font-semibold">
        Demander un devis de maintenance
      </span>
    </div>
  );
}
