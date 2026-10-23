import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faBuildingColumns,
  faHandHoldingDollar,
  faClipboardCheck,
  faEnvelope,
  faFileInvoice,
  faGlobe,
  faFilePen,
  faFileSignature,
  faHourglassHalf,
  faLandmark,
  faLink,
  faPenToSquare,
  faRotate,
  faUserPlus,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { toast } from "sonner";
import { type NotificationKind, useLiveRefresh } from "@/lib/notifications";
import { MAIL_SYNC_STATUS_EVENT } from "@/hooks/useNewMailAlert";
import { onMailChanged } from "@/lib/mailEvents";
import { api, formatEUR } from "@/lib/api";
import { formatAgoMinutes, formatDate, formatMailDate, MAIL_SYNC_STALE_MIN, minutesSince } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useFeatures } from "@/lib/features";
import { PayoutDialog } from "@/components/payouts/PayoutDialog";
import { WithdrawalDialog } from "@/components/finance/WithdrawalDialog";
import type { MonthlyFlow } from "@/components/dashboard/FlowsChart";
import type { FluxMonth } from "@/pages/StripePayoutsPage";
import { useMediaQuery } from "@/lib/use-media-query";

type OwnerPay = { availableCents: number; paidThisMonthCents: number; flows: MonthlyFlow[] };
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { formMessageName } from "@/pages/messaging/sender";
import { useReadOnly } from "@/lib/offline/read-only";
import { ReminderDialog } from "@/components/messaging/document-email-dialogs";

/** Notifications qui changent les chiffres ou les listes du tableau de bord (les autres ne le rechargent pas). */
const DASHBOARD_KINDS = new Set<NotificationKind>(["mail", "payment", "deposit_due", "quote_accepted", "quote_rejected", "subscription_stripe"]);

const loadRevenueChart = () => import("@/components/dashboard/RevenueChart");
const loadFlowsChart = () => import("@/components/dashboard/FlowsChart");

/**
 * Graphique chargé après l'affichage des chiffres (évalué plus tôt, recharts occupait le fil
 * principal pendant que les données attendaient), sans Suspense : React 19 retarde d'environ
 * 300 ms la révélation d'un contenu suspendu. Le cadre garde sa hauteur pendant le chargement.
 */
function useDeferredComponent<P>(load: () => Promise<{ default: ComponentType<P> }>, start: boolean): ComponentType<P> | null {
  const [component, setComponent] = useState<ComponentType<P> | null>(null);
  useEffect(() => {
    if (!start || component) return;
    let cancelled = false;
    load()
      .then((m) => {
        if (!cancelled) setComponent(() => m.default);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [start, component, load]);
  return component;
}
const StripePathChart = lazy(() => import("@/components/dashboard/StripePathChart"));

type Scope = "week" | "month" | "year";

type DashboardData = {
  company: { legalName: string; tradeName: string | null };
  cashflow: {
    totalEncaisseCents: number;
    urssafCents: number;
    fraisCents: number;
    fraisBps: number;
    placementsCents: number;
    cfeCents: number;
    tresorerieCents: number;
    tresorerieEtCfeCents: number;
    resteNetCents: number;
  };
  chart: Array<{
    label: string;
    ca: number;
    urssaf: number;
    tresorerie: number;
    salaire: number;
    cfe: number;
  }>;
  echeance: {
    periodLabel: string;
    amountDueCents: number;
    deadline: string;
    status: string;
    paidAt: string | null;
    periodKey: string;
  };
  drafts: number;
  /** Paiement en 3 fois : étape du 2e acompte à choisir, 2e acompte exigible à facturer. */
  deposit2?: {
    missingStep: Array<{ quoteId: string; number: string | null; displayName: string; amountCents: number }>;
    toInvoice: Array<{ quoteId: string; number: string | null; displayName: string; amountCents: number }>;
  };
  pendingTotalCents?: number;
  pendingCount?: number;
  pendingWithBalance: Array<{
    id: string;
    number: string | null;
    displayName: string;
    remaining: number;
  }>;
};

type ReminderRow = {
  id: string;
  number: string | null;
  documentType: string;
  totalCents: number;
  nextReminderAt: string | null;
  reminderCount: number;
  client: { id: string; displayName: string; clientNumber?: string | null };
};

type MrrData = { mrrCents: number; arrCents: number; activeCount: number; upcomingCount?: number; upcomingMrrCents?: number };

/** GET /api/emails/inbox-summary : la boîte de réception telle que la Messagerie l'ouvre. */
type InboxSummary = {
  unreadCount: number;
  messages: Array<{
    id: string;
    threadId: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    replyToAddress?: string | null;
    snippet?: string | null;
    direction?: string;
    receivedAt: string;
    isRead: boolean;
    client: { id: string; displayName: string } | null;
  }>;
};

type CfeObligation = { label: string; dueDate: string; amountCents: number | null };

type ObligationsSummary = {
  summary: { late: number; urgent: number; open: number; upcoming: number; pending: number };
  alerts?: Array<{ kind: string; message: string }>;
  nextDue: { label: string; displayStatus: string; daysLate: number | null; daysRemaining: number | null } | null;
};

/** GET /api/dashboard/overview : tout le tableau de bord en un appel ; null = bloc indisponible. */
type Overview = DashboardData & {
  reminders: ReminderRow[] | null;
  mrr: MrrData | null;
  obligations: ObligationsSummary | null;
  cfeObligation: CfeObligation | null;
  mail: InboxSummary | null;
  mailSync: { imapConfigured: boolean; lastSyncAt: string | null } | null;
  ownerPay: OwnerPay | null;
  /** Particuliers dans le délai de rétractation, sans demande d'exécution anticipée. */
  pendingStarts: Array<{ quoteId: string; number: string | null; displayName: string; startsNotBefore: string }>;
  /** Renouvellements payés par le client chez son hébergeur, dans les 30 jours. */
  renewals?: Array<{ id: string; clientId: string; displayName: string; label: string; provider: string | null; renewsAt: string; notifyClient: boolean }>;
  /** Avenants acceptés, antérieurs aux abonnements multiples, dont l'abonnement révisé reste à choisir. */
  revisionsToAttach?: Array<{ lineId: string; quoteId: string; quoteNumber: string | null; displayName: string; description: string }>;
  /** Blocs secondaires en échec ou trop lents côté serveur : affichés comme indisponibles, pas comme vides. */
  indisponibles?: string[];
};

/** Barre de chargement à la taille du texte qu'elle remplace (aucun saut à l'arrivée des données). */
function Skeleton({ className = "w-20" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-[0.9em] animate-pulse rounded bg-[var(--surface-hover)] align-middle ${className}`} />;
}

/** Lignes fantômes d'une liste, à la hauteur des vraies lignes. */
function SkeletonRows({ count, rowClass }: { count: number; rowClass: string }) {
  return (
    <ul aria-hidden className="divide-y divide-[var(--border)]">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={rowClass}>
          <span className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="block w-2/5" />
            <Skeleton className="block w-1/4 text-xs" />
          </span>
        </li>
      ))}
    </ul>
  );
}

const SCOPE_LABEL: Record<Scope, string> = {
  week: "cette semaine",
  month: "ce mois-ci",
  year: "cette année",
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 18 ? "Bonjour" : "Bonsoir";
}

/** Ligne de la colonne « À traiter » : icône d'état, texte, action à droite. */
function TodoRow({
  icon,
  tone,
  title,
  detail,
  action,
}: {
  icon: IconDefinition;
  tone: "danger" | "warning" | "primary" | "muted";
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const toneCls = {
    danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
    primary: "bg-[var(--primary-soft)] text-[var(--primary)]",
    muted: "bg-[var(--surface-hover)] text-[var(--muted)]",
  }[tone];
  return (
    <li className="flex items-center gap-3 py-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${toneCls}`}>
        <FontAwesomeIcon icon={icon} className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {/* Le texte passe à la ligne : un montant ne doit jamais être masqué par une coupure. */}
        <div className="break-words text-sm font-medium">{title}</div>
        {detail ? <div className="break-words text-xs text-[var(--muted)]">{detail}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] px-5 py-1.5">
      <h2 className="text-sm font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function DashboardPage() {
  const { readOnly, copyNotice, reason } = useReadOnly();
  const readOnlyId = useId();
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>("month");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remindersRunBusy, setRemindersRunBusy] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  // Graphique des flux : salaire et provisions, ou chemin de l'argent encaissé par Stripe.
  const [flowView, setFlowView] = useState<"salary" | "stripe">("salary");
  const [stripeFlux, setStripeFlux] = useState<FluxMonth[] | null>(null);
  // Téléphone : 6 derniers mois, lisibles sans défilement horizontal.
  const wideChart = useMediaQuery("(min-width: 640px)");
  const { moduleStripeEnabled, loading: featuresLoading } = useFeatures();
  // Sélecteur des flux affiché tant que les réglages se chargent : il ne disparaît que si Stripe est
  // désactivé, au lieu d'apparaître et de décaler la page quand Stripe est actif.
  const showFlowSwitch = moduleStripeEnabled || featuresLoading;
  const [liveTick, setLiveTick] = useState(0);
  const reload = () => setLiveTick((t) => t + 1);
  // Plusieurs notifications d'un coup (rattrapage au retour sur l'onglet) : un seul rechargement.
  const rafale = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(rafale.current), []);
  useLiveRefresh(
    () => {
      window.clearTimeout(rafale.current);
      rafale.current = window.setTimeout(reload, 1500);
    },
    (item) => DASHBOARD_KINDS.has(item.kind),
  );

  // Un seul appel. Rafraîchissement (événement, portée, action) silencieux : les valeurs affichées
  // restent en place jusqu'à l'arrivée des nouvelles, sans grisé ni squelette.
  const hasData = useRef(false);
  // Premier appel lancé au premier rendu, sans attendre la fin du montage de la page (au
  // téléphone, le rendu initial retardait le départ de la requête d'environ 200 ms).
  const firstRequest = useRef<Promise<Overview> | null | undefined>(undefined);
  if (firstRequest.current === undefined) {
    firstRequest.current = api<Overview>("/api/dashboard/overview?scope=month");
    firstRequest.current.catch(() => undefined);
  }
  useEffect(() => {
    let cancelled = false;
    const first = scope === "month" && liveTick === 0 ? firstRequest.current : null;
    firstRequest.current = null;
    (first ?? api<Overview>(`/api/dashboard/overview?scope=${scope}&t=${liveTick}`))
      .then((d) => {
        if (cancelled) return;
        hasData.current = true;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (hasData.current) toast.error(`Tableau de bord non actualisé : ${e.message}`, { id: "dashboard-refresh" });
        else setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, liveTick]);

  // Synchro automatique en panne : alerte dans « À traiter » (boîte configurée seulement). La date
  // suit la relecture globale de l'état de synchro, sans attendre un rechargement de la page.
  const [lastSyncAt, setLastSyncAt] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const onStatus = (e: Event) => setLastSyncAt((e as CustomEvent<{ lastSyncAt?: string | null }>).detail.lastSyncAt ?? null);
    window.addEventListener(MAIL_SYNC_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(MAIL_SYNC_STATUS_EVENT, onStatus);
  }, []);
  // Carte Messagerie relue seule (requête en base, sans IMAP) après un passage du worker ou une
  // action dans la Messagerie : lu, suppression ou déplacement s'y voient sans recharger la page.
  const reloadMail = useCallback(() => {
    api<InboxSummary>("/api/emails/inbox-summary")
      .then((mail) => setData((d) => (d ? { ...d, mail } : d)))
      .catch(() => undefined);
  }, []);
  const seenSyncAt = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastSyncAt === undefined) return;
    if (seenSyncAt.current !== undefined && seenSyncAt.current !== lastSyncAt) reloadMail();
    seenSyncAt.current = lastSyncAt;
  }, [lastSyncAt, reloadMail]);
  useEffect(() => onMailChanged(reloadMail), [reloadMail]);
  const mailSyncAge = data?.mailSync?.imapConfigured
    ? (minutesSince(lastSyncAt === undefined ? data.mailSync.lastSyncAt : lastSyncAt) ?? Infinity)
    : null;
  const mailStale = mailSyncAge !== null && mailSyncAge > MAIL_SYNC_STALE_MIN;
  const pendingStarts = data?.pendingStarts ?? [];
  const renewals = data?.renewals ?? [];
  const revisionsToAttach = data?.revisionsToAttach ?? [];
  const deposit2Rows = [
    ...(data?.deposit2?.toInvoice ?? []).map((q) => ({ ...q, kind: "toInvoice" as const })),
    ...(data?.deposit2?.missingStep ?? []).map((q) => ({ ...q, kind: "missingStep" as const })),
  ];
  const reminders = data?.reminders ?? [];
  const mrr = data?.mrr ?? null;
  const obligations = data?.obligations ?? null;
  const cfeObligation = data?.cfeObligation ?? null;
  const mail = data?.mail ?? null;
  const ownerPay = data?.ownerPay ?? null;
  const RevenueChart = useDeferredComponent(loadRevenueChart, data !== null);
  const FlowsChart = useDeferredComponent(loadFlowsChart, data !== null);

  useEffect(() => {
    if (flowView !== "stripe") return;
    let cancelled = false;
    api<{ series: FluxMonth[] }>("/api/stripe/flux")
      .then((f) => !cancelled && setStripeFlux(f.series))
      .catch(() => !cancelled && setStripeFlux([]));
    return () => {
      cancelled = true;
    };
  }, [flowView, liveTick]);

  async function runAllReminders() {
    setRemindersRunBusy(true);
    try {
      const res = await api<{ scheduled: number; enqueued: number; sent: number; errors: string[] }>(
        "/api/reminders/run",
        { method: "POST", body: "{}" },
      );
      toast.success(`Relances : ${res.enqueued} enfilée(s), ${res.sent} envoyée(s)`);
      if (res.errors.length) toast.error(res.errors.join(" · "));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setRemindersRunBusy(false);
    }
  }

  // « Relancer » : relance relue dans « Vérifier l'e-mail » avant l'envoi (E6c).
  const [reminderFor, setReminderFor] = useState<string | null>(null);

  const firstName = (user?.name ?? "").split(/\s+/)[0];
  // Hors ligne : date des données, et actions qui exigent le réseau désactivées (raison liée et écrite).
  const offline = readOnly ? { disabled: true, "aria-describedby": readOnlyId, title: reason ?? undefined } : null;
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  const header = (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm capitalize text-[var(--muted)]">{today}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {greeting()}
          {firstName ? ` ${firstName}` : ""}
        </h1>
        {/* Mention visible seulement pour des données de la copie (présente dès l'affichage, sans décalage) ; la
            simple coupure reste dite aux actions désactivées (texte lié et info-bulle) et par le bandeau réseau. */}
        {copyNotice ? (
          <p id={readOnlyId} data-offline-notice className="mt-2 max-w-xl text-sm text-[var(--warning)]">
            {copyNotice}
          </p>
        ) : readOnly ? (
          <span id={readOnlyId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Période des indicateurs"
          value={scope}
          onChange={setScope}
          options={[
            { id: "week", label: "Semaine" },
            { id: "month", label: "Mois" },
            { id: "year", label: "Année" },
          ]}
        />
      </div>
    </div>
  );

  const quickActions = (
    <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {offline ? (
        <Button className="col-span-2 sm:col-span-1" {...offline}>
          <FontAwesomeIcon icon={faWallet} className="h-3.5 w-3.5" aria-hidden />
          Encaisser
        </Button>
      ) : (
        <ButtonLink to="/payments?new=1" className="col-span-2 sm:col-span-1">
          <FontAwesomeIcon icon={faWallet} className="h-3.5 w-3.5" aria-hidden />
          Encaisser
        </ButtonLink>
      )}
      {/* Sous 640 px : libellé court sur une ligne, nom accessible complet (il contient le libellé visible). */}
      <ButtonLink to="/quotes?new=1" variant="secondary" aria-label="Nouveau devis">
        <FontAwesomeIcon icon={faFileSignature} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Devis</span>
        <span className="hidden sm:inline">Nouveau devis</span>
      </ButtonLink>
      {offline ? (
        <Button variant="secondary" aria-label="Nouvelle facture" {...offline}>
          <FontAwesomeIcon icon={faFileInvoice} className="h-3.5 w-3.5" aria-hidden />
          <span className="sm:hidden">Facture</span>
          <span className="hidden sm:inline">Nouvelle facture</span>
        </Button>
      ) : (
        <ButtonLink to="/invoices?new=1" variant="secondary" aria-label="Nouvelle facture">
          <FontAwesomeIcon icon={faFileInvoice} className="h-3.5 w-3.5" aria-hidden />
          <span className="sm:hidden">Facture</span>
          <span className="hidden sm:inline">Nouvelle facture</span>
        </ButtonLink>
      )}
      <ButtonLink to="/clients?new=1" variant="secondary" aria-label="Nouveau client">
        <FontAwesomeIcon icon={faUserPlus} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Client</span>
        <span className="hidden sm:inline">Nouveau client</span>
      </ButtonLink>
      {offline ? (
        <Button variant="secondary" aria-label="Écrire un mail" {...offline}>
          <FontAwesomeIcon icon={faPenToSquare} className="h-3.5 w-3.5" aria-hidden />
          <span className="sm:hidden">Mail</span>
          <span className="hidden sm:inline">Écrire un mail</span>
        </Button>
      ) : (
        <ButtonLink to="/inbox/compose" variant="secondary" aria-label="Écrire un mail">
          <FontAwesomeIcon icon={faPenToSquare} className="h-3.5 w-3.5" aria-hidden />
          <span className="sm:hidden">Mail</span>
          <span className="hidden sm:inline">Écrire un mail</span>
        </ButtonLink>
      )}
    </div>
  );

  if (error && !data) {
    return (
      <div>
        {header}
        <Card className="p-5 text-sm text-[var(--danger)]" role="alert">
          Impossible de charger le tableau de bord : {error ?? "erreur inconnue"}
        </Card>
      </div>
    );
  }

  // Premier chargement : la page entière est rendue tout de suite, chaque valeur à sa place finale
  // sous forme de barre de chargement (aucun saut de mise en page à l'arrivée des données).
  const ready = data !== null;
  const money = (cents: number | undefined) => (ready ? formatEUR(cents ?? 0) : <Skeleton className="w-24" />);
  const hintOr = (text: ReactNode) => (ready ? text : <Skeleton className="w-28" />);
  const cf = data?.cashflow;
  // Statuts en minuscules (paid, due, late, clear) : seule une échéance à payer ou en retard est « due ».
  const echeanceDue = Boolean(
    data?.echeance && (data.echeance.status === "due" || data.echeance.status === "late") && data.echeance.amountDueCents > 0,
  );
  const pending = data?.pendingWithBalance ?? [];
  // Total et nombre sur toutes les factures émises (serveur, avoirs compris) ; la liste n'en montre que 8.
  const pendingTotal = data?.pendingTotalCents ?? pending.reduce((s, i) => s + i.remaining, 0);
  const pendingCount = data?.pendingCount ?? pending.length;
  const os = obligations?.summary;
  const obligationAlerts = os ? os.late + os.urgent + os.open : 0;


  const unreadMail = mail?.unreadCount ?? 0;

  const companyEmailAlert = obligations?.alerts?.find((a) => a.kind === "company-email");

  return (
    <div>
      <ReminderDialog documentId={reminderFor} onClose={() => setReminderFor(null)} onDone={() => reload()} />
      {header}
      {quickActions}

      {data?.indisponibles && data.indisponibles.length > 0 ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4 text-sm" role="status">
          <span>
            Une partie du tableau de bord n'a pas pu être chargée ({data.indisponibles.join(", ")}). Le reste est à jour.
          </span>
          <Button variant="secondary" onClick={reload}>
            Réessayer
          </Button>
        </Card>
      ) : null}

      <StatStrip
        busy={!ready}
        items={[
          { label: `Encaissé ${SCOPE_LABEL[scope]}`, value: money(cf?.totalEncaisseCents), tone: "primary", to: ready ? "/receipts" : undefined },
          {
            label: "À encaisser",
            value: money(pendingTotal),
            hint: hintOr(`${pendingCount} facture${pendingCount > 1 ? "s" : ""} ouverte${pendingCount > 1 ? "s" : ""}`),
            to: ready ? "/invoices" : undefined,
          },
          {
            label: "URSSAF provisionnée",
            shortLabel: "URSSAF",
            value: money(cf?.urssafCents),
            hint: hintOr(
              echeanceDue && data ? `${formatEUR(data.echeance.amountDueCents)} dus le ${formatDate(data.echeance.deadline)}` : "à jour",
            ),
            to: ready ? "/urssaf" : undefined,
          },
          {
            label: "CFE provisionnée",
            value: money(cf?.cfeCents),
            hint: hintOr(
              cfeObligation ? `due le ${formatDate(cfeObligation.dueDate)}` : (cf?.cfeCents ?? 0) > 0 ? "provision mensuelle" : "CFE non renseignée",
            ),
          },
          {
            label: "Trésorerie",
            value: money(cf?.tresorerieCents),
            hint: "provision frais et placements",
          },
          { label: "Reste net", value: money(cf?.resteNetCents), hint: "après URSSAF et provisions", tone: "success" },
          {
            label: "Salaire disponible",
            value: money(ownerPay?.availableCents),
            hint: hintOr(`déjà retiré ${formatEUR(ownerPay?.paidThisMonthCents ?? 0)} ce mois-ci`),
            tone: "success",
            to: ready ? "/retraits" : undefined,
          },
        ]}
      />
      {/* Mouvements du salaire, sous la synthèse qui les chiffre : actions secondaires (la page n'a qu'une action
          principale, « Encaisser »), pleine largeur au téléphone, groupées à droite ensuite. */}
      <div role="group" aria-label="Salaire" className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:justify-end">
        {moduleStripeEnabled ? (
          <Button variant="secondary" onClick={() => setPayoutOpen(true)} {...offline}>
            <FontAwesomeIcon icon={faBuildingColumns} className="h-3.5 w-3.5" aria-hidden />
            Verser sur mon compte
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setWithdrawalOpen(true)} {...offline}>
          <FontAwesomeIcon icon={faHandHoldingDollar} className="h-3.5 w-3.5" aria-hidden />
          Enregistrer un retrait
        </Button>
      </div>
      <WithdrawalDialog
        open={withdrawalOpen}
        availableCents={ownerPay?.availableCents ?? 0}
        onClose={() => setWithdrawalOpen(false)}
        onDone={reload}
      />
      <PayoutDialog
        open={payoutOpen}
        onClose={() => setPayoutOpen(false)}
        suggestedCents={Math.max(0, cf?.resteNetCents ?? 0)}
        onDone={reload}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {!ready || (ownerPay && ownerPay.flows.length > 0) ? (
            <Card className="min-w-0 overflow-hidden">
              <SectionTitle
                action={
                  showFlowSwitch ? (
                    <Segmented
                      label="Vue du graphique des flux"
                      options={[
                        { id: "salary", label: "Salaire" },
                        { id: "stripe", label: "Chemin Stripe" },
                      ]}
                      value={flowView}
                      onChange={setFlowView}
                      fieldHeight
                      className="max-sm:w-full"
                    />
                  ) : undefined
                }
              >
                Flux par mois
              </SectionTitle>
              <p className="px-5 pt-3 text-sm text-[var(--muted)] sm:px-6">
                {flowView === "stripe" ? (
                  <>
                    Encaissé par Stripe et en direct au-dessus ; frais, retenues et argent encore chez Stripe en
                    dessous ; la courbe suit ce qui arrive sur le compte pro.{" "}
                    {/* Souligné : dans une phrase, un lien ne se distingue pas par la seule couleur. */}
                    <Link to="/flux-stripe" className="link underline! underline-offset-2">
                      Rapprochement détaillé
                    </Link>
                  </>
                ) : (
                  "Encaissé au-dessus, provisions et retraits en dessous ; la courbe suit le salaire disponible cumulé."
                )}
              </p>
              <div className="h-80 p-3 sm:p-5">
                <Suspense fallback={<div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />}>
                  {flowView === "stripe" ? (
                    stripeFlux ? (
                      <StripePathChart months={stripeFlux.slice(wideChart ? -12 : -6)} />
                    ) : (
                      <div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />
                    )
                  ) : ownerPay && FlowsChart ? (
                    <FlowsChart flows={ownerPay.flows.slice(wideChart ? -12 : -6)} />
                  ) : (
                    <div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />
                  )}
                </Suspense>
              </div>
            </Card>
          ) : null}
          <Card className="min-w-0 overflow-hidden">
            <SectionTitle>Répartition des encaissements</SectionTitle>
            <div className="h-72 p-3 sm:p-5">
              {data && RevenueChart ? (
                <RevenueChart data={data.chart} />
              ) : (
                <div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />
              )}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <SectionTitle
                action={
                  <Link to="/invoices" className="link inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-sm">
                    Toutes
                  </Link>
                }
              >
                Factures à encaisser
              </SectionTitle>
              {!ready ? (
                <SkeletonRows count={3} rowClass="flex min-h-14 items-center px-5 py-2.5" />
              ) : pending.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">Aucune facture en attente de paiement.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {pending.map((inv) => (
                    <li key={inv.id}>
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="flex min-h-12 items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-[var(--surface-raised)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{inv.displayName}</span>
                          <span className="font-mono text-xs text-[var(--muted)]">{inv.number}</span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">{formatEUR(inv.remaining)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="overflow-hidden">
              <SectionTitle>Relances automatiques</SectionTitle>
              {!ready ? (
                <SkeletonRows count={1} rowClass="flex min-h-16 items-center px-5 py-2.5" />
              ) : reminders.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Aucune relance en attente.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {reminders.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <Link
                        to={r.documentType === "QUOTE" ? `/quotes/${r.id}` : `/invoices/${r.id}`}
                        className="flex min-h-11 min-w-0 flex-col justify-center hover:text-[var(--primary)]"
                      >
                        <span className="block truncate font-medium">{r.client.displayName}</span>
                        <span className="text-xs text-[var(--muted)]">
                          {r.documentType === "QUOTE" ? "Devis" : "Facture"} {r.number ?? ""} · {r.reminderCount} relance
                          {r.reminderCount > 1 ? "s" : ""}
                        </span>
                      </Link>
                      <Button variant="secondary" className="shrink-0 px-3 text-sm" onClick={() => setReminderFor(r.id)}>
                        Envoyer
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-[var(--border)] px-5 py-3">
                <Button variant="ghost" className="w-full text-sm" disabled={remindersRunBusy} onClick={() => void runAllReminders()}>
                  {remindersRunBusy ? "Exécution…" : "Exécuter les rappels maintenant"}
                </Button>
              </div>
            </Card>
          </div>
        </div>

        <div className="order-first space-y-6 xl:order-none">
          <Card className="overflow-hidden">
            <SectionTitle
              action={
                <span className="rounded-full bg-[var(--surface-hover)] px-2 text-xs font-medium tabular-nums leading-6 text-[var(--muted)]">
                  {ready ? obligationAlerts + (echeanceDue ? 1 : 0) + ((data?.drafts ?? 0) > 0 ? 1 : 0) + (mailStale ? 1 : 0) + (companyEmailAlert ? 1 : 0) + deposit2Rows.length + pendingStarts.length + renewals.length + revisionsToAttach.length : <Skeleton className="w-3" />}
                </span>
              }
            >
              À traiter
            </SectionTitle>
            {!ready ? (
              <SkeletonRows count={2} rowClass="flex min-h-15 items-center px-5 py-3" />
            ) : obligationAlerts === 0 && !echeanceDue && (data?.drafts ?? 0) === 0 && !mailStale && !companyEmailAlert && deposit2Rows.length === 0 && pendingStarts.length === 0 && renewals.length === 0 && revisionsToAttach.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Rien en attente. Tout est à jour.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] px-5">
                {companyEmailAlert ? (
                  // Ligne et non bandeau en haut de page : elle arrivait avec les données et décalait tout l'écran.
                  <TodoRow
                    icon={faEnvelope}
                    tone="warning"
                    title={companyEmailAlert.message}
                    action={
                      <Link to="/settings?tab=general&section=contact" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Renseigner <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {mailStale ? (
                  <TodoRow
                    icon={faEnvelope}
                    tone="danger"
                    title="Messagerie : synchronisation automatique arrêtée"
                    detail={
                      mailSyncAge === Infinity
                        ? "Aucune synchronisation enregistrée"
                        : `Dernière synchro ${formatAgoMinutes(mailSyncAge ?? 0)}`
                    }
                    action={
                      <Link to="/inbox" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {revisionsToAttach.map((r) => (
                  <TodoRow
                    key={`attach-${r.lineId}`}
                    icon={faLink}
                    tone="warning"
                    title={`Avenant ${r.quoteNumber ?? ""} à rattacher`}
                    detail={`${r.displayName} : « ${r.description} », plusieurs abonnements possibles`}
                    action={
                      <Link to={`/abonnements?rattacher=${encodeURIComponent(r.lineId)}`} className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Rattacher <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ))}
                {renewals.map((r) => (
                  <TodoRow
                    key={`renewal-${r.id}`}
                    icon={faRotate}
                    tone="primary"
                    title={`${r.label} : renouvellement le ${formatDate(r.renewsAt)}`}
                    detail={`${r.displayName}${r.provider ? `, chez ${r.provider}` : ""}${r.notifyClient ? ", client prévenu par e-mail" : ""}`}
                    action={
                      <Link to={`/clients/${r.clientId}#renouvellements`} className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ))}
                {pendingStarts.map((p) => (
                  <TodoRow
                    key={`start-${p.quoteId}`}
                    icon={faHourglassHalf}
                    tone="muted"
                    title={`Démarrage au plus tôt le ${formatDate(p.startsNotBefore)}`}
                    detail={`${p.displayName}, devis ${p.number ?? ""} : délai de rétractation en cours`}
                    action={
                      <Link to={`/quotes/${p.quoteId}`} className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ))}
                {deposit2Rows.map((q) => (
                  <TodoRow
                    key={`${q.kind}-${q.quoteId}`}
                    icon={faFileInvoice}
                    tone={q.kind === "toInvoice" ? "warning" : "primary"}
                    title={
                      q.kind === "toInvoice"
                        ? `2e acompte à facturer : ${formatEUR(q.amountCents)}`
                        : "Étape du 2e acompte à choisir"
                    }
                    detail={`${q.displayName}, devis ${q.number ?? ""}`}
                    action={
                      <Link to={`/quotes/${q.quoteId}`} className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ))}
                {os && obligationAlerts > 0 ? (
                  <TodoRow
                    icon={faClipboardCheck}
                    tone={os.late > 0 ? "danger" : os.urgent > 0 ? "warning" : "primary"}
                    title={
                      os.late > 0
                        ? `${os.late} démarche${os.late > 1 ? "s" : ""} en retard`
                        : `${obligationAlerts} démarche${obligationAlerts > 1 ? "s" : ""} à faire`
                    }
                    detail={obligations?.nextDue?.label}
                    action={
                      <Link to="/obligations" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {echeanceDue && data ? (
                  <TodoRow
                    icon={faLandmark}
                    tone="warning"
                    title={`URSSAF ${data.echeance.periodLabel} : ${formatEUR(data.echeance.amountDueCents)}`}
                    detail={`À déclarer avant le ${formatDate(data.echeance.deadline)}`}
                    action={
                      <Link to="/urssaf" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Déclarer <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {data && data.drafts > 0 ? (
                  <TodoRow
                    icon={faFilePen}
                    tone="muted"
                    title={`${data.drafts} brouillon${data.drafts > 1 ? "s" : ""} à finaliser`}
                    action={
                      <Link to="/quotes" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle
              action={
                <Link to="/inbox" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                  Ouvrir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                </Link>
              }
            >
              <span className="inline-flex items-center gap-2">
                Messagerie
                {unreadMail > 0 ? (
                  <span className="rounded-full bg-[var(--primary)] px-1.5 text-[0.6875rem] font-semibold leading-5 text-[var(--primary-fg)]">
                    {unreadMail} non lu{unreadMail > 1 ? "s" : ""}
                  </span>
                ) : null}
              </span>
            </SectionTitle>
            {!ready ? (
              <SkeletonRows count={5} rowClass="flex min-h-15 items-center px-5 py-3" />
            ) : mail === null ? (
              <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Messages indisponibles pour le moment.</p>
            ) : mail.messages.length === 0 && data?.mailSync?.imapConfigured === false ? (
              <div className="px-5 py-6 text-center text-sm text-[var(--muted)]">
                <p>Boîte mail non connectée.</p>
                <Link to="/settings?tab=email" className="link mt-1 inline-flex min-h-11 items-center">
                  Configurer la messagerie
                </Link>
              </div>
            ) : mail.messages.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Aucun échange pour le moment.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {mail.messages.map((m) => {
                  const unread = !m.isRead;
                  return (
                    <li key={m.id}>
                      <Link to={`/inbox/${m.threadId}`} className="flex gap-3 px-5 py-3 hover:bg-[var(--surface-raised)]">
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-[var(--primary)]" : "bg-transparent"}`}
                          aria-label={unread ? "non lu" : undefined}
                        />
                        <span className="min-w-0 flex-1">
                          {/* Nom lisible d'abord (10rem au moins) : sur un écran étroit, la date passe à la ligne. */}
                          <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                            <span className={`min-w-[min(100%,10rem)] flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}>
                              {formMessageName(m, m.client?.displayName) ?? m.client?.displayName ?? m.fromName ?? m.fromAddress}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{formatMailDate(m.receivedAt)}</span>
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
                            {formMessageName(m) ? (
                              <span className="inline-flex shrink-0 items-center gap-1">
                                <FontAwesomeIcon icon={faGlobe} className="h-3 w-3" aria-hidden />
                                via formulaire
                              </span>
                            ) : null}
                            <span className="min-w-0 truncate">{m.subject}</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle>En un coup d'œil</SectionTitle>
            <dl className="divide-y divide-[var(--border)] px-5 text-sm">
              {[
                {
                  label: "Revenus récurrents",
                  value: mrr && mrr.mrrCents > 0 ? `${formatEUR(mrr.mrrCents)} / mois` : "Aucun",
                  to: "/abonnements",
                },
                ...(mrr?.upcomingCount
                  ? [{ label: "Récurrents à venir", value: `${formatEUR(mrr.upcomingMrrCents ?? 0)} / mois`, to: "/abonnements" }]
                  : []),
                { label: "Abonnements actifs", value: String(mrr?.activeCount ?? 0), to: "/abonnements" },
                { label: "Brouillons", value: String((data?.drafts ?? 0)), to: "/quotes" },
                { label: "Relances en attente", value: String(reminders.length), to: null },
              ].map((row) => (
                <div key={row.label} className="flex min-h-11 items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">{row.label}</dt>
                  <dd className="font-semibold tabular-nums">
                    {!ready ? (
                      <Skeleton className="w-10" />
                    ) : row.to ? (
                      <Link to={row.to} className="inline-flex min-h-11 min-w-11 items-center justify-end hover:text-[var(--primary)]">
                        {row.value}
                      </Link>
                    ) : (
                      row.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>

    </div>
  );
}
