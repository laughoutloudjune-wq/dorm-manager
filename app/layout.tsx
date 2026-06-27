// app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import "./globals.css";

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
      <body className="min-h-screen font-sans">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
