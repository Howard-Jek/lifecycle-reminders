import type { MetadataRoute } from "next"

/**
 * Only the landing page and the two auth forms are public. Everything else is
 * behind a session and would 307 a crawler to /signin anyway — but saying so
 * explicitly stops the redirects showing up as soft-404s and keeps the app's
 * URL shape out of any index.
 *
 * The AI crawlers are blocked separately from the search crawlers because they
 * are a different bargain. A search engine sends visitors back; a training
 * crawler takes the copy and the product's positioning and returns nothing.
 * Note that this is a request, not a control — it is honoured by convention. If
 * something must not be read, it belongs behind auth, which everything of value
 * here already is.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "CCBot",
  "meta-externalagent",
  "FacebookBot",
  "Amazonbot",
  "cohere-ai",
  "Diffbot",
  "Timpibot",
  "omgili",
]

/** Never index these, whoever is asking. */
const PRIVATE_PATHS = [
  "/api/",
  "/reminders",
  "/contacts",
  "/import",
  "/team",
  "/settings",
  "/sandbox",
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/signin", "/signup"], disallow: PRIVATE_PATHS },
      { userAgent: AI_CRAWLERS, disallow: "/" },
    ],
    // No sitemap: three public URLs, all reachable from the landing page in one
    // hop. A sitemap here would be ceremony, not discovery.
  }
}
