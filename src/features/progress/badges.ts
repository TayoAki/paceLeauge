import type { Badges } from '@/api/schemas';

/**
 * Badge catalog (docs/ROADMAP.md 1.8). The server decides what is earned (private.refresh_badges)
 * and takes a badge back if the run behind it is deleted; this file only names them and shows
 * progress toward the next ones. Badges never award XP.
 */
export type BadgeGroup = 'Runs' | 'Distance' | 'Firsts' | 'Tiers' | 'Streaks';

export interface BadgeInfo {
  code: string;
  group: BadgeGroup;
  title: string;
  description: string;
  /** Progress toward the badge from the runner's totals, when it is a count. */
  progress?: (p: Badges['progress']) => { value: number; target: number };
}

const runs = (target: number) => (p: Badges['progress']) => ({ value: p.accepted_runs, target });
const km = (target: number) => (p: Badges['progress']) => ({ value: Math.floor(p.distance_m / 1000), target });
const xp = (target: number) => (p: Badges['progress']) => ({ value: p.lifetime_xp, target });
const weeks = (target: number) => (p: Badges['progress']) => ({ value: p.streak.best_weeks, target });

export const BADGES: BadgeInfo[] = [
  { code: 'first_run', group: 'Runs', title: 'First run', description: 'Your first run that counted.', progress: runs(1) },
  { code: 'runs_10', group: 'Runs', title: '10 runs', description: 'Ten runs that counted.', progress: runs(10) },
  { code: 'runs_50', group: 'Runs', title: '50 runs', description: 'Fifty runs that counted.', progress: runs(50) },
  { code: 'runs_100', group: 'Runs', title: '100 runs', description: 'A hundred runs that counted.', progress: runs(100) },
  { code: 'runs_250', group: 'Runs', title: '250 runs', description: 'Two hundred and fifty runs.', progress: runs(250) },
  { code: 'distance_100k', group: 'Distance', title: '100 km', description: '100 km run in total.', progress: km(100) },
  { code: 'distance_500k', group: 'Distance', title: '500 km', description: '500 km run in total.', progress: km(500) },
  { code: 'distance_1000k', group: 'Distance', title: '1,000 km', description: '1,000 km run in total.', progress: km(1000) },
  { code: 'distance_5000k', group: 'Distance', title: '5,000 km', description: '5,000 km run in total.', progress: km(5000) },
  { code: 'first_5k', group: 'Firsts', title: 'First 5K', description: 'Ran 5 km in one run.' },
  { code: 'first_10k', group: 'Firsts', title: 'First 10K', description: 'Ran 10 km in one run.' },
  { code: 'first_half', group: 'Firsts', title: 'First half marathon', description: 'Ran 21.1 km in one run.' },
  { code: 'first_marathon', group: 'Firsts', title: 'First marathon', description: 'Ran 42.2 km in one run.' },
  { code: 'tier_stride', group: 'Tiers', title: 'Stride', description: 'Reached the Stride tier (500 XP).', progress: xp(500) },
  { code: 'tier_tempo', group: 'Tiers', title: 'Tempo', description: 'Reached the Tempo tier (1,500 XP).', progress: xp(1500) },
  { code: 'tier_surge', group: 'Tiers', title: 'Surge', description: 'Reached the Surge tier (4,000 XP).', progress: xp(4000) },
  { code: 'tier_elite', group: 'Tiers', title: 'Elite', description: 'Reached the Elite tier (10,000 XP).', progress: xp(10000) },
  { code: 'streak_4', group: 'Streaks', title: '4-week streak', description: 'Met your weekly goal 4 weeks in a row.', progress: weeks(4) },
  { code: 'streak_12', group: 'Streaks', title: '12-week streak', description: 'Met your weekly goal 12 weeks in a row.', progress: weeks(12) },
  { code: 'streak_26', group: 'Streaks', title: '26-week streak', description: 'Half a year of weekly goals in a row.', progress: weeks(26) },
  { code: 'streak_52', group: 'Streaks', title: '52-week streak', description: 'A whole year of weekly goals in a row.', progress: weeks(52) },
];

export const BADGE_GROUPS: BadgeGroup[] = ['Runs', 'Distance', 'Firsts', 'Tiers', 'Streaks'];

export interface BadgeView extends BadgeInfo {
  earnedAtMs: number | null;
  /** 0…1 toward the badge; null when there is no count to show. */
  fraction: number | null;
  progressLabel: string | null;
}

export function badgeViews(data: Badges): BadgeView[] {
  const earned = new Map(data.earned.map((b) => [b.badge, b.earned_at_ms]));
  return BADGES.map((info) => {
    const earnedAtMs = earned.get(info.code) ?? null;
    const p = info.progress?.(data.progress) ?? null;
    return {
      ...info,
      earnedAtMs,
      fraction: earnedAtMs !== null ? 1 : p ? Math.min(1, p.value / p.target) : null,
      progressLabel: earnedAtMs === null && p ? `${Math.min(p.value, p.target).toLocaleString('en-US')} of ${p.target.toLocaleString('en-US')}` : null,
    };
  });
}
