import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { t } from "../lib/i18n";
import { Providers } from "./providers";
import "./globals.css";

// DESIGN_SYSTEM.md Part 2. Self-hosted at build time by next/font rather than linked from
// Google's CDN — one less third-party request on a screen that may take a payment, and no
// flash of a fallback face while a figure is being read.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"], // latin-ext carries the Lithuanian diacritics (ADR-040)
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: t("app.name"),
  description: "Financial infrastructure for restaurants, cafés, and bars.",
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="bg-ground font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
