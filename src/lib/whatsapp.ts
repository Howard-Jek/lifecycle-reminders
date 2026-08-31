/**
 * The WhatsApp send-result contract.
 *
 * This add-on only ever sends one thing — an approved template, from the
 * platform number, to an agent — so the full adapter the host carries
 * (freeform text, interactive lists, per-tenant credential resolution,
 * Embedded Signup) has no caller here. Only the shared result type is kept,
 * at the host's own module path, so anything moved between the two repos
 * imports it from the same place.
 */
export type SendResult =
  | { ok: true; whatsappMessageId: string }
  | {
      ok: false
      error: string
      statusCode: number | null
      /**
       * Meta's own error code, kept apart from the message.
       *
       * It decides whether the failure may be retried, and the message is not a
       * reliable way back to it: Meta spells the same code "(#131047) …" in a
       * Graph response and "[131047] …" in a delivery receipt, and reserves the
       * right to reword either.
       */
      code: string | null
    }
