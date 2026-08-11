import { listTeamMembers, listCalendarFeedStatus } from "@/app/actions/team-members"
import { TeamClient } from "./team-client"

export const dynamic = "force-dynamic"

export default async function TeamPage() {
  const [members, feeds] = await Promise.all([listTeamMembers(), listCalendarFeedStatus()])
  return <TeamClient members={members} feeds={feeds} />
}
