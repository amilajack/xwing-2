import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { siteName } from "./site";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host ?? "localhost:3000"}`);
  const description = "A performance-first WebGPU starfighter dogfight.";

  return {
    metadataBase: baseUrl,
    title: siteName,
    description,
    // Launched from the Home Screen, let the game draw under the status bar;
    // the viewport already covers the notch and the controls keep clear of it.
    appleWebApp: {
      capable: true,
      title: siteName,
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      title: siteName,
      description,
      type: "website",
      url: baseUrl,
      images: [{ url: new URL("/og.png", baseUrl), width: 1920, height: 1080 }],
    },
    twitter: {
      card: "summary_large_image",
      title: siteName,
      description,
      images: [new URL("/og.png", baseUrl)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
