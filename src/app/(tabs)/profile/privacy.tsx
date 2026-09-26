import { useRouter } from 'expo-router';
import { Bell, ChevronDown, ChevronUp, Download, Info, KeyRound, MapPinned, Route, Share, ShieldCheck, Trash2, Users } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { DangerButton, PrimaryButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { env } from '@/config/env';
import { useAccount } from '@/features/account/account-provider';
import { useAuth } from '@/features/account/auth-provider';
import {
  clearExportFiles,
  describeExportError,
  prepareExport,
  progressLabel,
  shareExportFile,
  type ExportProgress,
  type SavedExportFile,
} from '@/features/privacy/export-data';
import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

type ExportState =
  | { status: 'idle' }
  | { status: 'working'; progress: ExportProgress }
  | { status: 'reauth' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; files: SavedExportFile[] };

const DATA_HANDLING = [
  'Your runs, routes and scores are stored in the cloud so they sync and stay safe. That data is processed by the operator of PaceLeague and its service providers under access controls. It isn’t end-to-end encrypted.',
  'Your league sees your runner name, tier and weekly XP — never your routes or your email.',
  'Run summaries and routes stay until you delete them or delete your account.',
  'Deleting your account hides you from your league right away and removes your primary data within 7 days.',
  'App analytics never include your routes, locations, email or run titles.',
];

function runDate(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** S15 — route visibility, notifications, export and account deletion. */
export default function PrivacyScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const auth = useAuth();
  const canChangePassword = env.emailSignIn === 'password' && auth.status === 'signed_in' && !!auth.email;
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' });
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mounted = useRef(true);

  // Exported files contain private routes: remove them from the phone when leaving.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearExportFiles();
    };
  }, []);

  const working = exportState.status === 'working';

  const share = async (file: SavedExportFile) => {
    setShareNotice(null);
    try {
      if ((await shareExportFile(file)) === 'unavailable') setShareNotice('Sharing isn’t available on this device.');
    } catch {
      setShareNotice('Couldn’t open the share sheet. Try again.');
    }
  };

  const startExport = async () => {
    if (!api || working) return;
    setShareNotice(null);
    setExportState({ status: 'working', progress: { stage: 'requesting' } });
    try {
      const files = await prepareExport(api, {
        now: Date.now(),
        onProgress: (progress) => {
          if (mounted.current) setExportState({ status: 'working', progress });
        },
      });
      if (!mounted.current) {
        clearExportFiles();
        return;
      }
      setExportState({ status: 'ready', files });
      AccessibilityInfo.announceForAccessibility('Your export is ready.');
      const data = files.find((f) => f.kind === 'data');
      if (data) await share(data);
    } catch (error) {
      if (!mounted.current) return;
      const failure = describeExportError(error);
      if (failure.reauth) {
        setExportState({ status: 'reauth' });
        router.push('/reauth?next=export');
      } else {
        setExportState({ status: 'failed', message: failure.message });
        AccessibilityInfo.announceForAccessibility(failure.message);
      }
    }
  };

  const dataFile = exportState.status === 'ready' ? exportState.files.find((f) => f.kind === 'data') : undefined;
  const routeFiles = exportState.status === 'ready' ? exportState.files.filter((f) => f.kind === 'route') : [];

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Privacy" />

      <View style={styles.hero}>
        <View style={styles.badge} aria-hidden>
          <ShieldCheck size={40} color={colors.onAccent} strokeWidth={2.2} />
        </View>
        <Text variant="title" align="center" accessibilityRole="header">
          Your run. Your data.
        </Text>
        <Text variant="body" tone="secondary" align="center">
          Routes are visible only to you.
        </Text>
      </View>

      <RowGroup>
        <Row icon={Route} label="Routes" value="Only you" hint="Routes never appear in leagues or share images." />
        <Row icon={Users} label="League profile" value="Members only" hint="Your league sees your runner name, tier and weekly XP." />
        <Row icon={Bell} label="Notifications" value="Manage" onPress={() => router.push('/profile/notifications')} last />
      </RowGroup>

      {canChangePassword ? (
        <RowGroup>
          <Row icon={KeyRound} label="Change password" onPress={() => router.push('/profile/password')} last testID="change-password" />
        </RowGroup>
      ) : null}

      <RowGroup>
        <Row
          icon={Download}
          label="Export my data"
          hint="Your data as a JSON file, plus a GPX file for each route."
          value={working ? 'Preparing…' : undefined}
          accessory={working ? <ActivityIndicator color={colors.textSecondary} /> : undefined}
          onPress={working ? undefined : () => void startExport()}
          last
          testID="export-data"
        />
      </RowGroup>

      {exportState.status === 'working' ? (
        <InlineStatus icon={Download} title={progressLabel(exportState.progress)} body="Keep this screen open. It can take a minute if you have many runs." />
      ) : null}
      {exportState.status === 'reauth' ? (
        <InlineStatus title="Confirm it’s you to export your data." body="After you confirm, tap Export my data again." />
      ) : null}
      {exportState.status === 'failed' ? <InlineStatus tone="danger" title={exportState.message} /> : null}
      {dataFile ? (
        <View style={styles.ready}>
          <InlineStatus
            tone="success"
            title="Your export is ready."
            body="Share the data file to save it to Files, Mail or another app. You choose where it goes."
          />
          <PrimaryButton label="Share data file (JSON)" icon={Share} onPress={() => void share(dataFile)} />
          {routeFiles.length > 0 ? (
            <>
              <Text variant="eyebrow" tone="secondary" accessibilityRole="header" style={styles.sectionLabel}>
                Route files (GPX)
              </Text>
              <RowGroup>
                {routeFiles.map((file, i) => (
                  <Row
                    key={file.name}
                    icon={MapPinned}
                    label={file.label}
                    value={runDate(file.startedAtMs)}
                    onPress={() => void share(file)}
                    last={i === routeFiles.length - 1}
                  />
                ))}
              </RowGroup>
            </>
          ) : null}
          <Text variant="caption" tone="secondary">
            These files include your routes. They’re removed from this phone when you leave this screen.
          </Text>
        </View>
      ) : null}
      {shareNotice ? <InlineStatus tone="warning" title={shareNotice} /> : null}

      <DangerButton label="Delete account" icon={Trash2} onPress={() => router.push('/profile/delete-account')} testID="delete-account" />

      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="How your data is handled"
          accessibilityState={{ expanded: detailsOpen }}
          onPress={() => setDetailsOpen((open) => !open)}
          style={({ pressed }) => [styles.disclosure, pressed && { opacity: 0.7 }]}>
          <Info size={20} color={colors.textSecondary} />
          <Text variant="labelStrong" style={styles.fill}>
            How your data is handled
          </Text>
          {detailsOpen ? <ChevronUp size={20} color={colors.textSecondary} /> : <ChevronDown size={20} color={colors.textSecondary} />}
        </Pressable>
        {detailsOpen ? (
          <View style={styles.details}>
            {DATA_HANDLING.map((line) => (
              <Text key={line} variant="label" tone="secondary">
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  badge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  ready: { gap: space.md },
  sectionLabel: { marginTop: space.sm },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: layout.minimumTapTarget,
    paddingVertical: space.sm,
  },
  fill: { flex: 1 },
  details: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
  },
});
