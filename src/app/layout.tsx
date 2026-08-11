import type { Metadata } from "next"
import { DM_Sans, Geist_Mono } from "next/font/google"
import "./globals.css"

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Lifecycle",
  description: "Client date reminders for the people who own the relationship.",
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
