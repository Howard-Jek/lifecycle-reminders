"use client"

import { MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * The per-row actions in a table, behind one control.
 *
 * Three or four buttons laid out in a cell is what these tables did before,
 * and it failed twice over. It wrapped to a ragged second line at desktop
 * width, and at 375px the whole group sat outside the viewport with no way to
 * scroll to it — on Team and Settings the rows could be read on a phone but
 * not acted on.
 *
 * It also fixes an emphasis problem. `Delete` was the only filled control in
 * the row, so the loudest thing in a table of reminder rules was the one action
 * you least want taken by accident. In a menu every item carries the same
 * weight until it is opened, and destructive items are marked by colour at the
 * point of choosing rather than advertised from across the page.
 */

export type RowAction = {
  label: string
  onSelect: () => void
  /** Renders in the destructive colour, after a separator. */
  destructive?: boolean
  disabled?: boolean
}

export function RowActions({
  actions,
  label = "Actions",
}: {
  actions: RowAction[]
  /** Announced to screen readers — pass the row's subject, e.g. "Jasmine Tan". */
  label?: string
}) {
  const ordinary = actions.filter((a) => !a.destructive)
  const destructive = actions.filter((a) => a.destructive)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        {ordinary.map((action) => (
          <DropdownMenuItem
            key={action.label}
            disabled={action.disabled}
            onSelect={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}

        {destructive.length > 0 && ordinary.length > 0 && <DropdownMenuSeparator />}

        {destructive.map((action) => (
          <DropdownMenuItem
            key={action.label}
            variant="destructive"
            disabled={action.disabled}
            onSelect={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
