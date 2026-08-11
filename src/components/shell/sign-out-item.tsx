"use client"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { signOut } from "@/app/actions/auth"

export function SignOutMenuItem() {
  return (
    <DropdownMenuItem
      variant="destructive"
      onSelect={() => {
        void signOut()
      }}
    >
      Sign out
    </DropdownMenuItem>
  )
}
