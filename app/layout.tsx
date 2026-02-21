import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Image Aligner",
  description: "Import images and align them with drag, resize, and opacity controls",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
