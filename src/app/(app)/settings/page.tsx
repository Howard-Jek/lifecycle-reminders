import { Suspense } from "react"
import { listReminderRules } from "@/app/actions/reminder-rules"
import { listIngestTokens } from "@/app/actions/ingest-tokens"
import { getBusinessProfile } from "@/app/actions/business"
import { getWhatsappConfig, getTemplateStatus } from "@/app/actions/whatsapp"
import type { TemplateStatus } from "@/lib/notify/template-admin"
import { RulesClient } from "./rules-client"
import { packForVertical } from "@/lib/lifecycle/vertical-packs"
import { TokensClient } from "./tokens-client"
import { WhatsappClient } from "./whatsapp-client"
import { TemplateBlock } from "./template-block"
import { ProfileClient } from "./profile-client"

export const metadata = { title: "Settings" }

export const dynamic = "force-dynamic"

/**
 * Settings.
 *
 * Three of the four cards are Postgres reads that come back together in about
 * one round trip. The fourth used to drag the page down with them: the WhatsApp
 * card asked graph.facebook.com for the template's review state, inside the
 * same `Promise.all`, with no deadline — so Meta having a slow minute made
 * every card on the page wait, including the ones that had nothing to do with
 * Meta. Measured in production this was the slowest route in the app.
 *
 * The deadline-free part is correct and stays: this is the page you open *in
 * order to* read that status, so a cached or timed-out answer here would be the
 * wrong answer (the reminder inbox, which only glances at it, does cap and
 * cache — see getSetupSteps). What changes is that being late now costs one
 * block instead of the whole page.
 */
export default async function SettingsPage() {
  /**
   * STARTED HERE, not inside the Suspense boundary, and this line is the whole
   * point of the second half of the fix.
   *
   * An async component below the boundary does not begin until the page's own
   * body has finished awaiting — so putting the Graph call there and nowhere
   * else made the block settle at `db + meta` when it used to settle at
   * `max(db, meta)`. Streaming would have fixed the page's first paint while
   * quietly making this one block slower than before. Kicking the promise off
   * in the same tick as the queries restores the overlap and keeps the paint.
   *
   * Safe to start unconditionally: getTemplateStatus returns null without all
   * three credentials, so nothing is spent when there is nothing to ask. The
   * catch only exists so an unawaited rejection cannot escape in the branch
   * that never renders it — the awaited queries below share requireTenant, so
   * a real auth failure still surfaces from there.
   */
  const statusPromise = getTemplateStatus().catch(() => null)

  // getWhatsappConfig is env-only, so it joins the fast wave.
  const [rules, tokens, profile, whatsapp] = await Promise.all([
    listReminderRules(),
    listIngestTokens(),
    getBusinessProfile(),
    getWhatsappConfig(),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          The policy the engine runs on, as data rather than code.
        </p>
      </div>

      <RulesClient rules={rules} packName={packForVertical(profile.vertical).name} />
      <WhatsappClient
        setup={whatsapp}
        templateBlock={
          whatsapp.configured ? (
            <Suspense
              fallback={
                <TemplateBlock templateName={whatsapp.templateName} configured loading status={null} />
              }
            >
              <TemplateStep templateName={whatsapp.templateName} status={statusPromise} />
            </Suspense>
          ) : (
            // Nothing to ask Meta without credentials, so no boundary and no
            // skeleton — suspending here would flash a placeholder in front of
            // a message that was ready all along.
            <TemplateBlock
              templateName={whatsapp.templateName}
              configured={false}
              status={null}
            />
          )
        }
      />
      <ProfileClient profile={profile} />
      <TokensClient tokens={tokens} timezone={profile.timezone} />
    </div>
  )
}

/**
 * The one part of this page that leaves the building.
 *
 * Takes the promise rather than making the call: by the time this renders, the
 * request is already in flight. See the note at the top of the page.
 */
async function TemplateStep({
  templateName,
  status,
}: {
  templateName: string
  status: Promise<TemplateStatus | null>
}) {
  return <TemplateBlock templateName={templateName} configured status={await status} />
}
