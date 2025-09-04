import type { Metadata } from "next";
import "./globals.css";
import Script from "next/script";
import './styles/app.minimal.pro.css'; 

export const metadata: Metadata = {
  title: "DocScan OCR (tha+eng) | Next.js Starter",
  description: "Client-side document crop + OCR + simple heading parser",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <head>
        {/* OpenCV.js from CDN (kept client-side) */}
        <Script src="https://docs.opencv.org/4.x/opencv.js" strategy="beforeInteractive" />
      </head>
      <body className="min-h-screen antialiased bg-gradient-to-b from-gray-50 to-white">
        {children}
      </body>
    </html>
  );
}
