/**
 * What is left to set up, derived from what is actually in the database.
 *
 * Deliberately NOT a stored "onboarding_step" column. A stored cursor drifts
 * from reality the moment anybody does something out of order — deletes their
 * last rule, or imports before adding the team — and then the checklist lies.
 * Reading the state back each time costs four counts and can never disagree
 * with the app.
 *
 * The consequence worth knowing: a step can go from done back to todo. That is
 * correct. Deleting your only active rule really does mean nothing will fire.
 */

/**
 * Where the checklist's collapsed state is kept.
 *
 * Declared in this module — which is neither client nor server — rather than
 * beside the component that writes it, and that is load-bearing. A server
 * component importing a plain constant from a `"use client"` module does not
 * get the constant: Next replaces the whole module with a client-reference
 * proxy, so the value arrives as an object. `cookies().get(<proxy>)` then
 * quietly returns undefined and the checklist renders expanded every time,
 * with no error anywhere to say why.
 */
export const CHECKLIST_COLLAPSED_COOKIE = "lifecycle_checklist_collapsed"

/** What the app can see about this business right now. */
export type SetupState = {
  /** Active roster entries — who a client can belong to. */
  activeMembers: number
  /** Whether an active `owner` exists. Unassigned reminders fall back to them. */
  hasOwner: boolean
  contacts: number
  /** Rows in `contact_events` — a contact with no dates schedules nothing. */
  dates: number
  activeRules: number
  whatsapp: {
    /** All three GOMA_NOTIFY_* variables are present. */
    configured: boolean
    /** Meta's review state for `client_event_reminder`, or null if unknown. */
    templateState: string | null
  }
  /** `REMINDER_DRY_RUN` is on — everything runs, nothing reaches Meta. */
  dryRun: boolean
}

/**
 * `waiting` is its own state, not a flavour of `todo`.
 *
 * Meta's template review takes hours and sometimes days, and there is no
 * button the operator can press to speed it up. Rendering that as an unticked
 * to-do makes a finished setup look permanently unfinished, and a checklist
 * that can never be completed is one the operator stops reading.
 */
export type StepStatus = "done" | "todo" | "waiting"

export type SetupStep = {
  id: "team" | "contacts" | "rules" | "whatsapp"
  title: string
  /** Why this step exists, in the operator's terms — not what to click. */
  body: string
  status: StepStatus
  /** Where the work happens. Omitted when there is nothing to press. */
  href?: string
  cta?: string
  /** Shown under the title once the step is done or waiting. */
  detail?: string
}

export function buildSetupSteps(state: SetupState): SetupStep[] {
  const team: SetupStep = state.activeMembers === 0
    ? {
        id: "team",
        title: "Add your team",
        body:
          "Reminders go to a person, so the engine needs a roster before it can " +
          "attribute anybody. Names and WhatsApp numbers are enough.",
        status: "todo",
        href: "/team",
        cta: "Add your first member",
      }
    : !state.hasOwner
      ? {
          id: "team",
          title: "Mark somebody the owner",
          body:
            "A client whose agent could not be matched has to go somewhere. " +
            "Without an owner those reminders have no recipient at all.",
          status: "todo",
          href: "/team",
          cta: "Set an owner",
        }
      : {
          id: "team",
          title: "Add your team",
          body: "Reminders go to a person, so the engine needs a roster to attribute against.",
          status: "done",
          detail: `${state.activeMembers} ${state.activeMembers === 1 ? "member" : "members"}, one of them the owner`,
        }

  // Contacts and dates are one step on purpose: contacts without dates is a
  // half-finished import that looks complete on the Contacts page and produces
  // nothing, which is exactly the confusion this checklist exists to prevent.
  const contacts: SetupStep =
    state.contacts === 0
      ? {
          id: "contacts",
          title: "Import your clients",
          body:
            "Upload the spreadsheet you already keep. Nothing is written until " +
            "you have confirmed how its columns map.",
          status: "todo",
          href: "/import",
          cta: "Import a spreadsheet",
        }
      : state.dates === 0
        ? {
            id: "contacts",
            title: "Import the dates too",
            body:
              `${state.contacts} ${state.contacts === 1 ? "contact is" : "contacts are"} in, ` +
              "but none of them carry a date — so there is nothing to watch for. Re-import " +
              "with the birthday or expiry columns mapped.",
            status: "todo",
            href: "/import",
            cta: "Import again",
          }
        : {
            id: "contacts",
            title: "Import your clients",
            body: "The dates already in your spreadsheet are what the engine watches.",
            status: "done",
            detail: `${state.contacts} ${state.contacts === 1 ? "contact" : "contacts"} · ${state.dates} ${state.dates === 1 ? "date" : "dates"}`,
          }

  const rules: SetupStep =
    state.activeRules === 0
      ? {
          id: "rules",
          title: "Say when you want to know",
          body:
            "A rule is how far ahead of a date you want telling — a month before " +
            "a policy expires, a week before a birthday. They are rows, not code.",
          status: "todo",
          href: "/settings",
          cta: "Add a rule",
        }
      : {
          id: "rules",
          title: "Say when you want to know",
          body: "How far ahead of each kind of date you want telling.",
          status: "done",
          detail: `${state.activeRules} active ${state.activeRules === 1 ? "rule" : "rules"}`,
        }

  return [team, contacts, rules, whatsappStep(state)]
}

function whatsappStep(state: SetupState): SetupStep {
  const base = {
    id: "whatsapp" as const,
    title: "Connect WhatsApp",
    body:
      "Reminders are delivered from one number you own. Meta requires an " +
      "approved template for any message that starts a conversation.",
  }

  if (!state.whatsapp.configured) {
    return { ...base, status: "todo", href: "/settings", cta: "Set it up" }
  }

  switch (state.whatsapp.templateState) {
    case "APPROVED":
      // Approved but still dry-running is a real, easy-to-miss state: every
      // stage runs and the reminder is marked sent, but nothing leaves.
      return state.dryRun
        ? {
            ...base,
            status: "waiting",
            detail: "Template approved — but dry run is still on, so nothing leaves the building.",
            href: "/settings",
            cta: "Turn dry run off",
          }
        : { ...base, status: "done", detail: "Approved and delivering." }
    case "PENDING":
      return {
        ...base,
        status: "waiting",
        detail: "Submitted. Meta usually answers within the hour, sometimes longer.",
      }
    case "REJECTED":
      return {
        ...base,
        status: "todo",
        href: "/settings",
        cta: "See why it was rejected",
        detail: "Meta rejected the template.",
      }
    default:
      return {
        ...base,
        status: "todo",
        href: "/settings",
        cta: "Submit the template",
        detail: "The number is connected. The template still needs submitting.",
      }
  }
}

/**
 * A step still asks something of the operator if it offers them something to
 * press.
 *
 * The distinction is not `status`, which is what an earlier version of this got
 * wrong. `waiting` covers two different situations: one where nothing can be
 * done but wait (Meta reviewing the template — no `cta`), and one where the
 * operator's own switch is still in the wrong position (approved, but dry run
 * left on — `cta: "Turn dry run off"`). Keying completion off `status !==
 * "todo"` hid the checklist in the second case, which is the single easiest
 * state in the product to miss: every stage runs, every reminder is marked
 * sent, and nothing leaves the building.
 */
function isActionable(step: SetupStep): boolean {
  return step.status === "todo" || Boolean(step.cta)
}

/** True when there is nothing left for the operator to do themselves. */
export function isSetupComplete(steps: SetupStep[]): boolean {
  return !steps.some(isActionable)
}

/**
 * One line for the collapsed checklist.
 *
 * Only ever a count, because the checklist only exists while the count is above
 * zero — `isSetupComplete` unmounts it otherwise. An earlier version also
 * carried "waiting on Meta" and "Setup complete" strings; both were unreachable
 * by construction, and the operator who is genuinely waiting on Meta reads that
 * on Settings, where the status is fetched fresh.
 */
export function describeSetup(steps: SetupStep[]): string {
  const outstanding = steps.filter(isActionable).length
  return `${outstanding} of ${steps.length} steps left`
}
