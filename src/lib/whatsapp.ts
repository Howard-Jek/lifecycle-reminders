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
  | { ok: false; error: string; statusCode: number | null }
