/**
 * How many reminders one manual press may deliver.
 *
 * Its own module because the server enforces it and the confirmation dialog
 * promises it. Two copies would eventually disagree, and the operator would be
 * told "sending 40" by a button that sends 20 — on the screen whose whole job
 * is to state what a click will cost before it costs it.
 *
 * The number is set by wall-clock, not by taste: each delivery is a model call
 * plus a Graph call, and a server action that holds the page for minutes reads
 * as a hung deployment. That is not hypothetical here — it is exactly how an
 * unbounded button was reported.
 */
export const MAX_PER_CLICK = 20
