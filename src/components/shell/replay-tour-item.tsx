"use client"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useReplayTour } from "@/components/onboarding/welcome-tour"

/**
 * Puts the welcome tour back.
 *
 * Lives in the account menu rather than in Help, because there is no Help — and
 * because the person who wants it again is usually showing the product to a
 * colleague, which is an account-shaped errand.
 */
export function ReplayTourItem() {
  const replay = useReplayTour()

  return (
    <DropdownMenuItem
      onSelect={() => {
        replay()
      }}
    >
      Show the welcome tour
    </DropdownMenuItem>
  )
}
