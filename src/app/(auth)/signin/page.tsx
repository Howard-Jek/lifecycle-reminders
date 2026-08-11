import { AuthForm } from "@/components/auth-form"
import { signIn } from "@/app/actions/auth"

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const notice = typeof params.notice === "string" ? params.notice : null
  return <AuthForm mode="signin" action={signIn} notice={notice} />
}
