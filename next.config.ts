import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  experimental: {
    // Spreadsheets travel through a server action. The framework default of
    // 1 MB silently truncates them; the parser's own 10 MB cap (src/lib/import
    // /read-file.ts) is the real limit and it reports when it is hit.
    serverActions: { bodySizeLimit: "30mb" },
  },
}

export default nextConfig
