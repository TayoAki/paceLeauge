import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ExternalLink } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { env } from '@/config/env';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const DATA_PRACTICES = [
  'Your routes are visible only to you. They never appear in leagues or share images.',
  'Your league sees your runner name, tier and weekly XP — not your email or your routes.',
  'Sharing creates a stats-only image: distance, time and pace, with no map or location.',
  'You can export your data (JSON and GPX) and delete your account in the app, under Profile → Privacy.',
  'App analytics are kept to a minimum and never include coordinates, routes, email or run titles.',
  'Data stored in the cloud is processed by the operator of PaceLeague and its service providers under access controls. It isn’t end-to-end encrypted.',
  'Deleting your account hides you from your league right away and removes your primary data within 7 days.',
];

const PILOT_FACTS = [
  'The pilot is for adults (18 and over).',
  'PaceLeague doesn’t give medical or training advice. Run at your own pace.',
  'GPS distance is an estimate from your phone, not a certified measurement.',
  'There are no cash prizes or wagering, and no paid feature changes XP or rank.',
];

function Bullets({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <Card>
      <Text variant="section" accessibilityRole="header">
        {title}
      </Text>
      {items.map((item) => (
        <View key={item} style={styles.bullet}>
          <View style={styles.dot} aria-hidden />
          <Text variant="body" tone="secondary" style={styles.fill}>
            {item}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/** Terms / Privacy: the operator's published documents, or an honest placeholder until then. */
export default function LegalScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  const terms = section === 'terms';
  const title = terms ? 'Terms of Service' : 'Privacy Policy';
  const url = terms ? env.termsUrl : env.privacyUrl;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={terms ? 'Terms' : 'Privacy'} />
      {url ? (
        <PrimaryButton label={`Read the ${title}`} icon={ExternalLink} onPress={() => void WebBrowser.openBrowserAsync(url)} />
      ) : (
        <InlineStatus
          title={`The ${title} isn’t published yet.`}
          body="The operator of PaceLeague publishes the Terms of Service and the Privacy Policy before the pilot starts. Until then, here’s a plain summary of how the app works."
        />
      )}
      <Bullets title="How PaceLeague handles your data" items={DATA_PRACTICES} />
      {terms ? <Bullets title="About the pilot" items={PILOT_FACTS} /> : null}
      <Text variant="caption" tone="secondary">
        This summary describes the app. It isn’t a substitute for the published documents.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bullet: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textSecondary, marginTop: 9 },
});
