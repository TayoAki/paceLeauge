import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { FileText, Mail, ShieldCheck, Trophy } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Platform } from 'react-native';

import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { env } from '@/config/env';
import { RULE_VERSION, VALIDATOR_VERSION } from '@/domain/config';
import { useMe } from '@/features/data/hooks';
import { Text } from '@/design/text';

const APP_VERSION = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'Unknown';
const APP_BUILD = Application.nativeBuildVersion ?? 'Unknown';

function SectionLabel({ children }: { children: string }) {
  return (
    <Text variant="eyebrow" tone="secondary" accessibilityRole="header">
      {children}
    </Text>
  );
}

/** Reachable support (REQ-011), legal documents and the versions this app runs on. */
export default function SupportScreen() {
  const router = useRouter();
  const config = useMe().data?.data.config;
  const [problem, setProblem] = useState<string | null>(null);

  const emailSupport = async () => {
    setProblem(null);
    // App details only: no account identifiers, routes or run data.
    const details = `\n\n—\nPaceLeague ${APP_VERSION} (${APP_BUILD}) · ${env.appEnv} · ${Platform.OS} ${Platform.Version}`;
    const url = `mailto:${env.supportEmail}?subject=${encodeURIComponent('PaceLeague support')}&body=${encodeURIComponent(details)}`;
    try {
      await Linking.openURL(url);
    } catch {
      setProblem(`Couldn’t open Mail. You can write to ${env.supportEmail}.`);
    }
  };

  const openLegal = (section: 'terms' | 'privacy') => {
    const url = section === 'terms' ? env.termsUrl : env.privacyUrl;
    if (url) void WebBrowser.openBrowserAsync(url);
    else router.push({ pathname: '/legal', params: { section } });
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Support & legal" />

      <SectionLabel>Support</SectionLabel>
      {env.supportEmail ? (
        <RowGroup>
          <Row icon={Mail} label="Email support" value={env.supportEmail} onPress={() => void emailSupport()} last />
        </RowGroup>
      ) : (
        <InlineStatus title="Support contact will be published before the pilot." />
      )}
      {problem ? <InlineStatus tone="danger" title={problem} /> : null}

      <SectionLabel>Legal</SectionLabel>
      <RowGroup>
        <Row icon={FileText} label="Terms" onPress={() => openLegal('terms')} />
        <Row icon={ShieldCheck} label="Privacy Policy" onPress={() => openLegal('privacy')} last />
      </RowGroup>

      <SectionLabel>Scoring</SectionLabel>
      <RowGroup>
        <Row icon={Trophy} label="How scoring works" onPress={() => router.push('/league/rules')} last />
      </RowGroup>

      <SectionLabel>About this app</SectionLabel>
      <RowGroup>
        <Row label="Version" value={APP_VERSION} />
        <Row label="Build" value={APP_BUILD} />
        <Row label="Environment" value={env.appEnv} />
        <Row label="Scoring rules" value={`v${config?.rule_version ?? RULE_VERSION}`} />
        <Row label="Run validator" value={`v${config?.validator_version ?? VALIDATOR_VERSION}`} last />
      </RowGroup>
    </Screen>
  );
}
