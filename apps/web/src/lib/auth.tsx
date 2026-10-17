import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { isOnline, onReconnect } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { forgetUser, readUser, saveUser } from "@/lib/offline/store";

type User = { id: string; email: string; name: string | null };

/** Utilisateur gardé dans la copie chiffrée (id, e-mail, nom : aucun secret), oublié à la déconnexion. */
function rememberUser(user: User | null): void {
  if (!offlineEnabled()) return;
  void (user ? saveUser(user) : forgetUser()).catch(() => undefined);
}

type AuthCtx = {
  user: User | null;
  loading: boolean;
  /** Session pas encore vérifiée faute de réseau ou de serveur (premier chargement). */
  unreachable: boolean;
  /** "mfa" : mot de passe accepté, code de la double authentification attendu. */
  login: (email: string, password: string) => Promise<"ok" | "mfa">;
  verifySecondFactor: (input: { code: string } | { recoveryCode: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [unreachable, setUnreachable] = useState(false);

  // Déconnexion seulement sur une réponse du serveur ({ user: null } ou 401). Réseau coupé ou serveur en
  // panne : l'utilisateur connu est gardé. Au premier chargement sur l'origine du hors ligne, l'utilisateur de
  // la copie chiffrée ouvre l'ERP ; la session du serveur reprend la main dès qu'il répond.
  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User | null }>("/api/auth/me");
      setUser(data.user);
      setUnreachable(false);
      setLoading(false);
      rememberUser(data.user);
    } catch (error) {
      if ((error as { status?: unknown }).status === 401) {
        setUser(null);
        setUnreachable(false);
        setLoading(false);
        rememberUser(null);
      } else {
        setUnreachable(true);
        const known = offlineEnabled() ? await readUser().catch(() => null) : null;
        if (known) {
          setUser((current) => current ?? known);
          setLoading(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Session pas encore confirmée par le serveur (ERP ouvert sans réseau) : nouvel essai au retour du réseau,
  // et toutes les 10 s.
  useEffect(() => {
    if (!unreachable) return;
    const stop = onReconnect(() => void refresh());
    const timer = window.setInterval(() => {
      if (isOnline()) void refresh();
    }, 10_000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [unreachable, refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ user: User } | { mfaRequired: true }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if ("mfaRequired" in data) return "mfa" as const;
    setUser(data.user);
    rememberUser(data.user);
    return "ok" as const;
  }, []);

  const verifySecondFactor = useCallback(async (input: { code: string } | { recoveryCode: string }) => {
    const data = await api<{ user: User }>("/api/auth/2fa", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setUser(data.user);
    rememberUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    rememberUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, unreachable, login, verifySecondFactor, logout, refresh }),
    [user, loading, unreachable, login, verifySecondFactor, logout, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth hors AuthProvider");
  return ctx;
}
