/**
 * Reading the sending number's DISPLAY NAME state.
 *
 * Split from `fetchPhoneNumberStatus` so the interpretation is testable
 * without a network call. The fetch is one Graph GET; deciding what its five
 * fields mean together is the part that actually goes wrong.
 *
 * The display name fails INDEPENDENTLY of registration, and silently. Meta
 * restricts sending on a declined name while every Graph call goes on
 * returning a message id, so nothing at send time points here.
 *
 * The awkward part is that a resubmission is invisible in the obvious field.
 * Meta keeps the OLD name in `verified_name` and leaves `name_status` at
 * DECLINED until a replacement is approved — so a number whose new name is
 * under review reports character-for-character what it reported before the
 * submission. `new_name_status` is the only field that tells the two apart,
 * which is why it is read FIRST here rather than as a footnote.
 */

/** Matches the pill tones the settings page already renders. */
export type NameTone = "good" | "waiting" | "bad"

export type NameVerdict = {
  tone: NameTone
  headline: string
  detail: string
  /**
   * Whether re-registering the number could plausibly change this.
   *
   * Almost always false, and that is the point: registration and name review
   * are different queues at Meta. Re-registering a number whose name was
   * declined succeeds, reports 200, and changes nothing about the name — an
   * expensive way to learn that, given wrong PINs are rate-limited.
   */
  registrationHelps: boolean
}

export type NameInput = {
  verifiedName: string | null
  nameStatus: string | null
  newNameStatus: string | null
}

export function describeNumberName({
  verifiedName,
  nameStatus,
  newNameStatus,
}: NameInput): NameVerdict {
  const current = verifiedName?.trim()
  const named = current ? `“${current}”` : "the current name"

  // new_name_status FIRST. While a replacement is pending, name_status still
  // reads DECLINED by definition, so checking it first would report a
  // submission that landed as a fresh rejection and send someone to resubmit
  // a name Meta is already reviewing.
  if (newNameStatus === "PENDING_REVIEW") {
    return {
      tone: "waiting",
      headline: "New name in review",
      detail:
        `Meta has the replacement and has not ruled on it. Until it does, the number keeps ` +
        `reporting ${named} as its verified name with the old DECLINED result — that is ` +
        `expected and does not mean the submission failed. This line is the one to watch, ` +
        `not the name above. Reviews usually settle within a day or two.`,
      registrationHelps: false,
    }
  }

  if (newNameStatus === "DECLINED") {
    return {
      tone: "bad",
      headline: "New name declined too",
      detail:
        `Meta rejected the replacement as well, so the number is still on ${named}. Re-registering ` +
        `will not move this — name review is a separate queue and does not look at registration. ` +
        `A name is normally refused for not matching the business's real-world identity: it has to ` +
        `match the legal or verifiable trading name, and generic or descriptive words tend to fail. ` +
        `The next submission goes through WhatsApp Manager → Phone numbers → the number → Edit ` +
        `display name.`,
      registrationHelps: false,
    }
  }

  switch (nameStatus) {
    case "APPROVED":
    case "AVAILABLE_WITHOUT_REVIEW":
      return {
        tone: "good",
        headline: "Name approved",
        detail: `Meta accepts ${named}, so the display name is not restricting sending.`,
        registrationHelps: false,
      }

    case "PENDING_REVIEW":
      return {
        tone: "waiting",
        headline: "Name in review",
        detail:
          `Meta is still reviewing ${named}. Sending can be restricted until it rules, and there ` +
          `is nothing to do but wait — no button here changes a review.`,
        registrationHelps: false,
      }

    case "DECLINED":
      return {
        tone: "bad",
        headline: "Name declined",
        detail:
          `Meta rejected ${named} and no replacement has been submitted — if one was sent, this ` +
          `would read “New name in review” instead. Submit a new name in WhatsApp Manager → Phone ` +
          `numbers → the number → Edit display name. Re-registering does not help: registration ` +
          `and name review are separate queues at Meta.`,
        registrationHelps: false,
      }

    case "EXPIRED":
      return {
        tone: "bad",
        headline: "Name expired",
        detail: `Meta expired ${named}. It has to be submitted again before sending is unrestricted.`,
        registrationHelps: false,
      }

    case "NONE":
    case null:
      return {
        tone: "waiting",
        headline: "No name on file",
        detail:
          `Meta reports no display name for this number. Set one in WhatsApp Manager before ` +
          `relying on sends.`,
        registrationHelps: false,
      }

    default:
      // Meta adds states without warning. Showing the raw value beats mapping
      // an unknown one onto a tone that claims more than we know.
      return {
        tone: "waiting",
        headline: `Name status: ${nameStatus}`,
        detail:
          `Meta reported a display-name state this build does not recognise. The raw value is ` +
          `shown so it can be looked up rather than guessed at.`,
        registrationHelps: false,
      }
  }
}

/**
 * Whether the number is registered for Cloud API sends — the OTHER half, and
 * the one re-registration actually addresses.
 *
 * Deliberately not folded into the name verdict. "#133010 Account not
 * registered" and a declined display name are different faults with different
 * fixes, and the single "is it working?" boolean that used to cover both is
 * what made this take an afternoon.
 */
export function describeRegistration(input: {
  status: string | null
  platformType: string | null
}): { tone: NameTone; headline: string; detail: string; registrationHelps: boolean } {
  const { status, platformType } = input

  if (status === "CONNECTED" && platformType === "CLOUD_API") {
    return {
      tone: "good",
      headline: "Registered",
      detail: "CONNECTED on the Cloud API. Registration is not what is blocking a send.",
      registrationHelps: false,
    }
  }

  // NOT_APPLICABLE is Meta's value for "not registered", not for "some other
  // platform" — so it must fall through to the #133010 branch below rather
  // than be reported as a platform mismatch. Reading it as a platform costs
  // the operator the one error code that is worth searching for.
  if (platformType && platformType !== "CLOUD_API" && platformType !== "NOT_APPLICABLE") {
    return {
      tone: "bad",
      headline: `On ${platformType}`,
      detail:
        `The number reports platform ${platformType}, not CLOUD_API — an on-premise number reads ` +
        `CONNECTED and still fails every Cloud API send. Registering it here moves it onto the ` +
        `Cloud API, which is the platform this app sends through.`,
      registrationHelps: true,
    }
  }

  return {
    tone: "bad",
    headline: status ? `Not registered (${status})` : "Not registered",
    detail:
      "Not registered for the Cloud API, so every send fails #133010 regardless of the display " +
      "name. This is the one thing the button below fixes — it needs the number's six-digit " +
      "two-step PIN.",
    registrationHelps: true,
  }
}
