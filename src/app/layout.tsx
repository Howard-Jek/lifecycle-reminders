import type { Metadata } from "next"
import { DM_Sans, Geist_Mono } from "next/font/google"
import "./globals.css"

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  /**
   * `metadataBase` is what makes every relative URL below resolve — without it
   * Next emits a build warning and og:image comes out relative, which every
   * social and messaging unfurler ignores.
   *
   * APP_PUBLIC_URL is already required and validated at boot (src/lib/env.ts
   * refuses a non-absolute value), so this reuses it rather than hardcoding a
   * second copy of the origin that could drift.
   */
  metadataBase: new URL(process.env.APP_PUBLIC_URL ?? "http://localhost:3000"),
  title: {
    default: "Lifecycle — client date reminders for insurance agencies",
    /** Every page sets its own; this frames it. */
    template: "%s · Lifecycle",
  },
  description:
    "Lifecycle reads the dates already in your spreadsheet, works out which ones are worth a " +
    "conversation this week, and WhatsApps the agent who owns that client — with something to say.",
  applicationName: "Lifecycle",
  // The landing page is shared in sales conversations and pasted into WhatsApp,
  // which is exactly where an unfurl either helps or looks broken.
  openGraph: {
    type: "website",
    siteName: "Lifecycle",
    title: "Nobody can watch 200 clients' dates.",
    description:
      "Client date reminders that go to the agent who owns the relationship — never to the client.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Nobody can watch 200 clients' dates.",
    description:
      "Client date reminders that go to the agent who owns the relationship — never to the client.",
  },
  alternates: { canonical: "/" },
  /**
   * The app itself is private and behind auth; only "/", /signin and /signup
   * are reachable signed out. robots.ts disallows the rest, and this is the
   * matching per-page directive for anything that slips past it.
   */
  robots: { index: true, follow: true },
}

// Runs before first paint, so a dark-mode reload never flashes light. Kept
// inline and tiny for the same reason — a deferred script is too late.
const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    if (stored === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
