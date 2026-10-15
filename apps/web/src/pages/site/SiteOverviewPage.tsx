import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faCircleExclamation, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { api, formatDate } from "@/lib/api";
import { PageHeader } from "@/components/ui/Card";
import { StatStrip } from "@/components/ui/StatStrip";
import { withdrawalPending } from "./SiteReviewsPage";
import { SitePublicationCard } from "./SitePublicationCard";
import { LoadState, type SiteFaq, type SiteProject, type SiteReference, type SiteReview, type SiteState } from "./shared";

type Overview = {
  state: SiteState;
  projects: SiteProject[];
  reviews: SiteReview[];
  references: SiteReference[];
  faq: SiteFaq[];
};

type Alert = { tone: "danger" | "warning"; text: string; to?: string; action?: string };

const FILE_LABEL: Record<string, string> = {
  infos: "Coordonnées",
  textes: "Textes",
  faq: "FAQ",
  realisations: "Réalisations",
  avis: "Témoignages",
  references: "Références",
};

const DAY = 86_400_000;

/** Alertes de l'espace Site, de la plus urgente à la moins urgente. */
export function siteAlerts(o: Overview, now = Date.now()): Alert[] {
  const alerts: Alert[] = [];
  // Témoignages déposés depuis l'espace client, en attente (délai indicatif annoncé : 7 jours).
  const pending = o.reviews.filter(
    (r) => (r as { source?: string; rejectedAt?: string | null }).source === "CLIENT_SPACE" && r.status === "DRAFT" && !(r as { rejectedAt?: string | null }).rejectedAt,
  ).length;
  if (pending) {
    alerts.push({
      tone: "warning",
      text: `${pending} témoignage${pending > 1 ? "s" : ""} à valider (publier tel quel ou écarter avec un motif).`,
      to: "/site/avis",
      action: "Voir les témoignages",
    });
  }
  for (const r of o.reviews.filter(withdrawalPending)) {
    const due = new Date(r.withdrawalRequestedAt!).getTime() + 7 * DAY;
    alerts.push({
      tone: "danger",
      text: `${r.author} a retiré son accord le ${formatDate(r.withdrawalRequestedAt)} : avis à retirer du site avant le ${formatDate(new Date(due))}.`,
      to: "/site/avis",
      action: "Ouvrir les avis",
    });
  }
  for (const w of o.state.withdrawalsOnSite ?? []) {
    const since = w.withdrawalRequestedAt ? ` le ${formatDate(w.withdrawalRequestedAt)}` : "";
    const due = w.withdrawalRequestedAt ? ` avant le ${formatDate(new Date(new Date(w.withdrawalRequestedAt).getTime() + 7 * DAY))}` : "";
    // verified : présent dans avis.json du dépôt ; sinon dépôt illisible, retrait récent signalé par prudence.
    alerts.push({
      tone: "danger",
      text: w.verified
        ? `Retrait demandé : à publier. ${w.author} a retiré son témoignage${since} ; il est encore sur le site (à retirer${due}).`
        : `Retrait demandé : à publier. ${w.author} a retiré son témoignage${since} (à retirer du site${due}) ; le dépôt du site n'a pas pu être lu pour vérifier qu'il en est sorti.`,
      to: "/site/avis",
      action: "Voir les témoignages",
    });
  }
  const { token, expiresAt } = o.state.github;
  if (!token.set) {
    alerts.push({ tone: "warning", text: "Aucun jeton GitHub : l'ERP ne peut ni lire ni publier le site.", to: "/site/connexion", action: "Enregistrer un jeton" });
  } else if (expiresAt) {
    const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY);
    if (days <= 0) {
      alerts.push({ tone: "danger", text: `Le jeton GitHub a expiré le ${formatDate(expiresAt)}.`, to: "/site/connexion", action: "Le remplacer" });
    } else if (days <= 30) {
      alerts.push({
        tone: "warning",
        text: `Le jeton GitHub expire le ${formatDate(expiresAt)} (dans ${days} jour${days > 1 ? "s" : ""}).`,
        to: "/site/connexion",
        action: "Le remplacer",
      });
    }
  }
  if (o.state.empty) {
    alerts.push({ tone: "warning", text: "L'espace Site est vide : reprendre d'abord le contenu actuel de kouzia.com.", to: "/site/connexion", action: "Reprendre le contenu" });
  }
  if (!o.state.imagesAvailable) {
    alerts.push({ tone: "warning", text: "Envoi d'images indisponible sur ce serveur (sharp n'est pas installé)." });
  }
  return alerts;
}

export function SiteOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [state, projects, reviews, references, faq] = await Promise.all([
        api<SiteState>("/api/site/status"),
        api<SiteProject[]>("/api/site/projects"),
        api<SiteReview[]>("/api/site/reviews"),
        api<SiteReference[]>("/api/site/references"),
        api<SiteFaq[]>("/api/site/faq"),
      ]);
      setData({ state, projects, reviews, references, faq });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const live = <T extends { status: string }>(rows: T[]) => rows.filter((r) => r.status === "PUBLISHED").length;
  const alerts = data ? siteAlerts(data) : [];

  return (
    <div>
      <PageHeader
        title="Site kouzia.com"
        subtitle="Le contenu du site se saisit ici, puis se publie dans le dépôt du site, qui se reconstruit et se déploie."
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {data ? (
          <div className="space-y-4">
            <StatStrip
              items={[
                { label: "Réalisations sur le site", shortLabel: "Réalisations", value: live(data.projects), to: "/site/realisations" },
                { label: "Témoignages sur le site", shortLabel: "Témoignages", value: live(data.reviews), to: "/site/avis" },
                { label: "Références sur le site", shortLabel: "Références", value: live(data.references), to: "/site/references" },
                { label: "Questions de la FAQ", shortLabel: "FAQ", value: live(data.faq), to: "/site/faq" },
              ]}
            />

            <section aria-labelledby="site-alertes" className="ui-card p-4 sm:p-5">
              <h2 id="site-alertes" className="text-base font-semibold">
                À traiter
              </h2>
              {alerts.length ? (
                <ul className="mt-3 space-y-2">
                  {alerts.map((a) => (
                    <li key={a.text} className="flex flex-col gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3 sm:flex-row sm:items-center">
                      <span className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                        <FontAwesomeIcon
                          icon={a.tone === "danger" ? faCircleExclamation : faTriangleExclamation}
                          className={`mt-0.5 h-4 w-4 shrink-0 ${a.tone === "danger" ? "text-[var(--danger)]" : "text-[var(--warning)]"}`}
                          aria-hidden
                        />
                        <span>
                          <span className="sr-only">{a.tone === "danger" ? "Urgent : " : "À voir : "}</span>
                          {a.text}
                        </span>
                      </span>
                      {a.to ? (
                        <Link to={a.to} className="link inline-flex min-h-11 shrink-0 items-center text-sm font-medium">
                          {a.action}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]">
                  <FontAwesomeIcon icon={faCircleCheck} className="h-4 w-4 text-[var(--success)]" aria-hidden />
                  Rien à traiter.
                </p>
              )}
            </section>

            <section aria-labelledby="site-controle" className="ui-card p-4 sm:p-5">
              <h2 id="site-controle" className="text-base font-semibold">
                Contrôle avant publication
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Ce qui empêcherait de publier le contenu actuel : charte du site, accords et autorisations, images.
              </p>
              {data.state.issues.length ? (
                <ul className="mt-3 divide-y divide-[var(--border)]">
                  {data.state.issues.map((i, n) => (
                    <li key={`${i.file}-${i.path}-${n}`} className="flex flex-col gap-0.5 py-2.5 text-sm sm:flex-row sm:gap-3">
                      <span className="shrink-0 font-medium sm:w-32">{FILE_LABEL[i.file] ?? i.file}</span>
                      <span className="min-w-0 break-words">
                        {i.message}
                        <span className="block font-mono text-xs text-[var(--muted)]">{i.path}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-sm">
                  <FontAwesomeIcon icon={faCircleCheck} className="h-4 w-4 text-[var(--success)]" aria-hidden />
                  Aucune anomalie.
                </p>
              )}
            </section>

            <SitePublicationCard state={data.state} onPublished={() => void load()} />
          </div>
        ) : null}
      </LoadState>
    </div>
  );
}
