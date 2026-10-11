import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { FeaturesProvider } from "@/lib/features";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <FeaturesProvider>
          <App />
          <Toaster
            richColors
            // Centré en haut : loin des onglets du bas et de la feuille des notifications sur mobile.
            position="top-center"
            theme="dark"
            offset="1.5rem"
            mobileOffset={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
            toastOptions={{ className: "max-w-[calc(100vw-2rem)]" }}
          />
        </FeaturesProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
