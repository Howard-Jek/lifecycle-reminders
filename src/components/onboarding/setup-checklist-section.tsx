import { Suspense } from "react"
import { getSetupSteps } from "@/app/actions/onboarding"
import { SetupChecklist } from "@/components/onboarding/setup-checklist"

/**
 * The setup checklist, off the critical path.
 *
 * getSetupSteps() asks META whether the message template is approved. That is a
 * network call to graph.facebook.com, memoised for five minutes and aborted at
 * three seconds — and it sat inside the page's blocking wave, so a cache miss
 * could hold the entire reminder inbox for up to three seconds behind a
 * question about a template.
 *
 * Streaming it means the inbox renders on its own schedule and the checklist
 * arrives when Meta answers.
 *
 * THE FALLBACK IS SIZED FROM THE SAME COOKIE the checklist uses to decide
 * whether it renders collapsed. An earlier attempt at streaming this component
 * used `fallback={null}`, reserved no space, and shoved the inbox down 415px
 * after first paint — on the page an operator opens every morning. Reserving
 * the height it is about to occupy is the whole difference between streaming
 * and jank.
 */
export function SetupChecklistSection({ collapsed }: { collapsed: boolean }) {
  return (
    <Suspense fallback={<ChecklistPlaceholder collapsed={collapsed} />}>
      <ChecklistData collapsed={collapsed} />
    </Suspense>
  )
}

async function ChecklistData({ collapsed }: { collapsed: boolean }) {
  const steps = await getSetupSteps()
  return <SetupChecklist steps={steps} defaultCollapsed={collapsed} />
}

/**
 * Same outer box, same height, no content. Not a skeleton with shimmering bars:
 * this resolves in well under a second in the common case, and a pulsing block
 * that appears and vanishes reads as a glitch rather than as loading.
 */
function ChecklistPlaceholder({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      aria-hidden
      className="rounded-xl border bg-background shadow-sm"
      // Matches the rendered card: header row plus, when expanded, four steps.
      style={{ height: collapsed ? 89 : 421 }}
    />
  )
}
