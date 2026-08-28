/**
 * The predicates behind the reminder inbox tabs.
 *
 * Here rather than in the page because two things have to agree about them and
 * only one of them is the page: the list query and the badge count are built
 * separately, and a tab reading 85 that opens on 12 rows is worse than no badge
 * at all. The test suite is the third reader, and a constant it copies is a
 * constant it cannot actually guard.
 */

/**
 * What "Needs attention" means.
 *
 * Three states, not one:
 *   failed   — tried and gave up.
 *   skipped  — never tried and never will: a deleted contact, no number on file.
 *   queued with an attempt behind it — mid-retry. It went wrong, it is coming
 *              back, and it belongs in front of somebody in the meantime.
 *
 * That third clause is why Due filters on `attempts = 0`. Without the pair,
 * a retrying row would sit in Due looking like untried work, carrying an error
 * nobody had a reason to open.
 */
export const ATTENTION_FILTER =
  "status.in.(failed,skipped),and(status.eq.queued,attempts.gt.0)"
