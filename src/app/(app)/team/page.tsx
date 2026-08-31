import { listTeamMembers, listCalendarFeedStatus } from "@/app/actions/team-members"
import { isDryRun } from "@/lib/env"
import { TeamClient } from "./team-client"

export const metadata = { title: "Team" }

export const dynamic = "force-dynamic"

export default async function TeamPage() {
  const [members, feeds] = await Promise.all([listTeamMembers(), listCalendarFeedStatus()])
  // Env, not a query — read here because the test-send panel has to say whether
  // clicking it will actually spend anything before the operator clicks it.
  return <TeamClient members={members} feeds={feeds} dryRun={isDryRun()} />
}
