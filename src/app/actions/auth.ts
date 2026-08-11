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

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const { email, password } = readCredentials(formData)
  if (!email || !password) return { error: "Email and password are both required." }
  if (password.length < 8) return { error: "Use at least 8 characters." }

  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({ email, password })
  if (error) return { error: error.message }

  // No business is minted here. getTenant() does it on first authenticated
  // request, so signup, an invited user, and any pre-membership straggler all
  // funnel through one code path.
  redirect("/reminders")
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/signin")
}
