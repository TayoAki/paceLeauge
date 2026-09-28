import { Radio, Send, XCircle } from 'lucide-react-native';
import { useState, useSyncExternalStore } from 'react';
import { Share } from 'react-native';

import { toApiError } from '@/api/errors';
import { DangerButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus } from '@/components/ui/elements';
import { Sheet } from '@/components/ui/sheet';
import { env } from '@/config/env';
import { LIVE_DURATIONS_MIN, liveLink, type LiveShareController } from '@/features/live-share/live-share';
import { Text } from '@/design/text';

function durationLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`;
}

/** The message sent with the link: what it is, and that it stops. */
export function liveMessage(url: string): string {
  return `Follow my run live on PaceLeague: ${url}\nIt shows where I am until I finish.`;
}

/**
 * Share live location for this run (docs/ROADMAP.md 4.8): a link for the people the runner
 * picks, that stops when the run ends or after the time chosen. Free, because it's for safety.
 */
export function LiveShareSheet({ controller, visible, onClose }: { controller: LiveShareController; visible: boolean; onClose: () => void }) {
  const current = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [minutes, setMinutes] = useState<number>(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (token: string) => {
    await Share.share({ message: liveMessage(liveLink(env.webUrl, token)) }).catch(() => undefined);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await controller.share(minutes);
      await send(link.token);
    } catch (e) {
      const code = toApiError(e).code;
      setError(
        (e instanceof Error && e.message === 'offline') || code === 'network' || code === 'timeout'
          ? 'Live location needs a connection. Try again when you have signal.'
          : code === 'rate_limited'
            ? 'That’s a lot of links today. Try again tomorrow.'
            : 'Couldn’t start sharing. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    await controller.stop('stopped').catch(() => undefined);
    setBusy(false);
  };

  const until = current ? new Date(current.expiresAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <Sheet visible={visible} onClose={onClose} title={current ? 'Sharing your location' : 'Share your live location'} busy={busy}>
      {current ? (
        <>
          <Text variant="body" tone="secondary">
            Anyone with the link sees where you are, updated about every 30 seconds. It stops when you finish this run, or at {until}.
          </Text>
          <SecondaryButton label="Send the link again" icon={Send} onPress={() => void send(current.token)} />
          <DangerButton label="Stop sharing" icon={XCircle} onPress={() => void stop()} loading={busy} testID="live-stop" />
        </>
      ) : (
        <>
          <Text variant="body" tone="secondary">
            Send a link to people you choose, so they can see where you are on this run. It stops when you finish, or after the time below. Nobody else can find it,
            and it’s free.
          </Text>
          <Text variant="labelStrong">Stop sharing after</Text>
          <ChoiceChips
            label="Stop sharing after"
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={LIVE_DURATIONS_MIN.map((m) => ({ value: String(m), label: durationLabel(m) }))}
          />
          <PrimaryButton label="Create link and share" icon={Radio} onPress={() => void start()} loading={busy} testID="live-start" />
        </>
      )}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <TextButton label="Done" onPress={onClose} />
    </Sheet>
  );
}
