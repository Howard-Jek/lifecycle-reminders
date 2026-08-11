import { listReminderRules } from "@/app/actions/reminder-rules"
import { listIngestTokens } from "@/app/actions/ingest-tokens"
import { getBusinessProfile } from "@/app/actions/business"
import { RulesClient } from "./rules-client"
import { TokensClient } from "./tokens-client"
import { ProfileClient } from "./profile-client"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const [rules, tokens, profile] = await Promise.all([
    listReminderRules(),
    listIngestTokens(),
    getBusinessProfile(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          The policy the engine runs on, as data rather than code.
        </p>
      </div>

      <RulesClient rules={rules} />
      <ProfileClient profile={profile} />
      <TokensClient tokens={tokens} />
    </div>
  )
}
