"use client"

import * as React from "react"
import { MoonIcon, SunIcon } from "lucide-react"

type Theme = "light" | "dark"

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark")
}

/**
 * What is on screen right now, read from the page itself.
 *
 * Deliberately NOT re-derived from localStorage: the boot script in
 * app/layout.tsx has already turned that value into a class, and reading it a
 * second time here means a second default to keep in step with the first.
 */
function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

export function ThemeToggle() {
  // Matches a server render, which never carries the class.
  const [theme, setTheme] = React.useState<Theme>("light")
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setTheme(currentTheme())
    setMounted(true)
  }, [])

  const toggle = () => {
    // The page again, not state: a click is always the opposite of what is visible.
    const next: Theme = currentTheme() === "dark" ? "light" : "dark"
    setTheme(next)
    window.localStorage.setItem("theme", next)
    applyTheme(next)
  }

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={toggle}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {mounted && theme === "dark" ? (
        <SunIcon className="size-4" />
      ) : (
        <MoonIcon className="size-4" />
      )}
    </button>
  )
}
