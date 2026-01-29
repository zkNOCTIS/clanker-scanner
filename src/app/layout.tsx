import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clanker Scanner",
  description: "Live Clanker token deploy scanner",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0a0a0a]">{children}</body>
    </html>
  );
}
