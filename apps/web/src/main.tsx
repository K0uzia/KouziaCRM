import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { FeaturesProvider } from "@/lib/features";
import App from "./App";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { AppToaster } from "@/components/ui/AppToaster";
import { installOfflineToasts } from "@/lib/network";
import { startOfflineShell } from "@/lib/sw-register";
import "./index.css";

// Fichier d'une page introuvable (vite:preloadError non intercepté) : l'erreur remonte à PageErrorBoundary, qui
// distingue la mise à jour (rechargement unique) de la coupure réseau (attente du retour en ligne).
installOfflineToasts();
startOfflineShell();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <FeaturesProvider>
          <PageErrorBoundary>
            <App />
          </PageErrorBoundary>
          <AppToaster />
        </FeaturesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
