import { DELIVERY_STAGES, type DeliveryState } from "@/lib/lifecycle/delivery-state"
import { describeWhatsappError } from "@/lib/whatsapp-errors"
import { cn } from "@/lib/utils"

/**
 * What Meta said happened to one message.
 *
 * Sits under a reminder row and answers the question the status pill cannot:
 * "sent" is our record of handing it over, and says nothing about whether it
 * arrived or whether anybody read it. Those are Meta's to report, and it does.
 *
 * A stage that is not lit is UNKNOWN rather than false. Meta does not promise
 * a `read` receipt — the recipient's privacy settings can suppress it — so a
 * message can genuinely be delivered and read while this shows only
 * "delivered". The tooltip says so rather than letting a dim third step read
 * as "they ignored you".
 */
export function DeliveryTrail({
  state,
  errorCode,
  error,
  className,
}: {
  state: DeliveryState | undefined
  /** From the reminder row, which is what the webhook wrote there. */
  errorCode?: string | null
  error?: string | null
  className?: string
}) {
  const failure = state?.failure ?? (error ? { code: errorCode ?? null, detail: error, at: null } : null)

  // Nothing from Meta and nothing on the row: the message has not been handed
  // over yet. Saying "not sent" would be a claim; saying nothing is accurate.
  if (!state && !failure) return null

  const reached = state?.stage ? DELIVERY_STAGES.indexOf(state.stage) : -1
  const info = failure ? describeWhatsappError(failure.code, failure.detail) : null

  return (
    <div className={cn("mt-2 space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {DELIVERY_STAGES.map((stage, i) => {
          const lit = i <= reached
          return (
            <span key={stage} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="text-muted-foreground/40">→</span>}
              <span
                className={cn(
                  lit ? "text-muted-foreground" : "text-muted-foreground/40",
                  lit && i === reached && "font-medium text-foreground",
                )}
                title={
                  lit
                    ? state?.at && i === reached
                      ? `Meta reported "${stage}" at ${new Date(state.at).toLocaleString()}`
                      : `Meta reported "${stage}"`
                    : `Meta has not reported "${stage}". It may still happen — a read receipt is suppressed entirely if the recipient turns them off.`
                }
              >
                {stage}
              </span>
            </span>
          )
        })}
        {failure && (
          <span className="ml-1 rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
            failed{failure.code ? ` · ${failure.code}` : ""}
          </span>
        )}
      </div>

      {failure && info && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
          {/* Only when a code was actually recognised — this list also holds
              failures that never reached WhatsApp, and captioning one of those
              with "check the recipient's number" is confidently wrong. */}
          {info.matched && (
            <>
              <p className="text-xs font-medium">{info.title}</p>
              <p className="mt-1 text-xs leading-relaxed">{info.action}</p>
            </>
          )}
          <p
            className={cn(
              "text-xs break-words",
              // Dimmed only when there is guidance above it to be secondary to.
              info.matched && "mt-2 text-[11px] opacity-70",
            )}
          >
            {failure.detail}
          </p>
        </div>
      )}
    </div>
  )
}
