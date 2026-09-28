/**
 * Which week the recap shows (docs/ROADMAP.md 4.1): this week from Sunday, and the week before on
 * Monday and Tuesday while its results settle. Nothing midweek.
 */
export function recapWeek(now: Date): 0 | -1 | null {
  const day = now.getDay();
  if (day === 0) return 0;
  if (day === 1 || day === 2) return -1;
  return null;
}
