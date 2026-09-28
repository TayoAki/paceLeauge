import type { Profile } from '@/api/schemas';
import type { Visibility } from '@/api/social-schemas';
import { useMe } from '@/features/data/hooks';

/**
 * Teen accounts (docs/ROADMAP.md 4.10): 13–17 year olds in a family league an adult runs. The
 * server enforces what a teen can reach; the app only leaves out what they can't use.
 */
export interface TeenInfo {
  isTeen: boolean;
  /** 13–15: no heart rate or health data either. */
  underSixteen: boolean;
}

export function teenInfo(signal: Profile['age_signal'] | undefined): TeenInfo {
  const isTeen = signal === 'teen_13_15' || signal === 'teen_16_17';
  return { isTeen, underSixteen: signal === 'teen_13_15' };
}

export function useTeen(): TeenInfo {
  return teenInfo(useMe().data?.data.profile?.age_signal);
}

const ALL: Visibility[] = ['only_me', 'leagues', 'followers', 'everyone'];

/** Who a run can be shared with: a teen's runs go to their family league at most. */
export function visibilityChoices(isTeen: boolean): Visibility[] {
  return isTeen ? ['only_me', 'leagues'] : ALL;
}
