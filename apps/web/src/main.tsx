import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { FeaturesProvider } from "@/lib/features";
import App from "./App";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
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
          <Toaster
            richColors
            // Centré en haut : loin des onglets du bas et de la feuille des notifications sur mobile. Sous la barre du
            // haut et sous le bandeau réseau posé sur son filet (recherche, Publier, Créer et « Hors ligne » restent
            // visibles) ; en bas, il masquerait les actions des modales.
            position="top-center"
            theme="dark"
            offset={{ top: "calc(var(--topbar-h) + 1.5rem)" }}
            mobileOffset={{ top: "calc(var(--topbar-h) + 1.5rem)" }}
            toastOptions={{ className: "max-w-[calc(100vw-2rem)]" }}
          />
        </FeaturesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
