import { AuthForm } from "@/components/auth-form"
import { signUp } from "@/app/actions/auth"

export default function SignUpPage() {
  return <AuthForm mode="signup" action={signUp} />
}
