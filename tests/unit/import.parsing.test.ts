import { describe, it, expect } from "vitest"
import {
  guessHeaders,
  eventTypeFromHeader,
  detectFormatForColumn,
} from "@/lib/import/read-file"
import {
  normalizePhone,
  parseCalendarDate,
  detectDayMonthOrder,
  titleCaseName,
  isPlaceholder,
} from "@/lib/sanitize"

const INSURANCE_HEADERS = [
  "Client Name",
  "Mobile No",
  "Email Address",
  "Servicing FA",
  "DOB",
  "Policy Expiry Date",
  "Premium",
]

describe("guessHeaders", () => {
  it("finds the four mapped columns in a realistic insurance export", () => {
    const guess = guessHeaders(INSURANCE_HEADERS)
    expect(guess.name).toBe("Client Name")
    expect(guess.phone).toBe("Mobile No")
    expect(guess.email).toBe("Email Address")
    expect(guess.agent).toBe("Servicing FA")
  })

  it("does not claim a mapped column as a date column too", () => {
    // "Policy Expiry Date" matches the date patterns; "Servicing FA" must not
    // reappear as an event just because it was claimed as the agent column.
    const guess = guessHeaders(INSURANCE_HEADERS)
    expect(guess.dateColumns).toContain("Policy Expiry Date")
    expect(guess.dateColumns).toContain("DOB")
    expect(guess.dateColumns).not.toContain("Servicing FA")
  })

  it("returns nulls rather than picking something wrong", () => {
    const guess = guessHeaders(["Col1", "Col2"])
    expect(guess).toEqual({ name: null, phone: null, email: null, agent: null, dateColumns: [] })
  })
})

describe("eventTypeFromHeader", () => {
  it("keeps the aliases that are true in every vertical", () => {
    expect(eventTypeFromHeader("DOB")).toBe("birthday")
    expect(eventTypeFromHeader("Date of Birth")).toBe("birthday")
    expect(eventTypeFromHeader("Work Anniversary")).toBe("anniversary")
  })

  it("drops a trailing 'date' so one idea is not two event types", () => {
    expect(eventTypeFromHeader("Policy Expiry Date")).toBe("policy_expiry")
    expect(eventTypeFromHeader("Policy Expiry")).toBe("policy_expiry")
  })

  it("does NOT coerce another vertical's column into an insurance one", () => {
    // The regression: /expir/ used to map straight to "policy_expiry", which
    // turned a visa into a policy. event_type is free text by design.
    expect(eventTypeFromHeader("Visa Expiry")).toBe("visa_expiry")
    expect(eventTypeFromHeader("Warranty  End")).toBe("warranty_end")
    expect(eventTypeFromHeader("MOT Due")).toBe("mot_due")
  })
})

describe("detectDayMonthOrder", () => {
  it("uses a day over 12 to prove the column is day-first", () => {
    expect(detectDayMonthOrder(["31/12/2026", "01/02/2026"])).toBe("DD/MM/YYYY")
  })

  it("uses a second field over 12 to prove it is month-first", () => {
    expect(detectDayMonthOrder(["12/31/2026", "02/01/2026"])).toBe("MM/DD/YYYY")
  })

  it("refuses when every value is under the 13th — the operator must decide", () => {
    // This is the whole point: guessing here moves real dates, silently.
    expect(detectDayMonthOrder(["01/02/2026", "03/04/2026"])).toBeNull()
  })

  it("refuses when the column mixes both conventions", () => {
    expect(detectDayMonthOrder(["31/12/2026", "12/31/2026"])).toBeNull()
  })
})

describe("detectFormatForColumn", () => {
  const rows = (values: string[]) => values.map((v) => ({ Expiry: v }))

  it("recognises an ISO column and needs no decision", () => {
    const result = detectFormatForColumn(rows(["2026-12-31", "2027-01-01"]), "Expiry")
    expect(result).toEqual({ format: "YYYY-MM-DD", ambiguous: false })
  })

  it("resolves a day-first column from its own data", () => {
    const result = detectFormatForColumn(rows(["31/12/2026", "05/06/2026"]), "Expiry")
    expect(result).toEqual({ format: "DD/MM/YYYY", ambiguous: false })
  })

  it("flags a genuinely ambiguous column instead of picking", () => {
    const result = detectFormatForColumn(rows(["01/02/2026", "03/04/2026"]), "Expiry")
    expect(result).toEqual({ format: null, ambiguous: true })
  })

  it("is not ambiguous when the column is empty", () => {
    expect(detectFormatForColumn(rows(["", "  "]), "Expiry")).toEqual({
      format: null,
      ambiguous: false,
    })
  })
})

describe("normalizePhone", () => {
  it("keeps a well-formed E.164 number unchanged", () => {
    expect(normalizePhone("+6591234567", "+65").phone).toBe("+6591234567")
  })

  it("completes a local number with the country code", () => {
    expect(normalizePhone("9123 4567", "+65").phone).toBe("+6591234567")
  })

  it("strips a trunk prefix before prepending", () => {
    expect(normalizePhone("07911123456", "+44").phone).toBe("+447911123456")
  })

  it("does not double the country code when the cell already has it", () => {
    expect(normalizePhone("6591234567", "+65").phone).toBe("+6591234567")
  })

  it("converts a 00 international prefix", () => {
    expect(normalizePhone("006591234567", "+65").phone).toBe("+6591234567")
  })

  it("rejects with a reason rather than throwing", () => {
    const result = normalizePhone("12", "+65")
    expect(result.phone).toBeNull()
    expect(result.reason).toMatch(/short/i)
  })

  it("treats a placeholder as empty, not as a number", () => {
    expect(normalizePhone("N/A", "+65").phone).toBeNull()
    expect(normalizePhone("-", "+65").phone).toBeNull()
  })
})

describe("parseCalendarDate", () => {
  it("keeps the calendar day, never shifting it through UTC", () => {
    // The whole reason this does not route through toISOString(): a date read
    // as local midnight in Asia/Singapore comes back a day earlier in UTC.
    expect(parseCalendarDate("31/12/2026", "DD/MM/YYYY")).toBe("2026-12-31")
    expect(parseCalendarDate("01/01/2026", "DD/MM/YYYY")).toBe("2026-01-01")
  })

  it("honours the confirmed format over the fallback cascade", () => {
    expect(parseCalendarDate("01/02/2026", "DD/MM/YYYY")).toBe("2026-02-01")
    expect(parseCalendarDate("01/02/2026", "MM/DD/YYYY")).toBe("2026-01-02")
  })

  it("falls back through known formats when none is given", () => {
    expect(parseCalendarDate("2026-12-31", null)).toBe("2026-12-31")
    expect(parseCalendarDate("31 Dec 2026", null)).toBe("2026-12-31")
  })

  it("returns null for an unreadable cell rather than a wrong date", () => {
    expect(parseCalendarDate("sometime next year", null)).toBeNull()
    expect(parseCalendarDate("", null)).toBeNull()
    expect(parseCalendarDate("TBC", null)).toBeNull()
  })
})

describe("titleCaseName / isPlaceholder", () => {
  it("collapses whitespace and title-cases", () => {
    expect(titleCaseName("  jasmine   TAN ")).toBe("Jasmine Tan")
  })

  it("treats CRM placeholder values as no name at all", () => {
    expect(isPlaceholder("N/A")).toBe(true)
    expect(isPlaceholder("unknown")).toBe(true)
    expect(titleCaseName("n/a")).toBeNull()
    expect(isPlaceholder("Jasmine")).toBe(false)
  })
})
