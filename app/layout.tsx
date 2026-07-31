// app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Noto_Sans_Thai } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

/**
 * Typefaces.
 *
 * The app targets an Apple-like look, but SF Pro cannot legally be served from
 * a website — Apple licenses it for Apple-platform UI development only. So the
 * stack in `--font-app` (globals.css) asks for the real thing first via
 * `-apple-system`, which resolves to SF Pro on macOS/iOS, and falls back to
 * Inter everywhere else. Inter is the closest open face to SF: same humanist
 * grotesque skeleton, tall x-height, near-identical digit and letter widths.
 *
 * Both are loaded through next/font, so they are self-hosted from our own
 * origin, preloaded, and size-adjusted against the fallback to avoid layout
 * shift — no runtime request to Google.
 *
 * Inter has no Thai coverage, and this app is Thai-language throughout. Noto
 * Sans Thai is listed *after* the Latin faces in the stack: CSS font fallback
 * is per-character, so Latin glyphs render in SF/Inter while Thai glyphs drop
 * through to Noto. Before this, Thai rendered in whatever the OS happened to
 * have (Leelawadee UI on Windows, Thonburi on macOS) — different on every
 * machine.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  display: "swap",
  variable: "--font-noto-thai",
});

export const metadata: Metadata = {
  title: {
    template: "%s | Apartment Flow",
    default: "Apartment Flow",
  },
  description: "Apartment management system.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${inter.variable} ${notoSansThai.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen font-sans">
        {children}
        <Toaster
          richColors
          position="top-center"
          toastOptions={{
            unstyled: false,
            style: { fontFamily: "var(--font-app)" },
            classNames: {
              toast: "!text-base !px-5 !py-4 !gap-3 !rounded-card !shadow-float-lg",
              title: "!text-base !font-semibold",
              description: "!text-sm",
              icon: "!w-5 !h-5",
              closeButton: "!w-5 !h-5",
            },
          }}
        />
      </body>
    </html>
  );
}
