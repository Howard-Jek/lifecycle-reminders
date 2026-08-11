"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Copy the drafted opener.
 *
 * The reminder suggests; the agent decides. There is deliberately no "send to
 * client" anywhere in this product — copying into WhatsApp is the human step
 * that the whole design exists to preserve.
 */
export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          // Clipboard is permission-gated and can simply refuse. Say so rather
          // than showing a success state that did not happen.
          setCopied(false)
        }
      }}
    >
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  )
}
