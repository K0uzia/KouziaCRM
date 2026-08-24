"use client";

import { config } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";

config.autoAddCss = false;

export function FontAwesomeProvider({ children }: { children: React.ReactNode }) {
  return children;
}
