import type { Metadata } from "next";
import { Geist, Geist_Mono, Chakra_Petch } from "next/font/google";
import "./globals.css";
import { ThemeApplier } from "@/components/theme-applier";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Police display « tactique » — identité console SOC (angulaire, technique).
const chakra = Chakra_Petch({
  variable: "--font-chakra",
  weight: ["500", "600", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DeTecTX — Détection Windows augmentée par IA",
  description:
    "Surveillance de votre poste Windows : collecte, détection, corrélation et analyse assistée par IA.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} ${chakra.variable} h-full antialiased`}
    >
      <body className="relative min-h-dvh">
        <ThemeApplier />
        <div className="aurora" aria-hidden />
        <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
        <div className="app-frame" aria-hidden />
        <div className="grain" aria-hidden />
      </body>
    </html>
  );
}
