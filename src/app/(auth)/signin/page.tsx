import { AuthForm } from "@/components/auth-form"
import { signIn } from "@/app/actions/auth"

export const metadata = { title: "Sign in" }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await searchParams
  /**
   * `?notice=` used to be read from the URL and rendered verbatim in the form's
   * error block. Nothing in this app ever SET it — grep found one reader and no
   * writer — so its only reachable use was an attacker handing somebody
   * `/signin?notice=Session+expired,+email+support@evil.example` and getting
   * arbitrary text rendered inside a real login page on the real domain.
   *
   * React escapes it, so this was never script injection. It was a phishing
   * surface on the one page where a user is primed to type a password, which is
   * worse than it sounds and free to remove.
   *
   * If a notice is ever genuinely needed here, pass a CODE and look up the text
   * on this side — never render the query string.
   */
  return <AuthForm mode="signin" action={signIn} notice={null} />
}
