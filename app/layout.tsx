// app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sarabun } from "next/font/google";
import "./globals.css";

const sarabun = Sarabun({
  subsets: ["latin", "thai"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sarabun",
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
    <html lang="en" suppressHydrationWarning>
      <body className={`${sarabun.variable} font-sans`}>{children}</body>
    </html>
  );
}
