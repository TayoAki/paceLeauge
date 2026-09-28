import type { EffortKey } from '@/api/schemas';
import { formatDuration } from '@/domain/format';

/** Personal-record distances (docs/ROADMAP.md 1.4), in the order the server lists them. */
export const EFFORTS: { key: EffortKey; label: string; spoken: string }[] = [
  { key: '1k', label: '1K', spoken: '1 kilometer' },
  { key: '1mi', label: 'Mile', spoken: '1 mile' },
  { key: '5k', label: '5K', spoken: '5 kilometers' },
  { key: '10k', label: '10K', spoken: '10 kilometers' },
  { key: 'half', label: 'Half marathon', spoken: 'Half marathon' },
  { key: 'marathon', label: 'Marathon', spoken: 'Marathon' },
];

export function effortLabel(key: EffortKey): string {
  return EFFORTS.find((e) => e.key === key)?.label ?? key;
}

export function effortSpoken(key: EffortKey): string {
  return EFFORTS.find((e) => e.key === key)?.spoken ?? key;
}

/** Record times keep whole seconds: "24:10", "1:52:03". */
export function formatEffort(ms: number): string {
  return formatDuration(Math.round(ms / 1000) * 1000);
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
