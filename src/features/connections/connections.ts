import * as Linking from 'expo-linking';

import type { StatusTone } from '@/components/ui/elements';

/**
 * Connections on the phone (docs/ROADMAP.md 2.3 and 2.4): where the service or the aggregator sends
 * the runner back after connecting, and what each result means.
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

/** Garmin (docs/ROADMAP.md 2.4): the aggregator's widget sends the runner back here. */
export const GARMIN_RETURN_PATH = 'garmin';

export const GARMIN_OUTCOME: Record<string, { tone: StatusTone; title: string }> = {
  connected: { tone: 'success', title: 'Garmin is connected. Runs you record on your Garmin appear after it syncs with Garmin Connect.' },
  error: { tone: 'warning', title: 'Garmin wasn’t connected. You can try again any time.' },
};

export function garminOutcome(url: string): keyof typeof GARMIN_OUTCOME {
  const value = Linking.parse(url).queryParams?.garmin;
  return typeof value === 'string' && value in GARMIN_OUTCOME ? value : 'error';
}

export function stravaActivityUrl(activityId: string): string {
  return `https://www.strava.com/activities/${encodeURIComponent(activityId)}`;
}
