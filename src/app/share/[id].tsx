import { useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { ShieldCheck, Upload } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { SharePoster, type PosterFormat } from '@/components/share/share-poster';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, SegmentedControl } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { describeDistance, describeDuration, describePace } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useLocalRun, useMe, useServerRun } from '@/features/data/hooks';
import { serverRunOf } from '@/features/sync/sync-engine';
import { canSaveToPhotos, saveImageToPhotos } from '@/lib/photo-library';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

/** S13 — preview a stats-only image, then hand it to the system share sheet. */
export default function ShareScreen() {
  const { id, source } = useLocalSearchParams<{ id: string; source?: string }>();
  const { runtime } = useAccountServices();
  const local = useLocalRun(source === 'server' ? null : (id ?? null));
  const remote = useServerRun(source === 'server' ? (id ?? null) : null);
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const { width } = useWindowDimensions();
  const poster = useRef<View>(null);
  const [format, setFormat] = useState<PosterFormat>('post');
  const [status, setStatus] = useState<{ tone: 'info' | 'danger' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<'share' | 'save' | null>(null);

  const server = local ? serverRunOf(local) : (remote.data?.data ?? null);
  const stats = local || server ? { distanceM: server?.distance_m ?? local?.distanceM ?? 0, activeMs: server?.active_ms ?? local?.activeMs ?? 0, units } : null;
  const posterWidth = Math.min(width - layout.screenPadding * 2, 420) * (format === 'story' ? 0.72 : 1);

  const render = async (): Promise<string> => captureRef(poster, { format: 'png', quality: 1, result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile' });

  const share = async () => {
    setBusy('share');
    setStatus(null);
    try {
      const uri = await render();
      runtime.telemetry.track('share_sheet_opened', { format: format === 'post' ? 'post_4x5' : 'story_9x16' });
      if (Platform.OS === 'web') {
        const a = document.createElement('a');
        a.href = uri;
        a.download = 'paceleague-run.png';
        a.click();
      } else if (await Sharing.isAvailableAsync()) {
        // The runner chooses the destination; closing the sheet posts nothing.
        await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share run' });
      } else {
        setStatus({ tone: 'danger', text: 'Sharing isn’t available on this device.' });
      }
    } catch {
      setStatus({ tone: 'danger', text: 'Couldn’t create the image. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setStatus(null);
    try {
      if (await saveImageToPhotos(await render())) setStatus({ tone: 'success', text: 'Saved to Photos.' });
      else setStatus({ tone: 'info', text: 'Photo access is off. You can still use Share image.' });
    } catch {
      setStatus({ tone: 'danger', text: 'Couldn’t save the image. Try Share image instead.' });
    } finally {
      setBusy(null);
    }
  };

  const summary = stats
    ? `Share image preview: One more good run. ${describeDistance(stats.distanceM, units)}, ${describeDuration(stats.activeMs)}, ${describePace(
        stats.activeMs,
        stats.distanceM,
        units,
      )}. PaceLeague. Contains no route or location.`
    : 'Loading run';

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <>
          <PrimaryButton label="Share image" icon={Upload} onPress={share} loading={busy === 'share'} disabled={!stats || busy === 'save'} testID="share-image" />
          {!canSaveToPhotos ? null : <TextButton label="Save image" tone="primary" onPress={save} disabled={!stats || busy !== null} />}
        </>
      }>
      <NavHeader title="Share run" variant="close" />
      <SegmentedControl
        label="Image format"
        value={format}
        onChange={setFormat}
        options={[
          { value: 'post', label: 'Post 4:5' },
          { value: 'story', label: 'Story 9:16' },
        ]}
      />
      <View style={styles.center} accessible accessibilityRole="image" accessibilityLabel={summary}>
        {stats ? <SharePoster ref={poster} stats={stats} format={format} width={posterWidth} /> : null}
      </View>
      <View style={styles.caption}>
        <ShieldCheck size={18} color={colors.textSecondary} />
        <Text variant="label" tone="secondary">
          Stats only. No route or location.
        </Text>
      </View>
      {status ? <InlineStatus tone={status.tone === 'success' ? 'success' : status.tone} title={status.text} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  caption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
});
