import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { Profile } from '@/api/schemas';
import { AppMessage } from '@/components/ui/app-states';
import { DangerButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { env } from '@/config/env';
import { space } from '@/design/tokens';

import { useAccount } from './account-provider';
import { checkAge, devicePort, needsAgeCopy, type AgeCheck, type AgePort } from './age-check';

type NeedsAge = Extract<AgeCheck, { outcome: 'needs_age' }>;

/**
 * Checks accounts created before the age check existed (or on another platform). It only prompts
 * where the platform confirms age rules apply, so runners elsewhere never see a sheet.
 */
export function useExistingAgeCheck(profile: Profile | null, port: AgePort = devicePort): { needsAge: NeedsAge | null; retry: () => void } {
  const { api } = useAccount();
  const queryClient = useQueryClient();
  const [needsAge, setNeedsAge] = useState<NeedsAge | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  const unchecked = profile !== null && profile.age_signal == null && profile.status === 'active' && port.platform !== 'web';

  useEffect(() => {
    if (!unchecked || !api || running.current) return;
    running.current = true;
    void (async () => {
      try {
        const check = await checkAge(port, 'existing');
        if (check.outcome === 'needs_age') {
          setNeedsAge(check);
          return;
        }
        setNeedsAge(null);
        const signal = check.outcome === 'minor' ? 'minor' : check.signal;
        await api.recordAgeSignal(signal, check.source);
        await queryClient.invalidateQueries();
      } catch {
        // Offline or a transient failure: try again on the next launch.
      } finally {
        running.current = false;
      }
    })();
  }, [unchecked, api, port, queryClient, attempt]);

  return { needsAge: unchecked ? needsAge : null, retry: () => setAttempt((n) => n + 1) };
}

/** A regulated region without an age answer: the runner shares their age range or signs out. */
export function AgeNeededScreen({ check, onRetry }: { check: NeedsAge; onRetry: () => void }) {
  const { signOut } = useAccount();
  const copy = needsAgeCopy(check.reason);
  return (
    <AppMessage title={copy.title} body={copy.body} actionLabel="Check again" onAction={onRetry}>
      <TextButton label="Sign out" onPress={() => void signOut()} />
    </AppMessage>
  );
}

/** The store reports the account holder as under 18: the account is locked (they can still delete it). */
export function AgeRestrictedScreen() {
  const { api, signOut } = useAccount();
  const [status, setStatus] = useState<{ tone: 'info' | 'danger'; title: string; body?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const requestDeletion = async () => {
    if (!api) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.requestAccountDeletion();
      setStatus({ tone: 'info', title: 'Your account is being deleted.', body: 'This finishes within 7 days. You can sign out now.' });
    } catch (e) {
      const code = toApiError(e).code;
      setStatus(
        code === 'recent_auth_required'
          ? { tone: 'info', title: 'Sign in again to delete.', body: 'For your security, sign out, sign back in, then tap Delete my account right away.' }
          : { tone: 'danger', title: 'Couldn’t request deletion. Try again.' },
      );
    } finally {
      setBusy(false);
    }
  };

  const contact = env.supportEmail ? ` If this is wrong, email ${env.supportEmail}.` : '';
  return (
    <AppMessage
      title="PaceLeague is for adults"
      body={`The App Store or Google Play says this account belongs to someone under 18, so we’ve paused it and removed it from its league.${contact}`}>
      <View style={{ gap: space.md }}>
        {status ? <InlineStatus tone={status.tone} title={status.title} body={status.body} /> : null}
        <DangerButton label="Delete my account" onPress={() => void requestDeletion()} loading={busy} testID="age-delete" />
        <TextButton label="Sign out" onPress={() => void signOut()} />
      </View>
    </AppMessage>
  );
}
