import * as Application from 'expo-application';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { CloudUpload, FileUp, LifeBuoy, RefreshCw } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { SavedRun } from '@/db/journal';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDistance } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useLocalRuns, useMe, useSyncStatus } from '@/features/data/hooks';
import { fileImportCopy, importActivityFile } from '@/features/files/file-import';
import type { ImportState } from '@/features/health/health-import';
import { syncErrorCopy } from '@/features/recording/reason-copy';
import { diagnosticsReport } from '@/features/sync/diagnostics';
import { HEALTH } from '@/features/health/health-names';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const SOURCE_LABEL: Record<string, string> = {
  phone_gps: 'This phone',
  health_import: HEALTH.name,
  file_import: 'File',
  indoor: 'Indoor',
  watch: 'Apple Watch',
  garmin: 'Garmin',
};

function stateLabel(run: SavedRun): string {
  switch (run.syncState) {
    case 'pending':
      return run.syncError ? 'Waiting to retry' : 'On this phone';
    case 'uploading':
      return 'Uploading';
    case 'awaiting_validation':
      return 'Checking';
    case 'needs_attention':
      return 'Needs attention';
    default:
      return 'Synced';
  }
}

function ago(ms: number | null): string {
  if (ms === null) return 'never';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

async function readPicked(asset: DocumentPicker.DocumentPickerAsset): Promise<Uint8Array> {
  if (Platform.OS === 'web') return new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
  return new Uint8Array(await new File(asset.uri).arrayBuffer());
}

/** Imports and sync (docs/ROADMAP.md 2.4, 2.6 and Part A): what hasn't synced and why, file import, diagnostics. */
export default function SyncScreen() {
  const { runtime, engine, actions, api } = useAccountServices();
  const local = useLocalRuns();
  const status = useSyncStatus();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const [note, setNote] = useState<{ tone: 'info' | 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<null | 'file' | 'sync' | 'diag' | 'health'>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const healthOn = runtime.runSettings.get().healthImport && runtime.healthImport.available;

  useEffect(() => {
    void runtime.healthImport.state().then(setImportState);
  }, [runtime, busy]);

  const unsynced = local.filter((r) => !r.deleted && r.syncState !== 'synced');

  const importFile = async () => {
    setNote(null);
    const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets[0]) return;
    setBusy('file');
    try {
      const asset = picked.assets[0];
      const result = await importActivityFile(runtime.journal, { name: asset.name, bytes: await readPicked(asset) });
      if (result.kind === 'error') setNote({ tone: 'danger', text: fileImportCopy(result.reason) });
      else if (result.kind === 'already_imported') setNote({ tone: 'info', text: 'That file is already in your log.' });
      else {
        const d = formatDistance(result.distanceM, units);
        setNote({
          tone: 'success',
          text: `Imported ${d.value} ${d.unit} from a ${result.parsed.format.toUpperCase()} file. It’s kept as history and syncs now.`,
        });
        void engine?.run();
      }
    } catch {
      setNote({ tone: 'danger', text: 'That file couldn’t be read.' });
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    await engine?.run().catch(() => undefined);
    setBusy(null);
  };

  const checkHealth = async () => {
    setBusy('health');
    const added = await runtime.healthImport.importNew().catch(() => 0);
    setNote({ tone: 'info', text: added > 0 ? `Added ${added} from ${HEALTH.name}.` : `Nothing new in ${HEALTH.name}.` });
    setBusy(null);
  };

  const sendDiagnostics = async () => {
    if (!api) return;
    setBusy('diag');
    try {
      const report = diagnosticsReport({
        appVersion: Application.nativeApplicationVersion,
        build: Application.nativeBuildVersion,
        platform: Platform.OS,
        osVersion: Platform.Version ?? null,
        status,
        runs: local,
        outbox: await runtime.journal.openOutbox(),
        healthImport: importState ? { enabled: healthOn, lastRunAtMs: importState.lastRunAtMs, lastImported: importState.lastImported } : null,
        now: Date.now(),
      });
      const { reportId } = await api.submitDiagnostics(report);
      setNote({ tone: 'success', text: `Sent. If you contact support, mention report ${reportId}.` });
    } catch (e) {
      const code = toApiError(e).code;
      setNote({ tone: 'danger', text: code === 'rate_limited' ? 'You’ve sent a few already today. Try again tomorrow.' : 'Couldn’t send. Check your connection.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Imports and sync" />
      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Sync
        </Text>
        <Text variant="body" tone="secondary">
          {status?.authBlocked
            ? 'Sign in again to sync.'
            : unsynced.length === 0
              ? `Everything is synced. Last sync ${ago(status?.lastSyncedAt ?? null)}.`
              : `${unsynced.length} ${unsynced.length === 1 ? 'run is' : 'runs are'} still on this phone. Last sync ${ago(status?.lastSyncedAt ?? null)}.`}
        </Text>
        <SecondaryButton label="Sync now" icon={RefreshCw} onPress={() => void syncNow()} loading={busy === 'sync'} />
      </Card>

      {unsynced.length > 0 ? (
        <Card>
          {unsynced.map((r) => (
            <View key={r.runId} style={styles.run} accessible={r.syncState !== 'needs_attention'}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {r.title}
                </Text>
                <Text variant="caption" tone="secondary">
                  {SOURCE_LABEL[r.origin?.source ?? 'phone_gps']} · {stateLabel(r)}
                </Text>
                {r.syncError ? (
                  <Text variant="caption" tone={r.syncState === 'needs_attention' ? 'danger' : 'secondary'}>
                    {syncErrorCopy[r.syncError] ?? `Error: ${r.syncError}`}
                  </Text>
                ) : null}
              </View>
              {r.syncState === 'needs_attention' && actions ? <TextButton label="Try again" onPress={() => void actions.retry(r.runId)} /> : null}
            </View>
          ))}
        </Card>
      ) : (
        <EmptyState icon={CloudUpload} title="Nothing waiting." body="Runs you record or import appear here until they reach PaceLeague." />
      )}

      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Import
        </Text>
        <Text variant="body" tone="secondary">
          Add a GPX, TCX or FIT file from another app or watch. Files are kept as history: they count for your goals, not league XP.
        </Text>
        <SecondaryButton label="Import a file" icon={FileUp} onPress={() => void importFile()} loading={busy === 'file'} testID="import-file" />
        {runtime.healthImport.available ? (
          <>
            <Text variant="caption" tone="secondary">
              {HEALTH.name}: {healthOn ? `on · checked ${ago(importState?.lastRunAtMs ?? null)}` : 'off (turn it on in Run settings)'}
            </Text>
            {healthOn ? <TextButton label={`Check ${HEALTH.name} now`} onPress={() => void checkHealth()} disabled={busy === 'health'} /> : null}
          </>
        ) : null}
      </Card>

      {note ? <InlineStatus tone={note.tone} title={note.text} /> : null}

      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Help
        </Text>
        <Text variant="body" tone="secondary">
          Send support a report of what’s waiting and why. It has no locations, routes, titles or notes.
        </Text>
        <SecondaryButton label="Send diagnostics" icon={LifeBuoy} onPress={() => void sendDiagnostics()} loading={busy === 'diag'} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  run: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
});
