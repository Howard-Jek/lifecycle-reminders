"use client"

/**
 * An inline jargon-buster: a term with a dotted underline that reveals a short
 * definition when clicked.
 *
 * Click, not hover, on purpose — a hover tooltip is unreachable on touch, and
 * these definitions are a few sentences somebody has to actually read.
 */

import * as React from "react"
import { Popover } from "@base-ui/react/popover"
import { cn } from "@/lib/utils"

export interface InfoTipProps {
  /** The term as it reads in the sentence. Omit to render just the info mark. */
  label?: string
  /** Heading inside the popup. Defaults to `label`. */
  title?: string
  /**
   * Other names for the same thing. Meta renamed these concepts more than once
   * and its own screens disagree, which is most of why people get lost.
   */
  aliases?: string[]
  /** The explanation. Keep it to a few sentences. */
  children: React.ReactNode
  className?: string
}

export function InfoTip({ label, title, aliases, children, className }: InfoTipProps) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          // `inline`, not inline-flex: the term must wrap with the sentence
          // around it. Alignment utilities would be inert at this display.
          "inline rounded-sm text-left font-medium text-foreground",
          "underline decoration-dotted decoration-from-font underline-offset-[3px]",
          "transition-colors hover:text-brand-ink hover:decoration-brand",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "data-popup-open:text-brand-ink",
          className,
        )}
        aria-label={label ? `${label} — what's this?` : "What's this?"}
      >
        {label}
        {/* Non-breaking: the mark must never wrap onto a line of its own. */}
        {label ? " " : null}
        <span
          aria-hidden
          className="inline-flex size-[15px] translate-y-[2px] items-center justify-center rounded-full bg-brand/20 text-[10px] font-bold leading-none text-brand-ink no-underline"
        >
          ?
        </span>
      </Popover.Trigger>

      <Popover.Portal>
        {/* Above the dialog, which sits at z-50. */}
        <Popover.Positioner side="top" sideOffset={8} collisionPadding={12} className="z-[60]">
          <Popover.Popup
            className={cn(
              "max-w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-card p-4 shadow-lg",
              "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150",
              "data-open:scale-100 data-open:opacity-100 data-closed:scale-95 data-closed:opacity-0",
              "motion-reduce:transition-none",
            )}
          >
            <Popover.Arrow className="data-[side=bottom]:top-[-6px] data-[side=top]:bottom-[-6px]">
              <span className="block size-3 rotate-45 border-b border-r border-border bg-card" />
            </Popover.Arrow>

            {(title ?? label) && (
              <p className="text-sm font-semibold text-foreground">{title ?? label}</p>
            )}
            <div className="mt-1.5 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              {children}
            </div>

            {aliases && aliases.length > 0 && (
              <p className="mt-3 border-t border-border pt-2.5 text-[12px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Meta also calls this: </span>
                {aliases.join(", ")}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
