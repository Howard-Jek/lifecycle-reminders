import { setDevVertical } from "@/lib/dev/vertical-switch"
import { INDUSTRY_OPTIONS } from "@/lib/lifecycle/verticals"

/**
 * Switch which industry's reminder pack the app is showing, locally.
 *
 * DELETED AT INTEGRATION together with src/lib/dev/. See that module for why
 * this is not an operator feature.
 *
 * Placed beside ThemeToggle rather than in NAV. NAV is consumed twice — the
 * desktop map and <MobileNav items={NAV}> — and both expect {href, label}, so a
 * non-link entry would make MobileNav grow a case for a control it will never
 * ship with. Here it is one insertion point and visible at both size classes.
 *
 * A plain <form> with a submit-on-change select, so it works before hydration
 * and needs no client component: this is a development affordance and should
 * not put a kilobyte of JavaScript on every page to earn its keep.
 */
export function VerticalSwitcher({ current }: { current: string | null }) {
  return (
    <form
      action={async (formData: FormData) => {
        "use server"
        await setDevVertical(String(formData.get("vertical") ?? ""))
      }}
      className="hidden items-center gap-1.5 sm:flex"
    >
      <span
        className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-700 uppercase dark:text-amber-400"
        title="Local only — never rendered in production"
      >
        dev
      </span>
      <select
        name="vertical"
        aria-label="Preview another industry's reminder pack"
        /**
         * Keyed on the server's value so the node REMOUNTS when the override
         * changes. `defaultValue` is uncontrolled: React sets it once and never
         * touches the DOM value again, so after the action re-rendered the page
         * the dropdown kept whatever was last picked in it while the labels
         * underneath had moved on — the control disagreeing with the thing it
         * controls, in the one component whose job is to say which pack you are
         * looking at.
         */
        key={current ?? "none"}
        defaultValue={current ?? ""}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <option value="">Business industry</option>
        {INDUSTRY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="h-7 rounded-md border border-input px-2 text-xs hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        Switch
      </button>
    </form>
  )
}
