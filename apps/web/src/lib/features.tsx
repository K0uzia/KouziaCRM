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
import { useAuth } from "@/lib/auth";

export type FeatureFlags = {
  moduleBankEnabled: boolean;
  moduleSubscriptionsEnabled: boolean;
  moduleMerchantApiEnabled: boolean;
};

const DEFAULTS: FeatureFlags = {
  moduleBankEnabled: false,
  moduleSubscriptionsEnabled: true,
  moduleMerchantApiEnabled: false,
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

  const refresh = useCallback(async () => {
    if (!user) {
      setFlags(DEFAULTS);
      setLoading(false);
      return;
    }
    try {
      const data = await api<Partial<FeatureFlags>>("/api/settings");
      setFlags({
        moduleBankEnabled: data.moduleBankEnabled ?? DEFAULTS.moduleBankEnabled,
        moduleSubscriptionsEnabled:
          data.moduleSubscriptionsEnabled ?? DEFAULTS.moduleSubscriptionsEnabled,
        moduleMerchantApiEnabled:
          data.moduleMerchantApiEnabled ?? DEFAULTS.moduleMerchantApiEnabled,
      });
    } catch {
      setFlags(DEFAULTS);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
