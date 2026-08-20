import { describe, it, expect } from "vitest"
import { isSamePhoneNumber, phoneDigits } from "@/lib/phone-match"

/**
 * This decides which colleague a test message goes to. Too strict and a number
 * that IS on the roster is refused, which reads as a broken roster; too loose
 * and it messages the wrong person.
 */

describe("isSamePhoneNumber", () => {
  it("matches the same number written four different ways", () => {
    for (const typed of ["(951) 456-4663", "+1 951 456 4663", "951-456-4663", "1-951-456-4663"]) {
      expect(isSamePhoneNumber("+19514564663", typed)).toBe(true)
    }
  })

  it("matches when the caller omits their own country code", () => {
    // The case that sent this whole helper into existence: the roster stores
    // E.164, a person types the number the way they dial it.
    expect(isSamePhoneNumber("+19514564663", "9514564663")).toBe(true)
    expect(isSamePhoneNumber("+6591110022", "91110022")).toBe(true)
  })

  it("is symmetric", () => {
    expect(isSamePhoneNumber("9514564663", "+19514564663")).toBe(true)
    expect(isSamePhoneNumber("+19514564663", "9514564663")).toBe(true)
  })

  it("rejects two different numbers", () => {
    expect(isSamePhoneNumber("+6591110022", "+6592220033")).toBe(false)
    expect(isSamePhoneNumber("+19514564663", "+19514564664")).toBe(false)
  })

  it("refuses to suffix-match on too few digits", () => {
    // "4663" is a four-digit extension, not evidence of anything.
    expect(isSamePhoneNumber("+19514564663", "4663")).toBe(false)
    expect(isSamePhoneNumber("+19514564663", "564663")).toBe(false)
  })

  it("accepts a suffix at exactly the minimum length", () => {
    expect(isSamePhoneNumber("+19514564663", "4564663")).toBe(true)
  })

  it("does not match on a shared PREFIX", () => {
    // Numbers in one exchange share leading digits. Only the tail identifies
    // the line, which is why this is endsWith and not includes.
    expect(isSamePhoneNumber("+19514564663", "19514560000")).toBe(false)
  })

  it("treats empty and junk as no match rather than as a wildcard", () => {
    for (const junk of ["", "   ", "abc", null, undefined]) {
      expect(isSamePhoneNumber("+19514564663", junk)).toBe(false)
      expect(isSamePhoneNumber(junk, "+19514564663")).toBe(false)
    }
    // The one that would be catastrophic: two blanks matching each other and
    // selecting a roster row with no number on file.
    expect(isSamePhoneNumber("", "")).toBe(false)
    expect(isSamePhoneNumber(null, null)).toBe(false)
  })
})

describe("phoneDigits", () => {
  it("strips everything that is not a digit", () => {
    expect(phoneDigits("+65 9111-0022 ext.")).toBe("6591110022")
  })
  it("survives null and undefined", () => {
    expect(phoneDigits(null)).toBe("")
    expect(phoneDigits(undefined)).toBe("")
  })
})
