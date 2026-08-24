import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@react-pdf/renderer",
    "imapflow",
    "nodemailer",
    "mailparser",
    "publicodes",
    "modele-social",
  ],
  experimental: {
    optimizePackageImports: [
      "@fortawesome/react-fontawesome",
      "@fortawesome/free-solid-svg-icons",
      "lucide-react",
      "recharts",
      "date-fns",
    ],
  },
};

export default nextConfig;
