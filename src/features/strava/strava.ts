import * as Linking from 'expo-linking';

import type { StatusTone } from '@/components/ui/elements';

/**
 * Strava export (docs/ROADMAP.md 2.3) on the phone: where the service sends the runner back after
 * Strava's screen, and what each result means.
 */
export const STRAVA_RETURN_PATH = 'strava';

export const STRAVA_OUTCOME: Record<string, { tone: StatusTone; title: string }> = {
  connected: { tone: 'success', title: 'Strava is connected. Your next runs will be posted there.' },
  denied: { tone: 'warning', title: 'Strava wasn’t connected. You can connect it any time.' },
  scope: { tone: 'warning', title: 'Strava was connected without permission to upload. Connect again and leave “Upload your activities” ticked.' },
  athlete_in_use: { tone: 'danger', title: 'That Strava account is connected to another PaceLeague account.' },
  expired: { tone: 'warning', title: 'That took too long. Try connecting again.' },
  error: { tone: 'danger', title: 'Couldn’t connect to Strava. Try again in a moment.' },
};

/** The result the service put on the return URL ("…/strava?strava=connected"). */
export function stravaOutcome(url: string): keyof typeof STRAVA_OUTCOME {
  const value = Linking.parse(url).queryParams?.strava;
  return typeof value === 'string' && value in STRAVA_OUTCOME ? value : 'error';
}

export function stravaActivityUrl(activityId: string): string {
  return `https://www.strava.com/activities/${encodeURIComponent(activityId)}`;
}
