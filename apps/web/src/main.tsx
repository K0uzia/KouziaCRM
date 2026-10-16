import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { FeaturesProvider } from "@/lib/features";
import App from "./App";
import { PageErrorBoundary, reloadOnceForStaleChunk } from "@/components/PageErrorBoundary";
import "./index.css";

// Fichier d'une page supprimé par une mise à jour (onglet resté ouvert) : rechargement unique ; au-delà,
// l'erreur remonte à PageErrorBoundary, qui propose « Recharger ».
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

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
            // Centré en haut : loin des onglets du bas et de la feuille des notifications sur mobile. Sur ordinateur,
            // sous la barre du haut (recherche, Publier, Créer restent visibles) ; en bas, il masquerait les actions des modales.
            position="top-center"
            theme="dark"
            offset={{ top: "calc(var(--topbar-h) + 0.75rem)" }}
            mobileOffset={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
            toastOptions={{ className: "max-w-[calc(100vw-2rem)]" }}
          />
        </FeaturesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
