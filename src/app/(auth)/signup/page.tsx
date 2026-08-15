import { AuthForm } from "@/components/auth-form"
import { signUp } from "@/app/actions/auth"

export const metadata = { title: "Sign up" }

export default function SignUpPage() {
  return <AuthForm mode="signup" action={signUp} />
}
