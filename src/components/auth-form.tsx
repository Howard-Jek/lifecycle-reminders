"use client"

import { useActionState } from "react"
import Link from "next/link"
import { Wordmark } from "@/components/wordmark"
import { NO_ERROR, type AuthState } from "@/app/actions/auth"

type Props = {
  mode: "signin" | "signup"
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>
  notice?: string | null
}

const COPY = {
  signin: {
    title: "Welcome back",
    subtitle: "Sign in to your account",
    submit: "Sign in",
    pending: "Signing in…",
    footer: "Don't have an account?",
    linkLabel: "Sign up",
    href: "/signup",
    autoComplete: "current-password",
  },
  signup: {
    title: "Create an account",
    subtitle: "Start watching your clients' dates",
    submit: "Create account",
    pending: "Creating…",
    footer: "Already have an account?",
    linkLabel: "Sign in",
    href: "/signin",
    autoComplete: "new-password",
  },
} as const

export function AuthForm({ mode, action, notice: incoming }: Props) {
  const [state, formAction, pending] = useActionState(action, NO_ERROR)
  const copy = COPY[mode]
  const notice = state.error ?? incoming ?? null

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Wordmark className="text-xl" />
        </div>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <h1 className="mb-1 text-2xl font-semibold text-foreground">{copy.title}</h1>
          <p className="mb-6 text-sm text-muted-foreground">{copy.subtitle}</p>

          <form action={formAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete={copy.autoComplete}
                minLength={mode === "signup" ? 8 : undefined}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>

            {/* Inline, not a toast: the host app has no toast system, and an
                error next to the field it belongs to survives a page change. */}
            {notice && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="mt-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? copy.pending : copy.submit}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {copy.footer}{" "}
            <Link href={copy.href} className="font-medium text-brand-ink hover:underline">
              {copy.linkLabel}
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
