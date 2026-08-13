# Design brief — Lifecycle

**Subject.** A temporal-trigger engine for insurance agencies. It reads dates that are already
in the operator's spreadsheet, works out which ones deserve a conversation, and WhatsApps the
agent who owns that client with a draft opener.

**Audience.** Two, and they never meet in the UI:
- The *principal / ops lead* — sets it up once, on a laptop, and then mostly ignores it. Every
  screen in this app is theirs.
- The *agent* — never signs in. Their entire experience of the product is one WhatsApp message.

**Emotional target: administrative calm.** This software sends messages, on a real business's
behalf, about real clients. The feeling to produce is a well-kept ledger — precise, quiet,
unsurprising. Confidence here comes from restraint, not from energy. Nothing on screen should
imply the machine is being clever; the product's entire pitch is that it *isn't* guessing.

**Stack.** Next.js 16 App Router · Tailwind v4 (CSS-first, no config file) · shadcn `base-nova`
on `@base-ui/react` · `@radix-ui/react-dropdown-menu`.

## Constraints — these are law, not preferences

The design system is GomaAI's, copied verbatim. This project is a standalone add-on that must
fold back into that app, so **divergence is a defect**, not a variation.

- **Black DOES, orange IS.** `--primary` (near-black, the same value as `--foreground`) is for
  things you act on — buttons above all. `--brand` (`#d96d3a`) is for things that are simply
  true: a status, a switch that is on, the focus ring, a link. Orange never lands on a button.
- Anything *read* as text uses `--brand-ink`, the darkened variant. `--brand` at 12px fails
  contrast against a tint of itself.
- **Status is a tinted wash, never a saturated fill**: `bg-<hue>-500/10 text-<hue>-700`, per
  `REMINDER_STATUS_PILL` in `src/lib/types.ts`.
- **No toast system.** Feedback is an inline block: `rounded-lg bg-destructive/10 px-3 py-2
  text-sm text-destructive`.
- `Button` has no `asChild` — use `buttonVariants()` + `<Link>`, or an inline class string in
  server components (`buttonVariants` lives in a `"use client"` module).
- One radius scale, derived from `--radius: 0.625rem`. Cards `rounded-xl`, controls `rounded-lg`.
- Numerals are always `tabular-nums`.
- Shell: sticky `h-14` header, `bg-background/95 backdrop-blur`, page background `bg-muted/30`,
  content `mx-auto max-w-7xl px-4 py-6 sm:px-6`.
- Fonts: DM Sans (sans + headings), Geist Mono. Loaded via `next/font/google`.
- Dark mode is in scope on every screen — `.dark` class, set by an inline boot script.

## Scope of this pass

Explicitly **polish, not redesign** (user's words: "avoid making it too different from what
Goma AI is doing"). Two deliverables:

1. **A first-run onboarding wizard** — teach the mental model, then show what is left to set up.
2. **Targeted polish** — fix defects found by touring the live app, and tighten the places
   where the app is inconsistent with itself.

Anything that would fork the visual language is out of scope. Anything that changes a token is
out of scope. When a choice is arguable, the tie goes to whatever keeps the diff smallest at
integration time.

## How the UI is verified

`~/.claude/skills/ui-craft/scripts/ui_audit.js` is injected into every route at 375 / 768 /
1280, in both colour schemes, and must report **zero errors**. It needs a browser with real
layout metrics — the in-app preview pane reports a 0×0 viewport when backgrounded, which makes
every measurement worthless while screenshots still look correct, so drive it with Playwright.

Two classes of finding are known false positives. Re-deriving them each time wastes an hour:

1. **Content inside a scroll container.** The audit reads `getBoundingClientRect`, which is
   layout position, not paint. Anything scrolled out of view still reports a rect where it was
   laid out, so it appears to overlap whatever sits below the container. The sandbox transcript
   is marked `data-allow-overlap` for exactly this and nothing else.
2. **Base UI focus guards.** `data-base-ui-focus-guard` sentinels are 1×1px and tabbable, so
   they read as undersized tap targets whenever a dialog is open. They are `aria-hidden` and
   inert, and are rendered by the library, not by this codebase.

The audit's own blind spots, both found the hard way, both by measuring rather than by looking:

- It compares element positions to the **viewport**, so a control pushed outside an
  `overflow-x-auto` *container* — a wide table inside a card — passes while being invisible and
  unreachable in practice. Check scroll containers separately. Note that the shared `TableCell`
  sets `whitespace-nowrap`, which is usually what makes a table exceed its container.
- `data-allow-overlap` exempts an element **and all its descendants**. It is on the tour's
  `DialogContent`, so overlap checking is off *inside* the app's only dialog. That is a real
  cost, accepted knowingly: without it every page reports the modal overlapping the page it
  covers, which is noise that buries genuine findings. Check the dialog's internals by hand.

Neither blind spot is theoretical. A clipped primary button inside that dialog at 375px, and an
unreachable actions menu on Settings, both passed a clean audit.

## The one idea the onboarding has to land

**The reminder goes to the agent, never to the client.** Every operator arrives assuming this
is an auto-messaging tool, because every other tool in this category is. If they leave the
wizard still believing that, they will either not trust it or misuse it. Everything else the
wizard says is secondary to this.
