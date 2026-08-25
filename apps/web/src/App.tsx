import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { ClientsPage, ClientDetailPage } from "@/pages/ClientsPage";
import {
  QuotesPage,
  InvoicesPage,
  DocumentDetailPage,
} from "@/pages/DocumentsPages";
import { PaymentsPage } from "@/pages/PaymentsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ServicesPage } from "@/pages/ServicesPage";
import { TrackingPage } from "@/pages/TrackingPage";
import { ReceiptsBookPage } from "@/pages/ReceiptsBookPage";
import { ObligationsPage } from "@/pages/ObligationsPage";
import {
  BanquePage,
  InboxPage,
  InboxThreadPage,
  ComposePage,
} from "@/pages/OtherPages";

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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/suivi" element={<TrackingPage />} />
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
        <Route path="quotes" element={<QuotesPage />} />
        <Route path="quotes/:id" element={<DocumentDetailPage kind="QUOTE" />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/:id" element={<DocumentDetailPage kind="INVOICE" />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="receipts" element={<ReceiptsBookPage />} />
        <Route path="obligations" element={<ObligationsPage />} />
        <Route path="banque" element={<BanquePage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/compose" element={<ComposePage />} />
        <Route path="inbox/:threadId" element={<InboxThreadPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
