import { describe, it, expect } from "vitest"
import { extractContactEvents } from "@/lib/lifecycle/extract-events"
import { matchTeamMember, matchMembersForRows, normalizeName } from "@/lib/lifecycle/match-member"
import type { TeamMember } from "@/lib/lifecycle/types"
import type { EventColumn } from "@/lib/types"

const HEADERS = ["Name", "Phone", "DOB", "Policy Expiry", "Servicing FA"]
const EVENT_COLS: EventColumn[] = [
  { header: "DOB", event_type: "birthday", recurrence: "yearly", label: null },
  { header: "Policy Expiry", event_type: "policy_expiry", recurrence: "none", label: null },
]

function member(over: Partial<TeamMember> & { id: string }): TeamMember {
  return {
    business_id: "u1",
    display_name: "Agent",
    email: null,
    whatsapp_number: "+6591110000",
    role: "agent",
    auth_user_id: null,
    active: true,
    created_at: "",
    updated_at: "",
    ...over,
  }
}

describe("extractContactEvents", () => {
  const rows = [
    ["Jane Tan", "+6591234567", "1990-03-14", "2027-01-31", "Jasmine Tan"],
    ["Bob Lim", "+6598765432", "1985-12-01", "", "Jasmine Tan"],
  ]
  const phones = new Map([
    [0, "+6591234567"],
    [1, "+6598765432"],
  ])

  it("extracts one event per populated event cell", () => {
    const { events } = extractContactEvents({
      headers: HEADERS,
      rows,
      eventColumns: EVENT_COLS,
      dateFormat: "YYYY-MM-DD",
      phoneByRowIndex: phones,
    })
    expect(events).toHaveLength(3) // Jane: 2, Bob: 1 (blank expiry skipped)
    expect(events[0]).toMatchObject({
      phone: "+6591234567",
      event_type: "birthday",
      event_date: "1990-03-14",
      recurrence: "yearly",
      source: "import",
    })
  })

  it("keeps the calendar date, not a UTC-shifted one", () => {
    // safeParseDate's ISO output would render 1990-03-14 local as 1990-03-13Z
    // in any positive-offset zone. A birthday off by a day is the whole bug.
    const { events } = extractContactEvents({
      headers: HEADERS,
      rows: [["Jane", "+6591234567", "14/03/1990", "", ""]],
      eventColumns: EVENT_COLS,
      dateFormat: "DD/MM/YYYY",
      phoneByRowIndex: new Map([[0, "+6591234567"]]),
    })
    expect(events[0].event_date).toBe("1990-03-14")
  })

  it("skips rows whose phone failed sanitisation", () => {
    // An event with no contact is unreachable, so it must not be created.
    const { events } = extractContactEvents({
      headers: HEADERS,
      rows,
      eventColumns: EVENT_COLS,
      dateFormat: "YYYY-MM-DD",
      phoneByRowIndex: new Map([[0, "+6591234567"]]),
    })
    expect(events.every((e) => e.phone === "+6591234567")).toBe(true)
  })

  it("reports unparseable dates instead of dropping them silently", () => {
    const { events, unparsed } = extractContactEvents({
      headers: HEADERS,
      rows: [["Jane", "+6591234567", "not a date", "", ""]],
      eventColumns: EVENT_COLS,
      dateFormat: "YYYY-MM-DD",
      phoneByRowIndex: new Map([[0, "+6591234567"]]),
    })
    expect(events).toHaveLength(0)
    expect(unparsed).toEqual([{ rowNumber: 2, header: "DOB", value: "not a date" }])
  })

  it("reports a repeated bad format once, not once per row", () => {
    const { unparsed } = extractContactEvents({
      headers: HEADERS,
      rows: Array.from({ length: 200 }, () => ["X", "+6591234567", "TBC", "", ""]),
      eventColumns: EVENT_COLS,
      dateFormat: "YYYY-MM-DD",
      phoneByRowIndex: new Map(Array.from({ length: 200 }, (_, i) => [i, `+65900000${i}`])),
    })
    expect(unparsed).toHaveLength(1)
  })

  it("ignores a configured column that is no longer in the sheet", () => {
    const { events } = extractContactEvents({
      headers: ["Name", "Phone"],
      rows: [["Jane", "+6591234567"]],
      eventColumns: EVENT_COLS,
      dateFormat: null,
      phoneByRowIndex: new Map([[0, "+6591234567"]]),
    })
    expect(events).toEqual([])
  })

  it("does nothing when no event columns are configured", () => {
    const { events, unparsed } = extractContactEvents({
      headers: HEADERS,
      rows,
      eventColumns: [],
      dateFormat: "YYYY-MM-DD",
      phoneByRowIndex: phones,
    })
    expect(events).toEqual([])
    expect(unparsed).toEqual([])
  })
})

describe("matchTeamMember", () => {
  const jas = member({ id: "m1", display_name: "Jasmine Tan", email: "jas@co.com", whatsapp_number: "+6591234567" })
  const bob = member({ id: "m2", display_name: "Bob Lim", email: "bob@co.com", whatsapp_number: "+6598887777" })

  it("matches on exact email", () => {
    expect(matchTeamMember("JAS@co.com", [jas, bob])).toEqual({
      status: "matched", memberId: "m1", matchedOn: "email",
    })
  })

  it("matches on phone regardless of formatting or country code", () => {
    for (const v of ["+65 9123 4567", "6591234567", "91234567"]) {
      expect(matchTeamMember(v, [jas, bob]), v).toMatchObject({ status: "matched", memberId: "m1" })
    }
  })

  it("matches on name, ignoring case, punctuation and honorifics", () => {
    for (const v of ["Jasmine Tan", "jasmine  tan", "Ms. Jasmine Tan"]) {
      expect(matchTeamMember(v, [jas, bob]), v).toMatchObject({ status: "matched", memberId: "m1" })
    }
  })

  it("treats a blank cell as unassigned, not as something to review", () => {
    // Not every client has an agent yet; that isn't a decision for the operator.
    for (const v of ["", "   ", undefined, null]) {
      expect(matchTeamMember(v, [jas, bob])).toEqual({ status: "unassigned" })
    }
  })

  it("NEVER guesses on an unknown name", () => {
    const r = matchTeamMember("Someone Else", [jas, bob])
    expect(r).toMatchObject({ status: "needs_review", reason: "no_match" })
  })

  it("refuses to pick between two agents with the same name", () => {
    const twin = member({ id: "m3", display_name: "Jasmine Tan", whatsapp_number: "+6590001111" })
    const r = matchTeamMember("Jasmine Tan", [jas, twin])
    expect(r).toMatchObject({ status: "needs_review", reason: "ambiguous" })
    if (r.status === "needs_review") expect(r.candidates.sort()).toEqual(["m1", "m3"])
  })

  it("ignores inactive members", () => {
    const gone = member({ id: "m9", display_name: "Gone Agent", active: false })
    expect(matchTeamMember("Gone Agent", [jas, gone])).toMatchObject({ status: "needs_review" })
  })

  it("needs review when the team list is empty", () => {
    expect(matchTeamMember("Jasmine Tan", [])).toMatchObject({ status: "needs_review" })
  })

  it("normalizeName is stable", () => {
    expect(normalizeName("Ms. Jasmine  Tan!")).toBe("jasmine tan")
  })
})

describe("matchMembersForRows", () => {
  const jas = member({ id: "m1", display_name: "Jasmine Tan" })

  it("assigns matches and queues only the genuinely ambiguous rows", () => {
    const { assignmentByPhone, review } = matchMembersForRows(
      [
        { rowNumber: 2, phone: "+6591111111", agentValue: "Jasmine Tan" },
        { rowNumber: 3, phone: "+6592222222", agentValue: "" },
        { rowNumber: 4, phone: "+6593333333", agentValue: "Who Dis" },
      ],
      [jas],
    )
    expect(assignmentByPhone.get("+6591111111")).toBe("m1")
    // Blank and unmatched both end up unassigned...
    expect(assignmentByPhone.get("+6592222222")).toBeNull()
    expect(assignmentByPhone.get("+6593333333")).toBeNull()
    // ...but only the unmatched one needs a human decision.
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({ rowNumber: 4, agentValue: "Who Dis", reason: "no_match" })
  })
})
