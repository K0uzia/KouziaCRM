import { Sidebar } from "@/components/layout/sidebar";
import { SessionProvider } from "@/components/providers/session-provider";
import { SwrProvider } from "@/components/providers/swr-provider";
import { ModalProvider } from "@/components/providers/modal-provider";

/**
 * Pas de `await auth()` ici : le middleware JWT protège déjà les routes.
 * Évite un round-trip session qui bloquait le shell à chaque navigation.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <SwrProvider>
        <ModalProvider>
          <div className="flex min-h-screen bg-gray-50">
            <Sidebar />
            <main className="flex-1 overflow-auto bg-gray-50 p-6 md:p-8">{children}</main>
          </div>
        </ModalProvider>
      </SwrProvider>
    </SessionProvider>
  );
}
