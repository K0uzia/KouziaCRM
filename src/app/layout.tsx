import type { Metadata } from "next";
import { Fraunces, Source_Sans_3 } from "next/font/google";
import { Toaster } from "sonner";
import { FontAwesomeProvider } from "@/components/providers/fontawesome-provider";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

const sans = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "KouziaCRM",
  description: "CRM et facturation pour EI Kouzia",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className={`${display.variable} ${sans.variable} antialiased`}>
        <FontAwesomeProvider>
          {children}
          <Toaster richColors position="top-right" />
        </FontAwesomeProvider>
      </body>
    </html>
  );
}
