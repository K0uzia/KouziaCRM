"use client";

import {
  UrssafAlertBanner,
  type UrssafAlertData,
} from "@/components/dashboard/urssaf-alert-banner";

export type EcheanceData = UrssafAlertData;

export function UrssafEcheanceCard({ echeance }: { echeance: EcheanceData }) {
  return <UrssafAlertBanner alert={echeance} />;
}
