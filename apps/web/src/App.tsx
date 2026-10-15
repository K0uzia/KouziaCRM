import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { fetchSettings } from "@/lib/settings-request";
// Page d'accueil importée directement : chargée en lazy, elle passait par un Suspense dont React 19
// retarde la révélation d'environ 300 ms (FALLBACK_THROTTLE_MS), données déjà arrivées.
import { DashboardPage } from "@/pages/DashboardPage";

const ClientsPage = lazy(() =>
  import("@/pages/ClientsPage").then((m) => ({ default: m.ClientsPage })),
);
const ClientDetailPage = lazy(() =>
  import("@/pages/ClientsPage").then((m) => ({ default: m.ClientDetailPage })),
);
const QuotesPage = lazy(() =>
  import("@/pages/DocumentsPages").then((m) => ({ default: m.QuotesPage })),
);
const InvoicesPage = lazy(() =>
  import("@/pages/DocumentsPages").then((m) => ({ default: m.InvoicesPage })),
);
const DocumentDetailPage = lazy(() =>
  import("@/pages/DocumentsPages").then((m) => ({ default: m.DocumentDetailPage })),
);
const PaymentsPage = lazy(() =>
  import("@/pages/PaymentsPage").then((m) => ({ default: m.PaymentsPage })),
);
// Réglages : la lecture des réglages part en même temps que le fichier de la page (au lieu
// d'attendre son chargement), puis la page reprend la même requête (settings-request).
const SettingsPage = lazy(() => {
  void fetchSettings().catch(() => undefined);
  return import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }));
});
const ServicesPage = lazy(() =>
  import("@/pages/ServicesPage").then((m) => ({ default: m.ServicesPage })),
);
const SubscriptionsPage = lazy(() =>
  import("@/pages/SubscriptionsPage").then((m) => ({ default: m.SubscriptionsPage })),
);
const TrackingRedirectPage = lazy(() =>
  import("@/pages/TrackingRedirectPage").then((m) => ({
    default: m.TrackingRedirectPage,
  })),
);
const OnboardingPage = lazy(() =>
  import("@/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage })),
);
const ReceiptsBookPage = lazy(() =>
  import("@/pages/ReceiptsBookPage").then((m) => ({ default: m.ReceiptsBookPage })),
);
const ObligationsPage = lazy(() =>
  import("@/pages/ObligationsPage").then((m) => ({ default: m.ObligationsPage })),
);
const StripePayoutsPage = lazy(() =>
  import("@/pages/StripePayoutsPage").then((m) => ({ default: m.StripePayoutsPage })),
);
const WithdrawalsPage = lazy(() =>
  import("@/pages/WithdrawalsPage").then((m) => ({ default: m.WithdrawalsPage })),
);
const UrssafPage = lazy(() =>
  import("@/pages/OtherPages").then((m) => ({ default: m.UrssafPage })),
);
const InboxPage = lazy(() =>
  import("@/pages/messaging/InboxPage").then((m) => ({ default: m.InboxPage })),
);
const ComposePage = lazy(() =>
  import("@/pages/messaging/ComposePage").then((m) => ({ default: m.ComposePage })),
);
// Espace « Site » : un morceau par écran, chargé à la première visite.
const SiteOverviewPage = lazy(() =>
  import("@/pages/site/SiteOverviewPage").then((m) => ({ default: m.SiteOverviewPage })),
);
const SiteProjectsPage = lazy(() =>
  import("@/pages/site/SiteProjectsPage").then((m) => ({ default: m.SiteProjectsPage })),
);
const SiteProjectPage = lazy(() =>
  import("@/pages/site/SiteProjectsPage").then((m) => ({ default: m.SiteProjectPage })),
);
const SiteReviewsPage = lazy(() =>
  import("@/pages/site/SiteReviewsPage").then((m) => ({ default: m.SiteReviewsPage })),
);
const SiteReferencesPage = lazy(() =>
  import("@/pages/site/SiteReferencesPage").then((m) => ({ default: m.SiteReferencesPage })),
);
const SiteFaqPage = lazy(() =>
  import("@/pages/site/SiteFaqPage").then((m) => ({ default: m.SiteFaqPage })),
);
const SiteContactPage = lazy(() =>
  import("@/pages/site/SiteTextsPage").then((m) => ({ default: m.SiteContactPage })),
);
const SiteHeroPage = lazy(() =>
  import("@/pages/site/SiteTextsPage").then((m) => ({ default: m.SiteHeroPage })),
);
const SiteOffersPage = lazy(() =>
  import("@/pages/site/SiteTextsPage").then((m) => ({ default: m.SiteOffersPage })),
);
const SiteTextsRedirect = lazy(() =>
  import("@/pages/site/SiteTextsPage").then((m) => ({ default: m.SiteTextsRedirect })),
);
const SiteConnectionPage = lazy(() =>
  import("@/pages/site/SiteConnectionPage").then((m) => ({ default: m.SiteConnectionPage })),
);

function PageFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--muted)]">
      Chargement…
    </div>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[var(--muted)]">
        Chargement…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function LazyDoc({ kind }: { kind: "QUOTE" | "INVOICE" }) {
  return (
    <Suspense fallback={<PageFallback />}>
      <DocumentDetailPage kind={kind} />
    </Suspense>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/suivi" element={<TrackingRedirectPage />} />
        <Route path="/onboarding/:token" element={<OnboardingPage />} />
        <Route
          element={
            <Protected>
              <AppLayout />
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:id" element={<ClientDetailPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="abonnements" element={<SubscriptionsPage />} />
          <Route path="quotes" element={<QuotesPage />} />
          <Route path="quotes/:id" element={<LazyDoc kind="QUOTE" />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="invoices/:id" element={<LazyDoc kind="INVOICE" />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="receipts" element={<ReceiptsBookPage />} />
          <Route path="obligations" element={<ObligationsPage />} />
          <Route path="flux-stripe" element={<StripePayoutsPage />} />
          {/* Ancienne adresse « Versements Stripe » : redirigée vers « Flux Stripe ». */}
          <Route path="versements" element={<Navigate to="/flux-stripe" replace />} />
          <Route path="retraits" element={<WithdrawalsPage />} />
          <Route path="banque" element={<Navigate to="/flux-stripe" replace />} />
          <Route path="urssaf" element={<UrssafPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="inbox/compose" element={<ComposePage />} />
          <Route path="inbox/:threadId" element={<InboxPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="site" element={<SiteOverviewPage />} />
          <Route path="site/realisations" element={<SiteProjectsPage />} />
          <Route path="site/realisations/:id" element={<SiteProjectPage />} />
          <Route path="site/avis" element={<SiteReviewsPage />} />
          <Route path="site/references" element={<SiteReferencesPage />} />
          <Route path="site/faq" element={<SiteFaqPage />} />
          <Route path="site/coordonnees" element={<SiteContactPage />} />
          <Route path="site/accroche" element={<SiteHeroPage />} />
          <Route path="site/offres" element={<SiteOffersPage />} />
          {/* Ancien écran unique « Textes et coordonnées » (?tab=accroche|offres). */}
          <Route path="site/textes" element={<SiteTextsRedirect />} />
          <Route path="site/connexion" element={<SiteConnectionPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
