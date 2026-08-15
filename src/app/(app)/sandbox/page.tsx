import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { isDryRun } from "@/lib/env"
import { listSandboxMessages } from "@/app/actions/sandbox"
import { SandboxClient } from "./sandbox-client"

export const metadata = { title: "Sandbox" }

export const dynamic = "force-dynamic"

export default async function SandboxPage() {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const [messages, { data: contacts }, probe, business] = await Promise.all([
    listSandboxMessages(),
    admin
      .from("leads")
      .select("id, name, phone")
      .eq("business_id", tenant.businessId)
      .order("name")
      .limit(50),
    // Distinguish "no messages yet" from "the sandbox migration was never
    // applied" — they look identical from an empty list, and only one of them
    // is the user's fault.
    admin.from("sandbox_messages").select("id", { head: true, count: "exact" }).limit(1),
    admin
      .from("businesses")
      .select("timezone")
      .eq("id", tenant.businessId)
      .maybeSingle<{ timezone: string | null }>(),
  ])

  return (
    <SandboxClient
      messages={messages}
      contacts={(contacts ?? []) as Array<{ id: string; name: string; phone: string }>}
      senderConfigured={Boolean(
        process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim() &&
          process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim(),
      )}
      dryRun={isDryRun()}
      tableMissing={Boolean(probe.error)}
      timezone={business.data?.timezone || "Asia/Singapore"}
    />
  )
}
