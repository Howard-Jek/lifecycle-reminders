"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import type { AuthState } from "@/lib/auth-state"

function readCredentials(formData: FormData) {
  return {
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  }
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const { email, password } = readCredentials(formData)
  if (!email || !password) return { error: "Email and password are both required." }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  // Deliberately not distinguishing "no such account" from "wrong password":
  // the difference is an account-enumeration oracle.
  if (error) return { error: "That email and password do not match an account." }

  redirect("/reminders")
}

/**
 * Self-serve signup is closed; operators are invited.
 *
 * Kept as a stub rather than deleted because a server action is addressable by
 * its compiled id, and those ids live in already-shipped client bundles. A
 * deleted action leaves the id resolving to nothing and the caller gets an
 * opaque framework error; this returns something a human can act on.
 *
 * THIS IS NOT THE CONTROL, and the distinction matters. The anon key is public
 * by design, so `POST /auth/v1/signup` at Supabase is reachable from anywhere
 * without touching this file at all. `disable_signup: true` on the project is
 * what actually closes it — see docs/ENROLMENT.md. This only makes the app
 * honest about a door that is shut elsewhere.
 */
export async function signUp(_prev: AuthState, _formData: FormData): Promise<AuthState> {
  return {
    error:
      "Accounts are set up by invitation. Get in touch and we will send you a sign-in link.",
  }
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/signin")
}
