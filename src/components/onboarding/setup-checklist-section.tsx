import { cookies } from "next/headers"
import { getSetupSteps } from "@/app/actions/onboarding"
import { CHECKLIST_COLLAPSED_COOKIE } from "@/lib/onboarding/steps"
import { SetupChecklist } from "./setup-checklist"

/**
 * Loads the checklist's data.
 *
 * Separate from the page so the data-fetching sits next to the component it
 * feeds rather than in the middle of the inbox's own queries. It is awaited
 * inline: putting it behind Suspense moved the card out of the first paint and
 * traded a fast page for a page that visibly jumps. See the call site.
 *
 * The cookie is read here rather than in the client component because
 * localStorage does not exist during a server render: reading it after
 * hydration means the first paint is always the expanded list, which then snaps
 * shut for anyone who had collapsed it.
 */
export async function SetupChecklistSection() {
  const [steps, cookieStore] = await Promise.all([getSetupSteps(), cookies()])

  return (
    <SetupChecklist
      steps={steps}
      defaultCollapsed={cookieStore.get(CHECKLIST_COLLAPSED_COOKIE)?.value === "1"}
    />
  )
}
