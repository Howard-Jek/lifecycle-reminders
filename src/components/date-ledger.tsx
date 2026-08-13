import { cn } from "@/lib/utils"

/**
 * The signature element: a book of client dates, mostly quiet.
 *
 * Deliberately NOT a product screenshot or an abstract graphic. The honest
 * thesis of this product is that an agent's calendar is overwhelmingly boring —
 * hundreds of dates, three of which matter this week — and the engine's whole
 * job is picking those three out. So the hero shows the boring majority, muted,
 * with the signal marked in brand orange.
 *
 * Orange marks state, never action, which is the same rule the app follows.
 * The list is masked off at the bottom rather than ending, because it doesn't.
 */

type Row = {
  date: string
  name: string
  event: string
  /** Set when this row is inside its lead time — the reason it stands out. */
  lead?: string
}

/** Real shapes from the sample book: Chinese, Malay and Tamil names, the
 * insurers an SG agent actually deals with. Invented people, plausible book. */
const ROWS: Row[] = [
  { date: "11 Aug", name: "Chua Meng Huat", event: "Birthday" },
  { date: "12 Aug", name: "Ng Boon Keng", event: "Great Eastern · review" },
  { date: "14 Aug", name: "Nurul Aisyah Rahman", event: "Great Eastern · expiry", lead: "in 2 days" },
  { date: "15 Aug", name: "Lim Hui Ling", event: "Prudential · review" },
  { date: "17 Aug", name: "Ong Kai Xiang", event: "Income · expiry", lead: "in 5 days" },
  { date: "18 Aug", name: "Muhammad Faizal Osman", event: "Etiqa · expiry" },
  { date: "19 Aug", name: "Tan Wei Ming", event: "Birthday" },
  { date: "22 Aug", name: "Sharon Koh Mei Fen", event: "Tokio Marine · review" },
  { date: "26 Aug", name: "Goh Jia Hui", event: "HSBC Life · expiry" },
  { date: "28 Aug", name: "Ravi Chandran", event: "FWD · expiry" },
  { date: "03 Sep", name: "Yeo Su Ling", event: "China Taiping · expiry" },
  { date: "09 Sep", name: "Priya Devi Ramasamy", event: "Manulife · expiry" },
]

export function DateLedger() {
  return (
    <div className="relative">
      <div
        className="rounded-xl border bg-card/60 p-1.5 shadow-sm ring-1 ring-foreground/5 backdrop-blur"
        // Fades out rather than ending: the book does not stop at twelve.
        style={{
          maskImage: "linear-gradient(to bottom, black 78%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, black 78%, transparent 100%)",
        }}
      >
        <p className="flex items-center justify-between px-3 py-2 text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase">
          <span>Your book, this month</span>
          <span className="tabular-nums">212 dates</span>
        </p>

        <ol>
          {ROWS.map((row, i) => (
            <li
              key={row.name}
              // One orchestrated page-load rather than scattered effects. The
              // stagger runs top to bottom so the marked rows arrive last.
              className="ledger-row flex items-center gap-3 rounded-lg px-3 py-2"
              style={{ animationDelay: `${120 + i * 45}ms` }}
            >
              <span
                aria-hidden
                className={cn(
                  "h-7 w-[3px] shrink-0 rounded-full",
                  row.lead ? "bg-brand" : "bg-foreground/10",
                )}
              />
              <span
                className={cn(
                  "w-14 shrink-0 font-mono text-xs tabular-nums",
                  row.lead ? "text-foreground" : "text-muted-foreground/50",
                )}
              >
                {row.date}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-sm",
                    row.lead ? "font-medium text-foreground" : "text-muted-foreground/60",
                  )}
                >
                  {row.name}
                </span>
                <span
                  className={cn(
                    "block truncate text-xs",
                    row.lead ? "text-muted-foreground" : "text-muted-foreground/40",
                  )}
                >
                  {row.event}
                </span>
              </span>
              {row.lead && (
                <span className="shrink-0 rounded-full bg-brand/12 px-2 py-0.5 text-[0.7rem] font-medium text-brand-ink">
                  {row.lead}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-3 text-center text-sm text-muted-foreground sm:text-left">
        <span className="font-medium text-foreground">Two</span> of these need somebody this week.
        Lifecycle is the part that knows which two.
      </p>
    </div>
  )
}
