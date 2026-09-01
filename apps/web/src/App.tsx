import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";

const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
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
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
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
const BanquePage = lazy(() =>
  import("@/pages/BankPage").then((m) => ({ default: m.BankPage })),
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
const TestimonialsPage = lazy(() =>
  import("@/pages/TestimonialsPage").then((m) => ({ default: m.TestimonialsPage })),
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
          <Route path="banque" element={<BanquePage />} />
          <Route path="urssaf" element={<UrssafPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="inbox/compose" element={<ComposePage />} />
          <Route path="inbox/:threadId" element={<InboxPage />} />
          <Route path="avis" element={<TestimonialsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
