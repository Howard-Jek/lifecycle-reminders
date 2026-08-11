/**
 * Escape a string for safe interpolation into the XML-shaped prompts the AI
 * paths build (scoring prompt, reply prompt, guardrails block). Conservative:
 * escapes the five predefined XML entities so lead-authored or operator-authored
 * text can never break out of an attribute or element.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
