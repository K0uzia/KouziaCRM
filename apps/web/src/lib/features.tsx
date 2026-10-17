import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchSettings } from "@/lib/settings-request";
import { useAuth } from "@/lib/auth";
import { onReconnect } from "@/lib/network";

export type FeatureFlags = {
  moduleBankEnabled: boolean;
  moduleSubscriptionsEnabled: boolean;
  moduleStripeEnabled: boolean;
};

const DEFAULTS: FeatureFlags = {
  moduleBankEnabled: false,
  moduleSubscriptionsEnabled: true,
  moduleStripeEnabled: false,
};

type FeaturesCtx = FeatureFlags & {
  loading: boolean;
  refresh: () => Promise<void>;
};

const Ctx = createContext<FeaturesCtx | null>(null);

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  const load = useCallback(async (force: boolean) => {
    if (!user) {
      setFlags(DEFAULTS);
      setLoading(false);
      return;
    }
    try {
      const data = await fetchSettings<Partial<FeatureFlags>>({ force });
      setFlags({
        moduleBankEnabled: data.moduleBankEnabled ?? DEFAULTS.moduleBankEnabled,
        moduleSubscriptionsEnabled:
          data.moduleSubscriptionsEnabled ?? DEFAULTS.moduleSubscriptionsEnabled,
        moduleStripeEnabled: data.moduleStripeEnabled ?? DEFAULTS.moduleStripeEnabled,
      });
      setStale(false);
    } catch {
      // Lecture impossible (réseau coupé) : les modules déjà connus restent affichés, le menu ne change pas.
      setStale(true);
    } finally {
      setLoading(false);
    }
  }, [user]);
  // Après un enregistrement : relecture forcée, jamais la réponse partagée d'avant.
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);
  // Lecture manquée hors ligne : reprise au retour du réseau.
  useEffect(() => (stale ? onReconnect(() => void load(true)) : undefined), [stale, load]);

  const value = useMemo(
    () => ({ ...flags, loading, refresh }),
    [flags, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFeatures() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFeatures hors FeaturesProvider");
  return ctx;
}
