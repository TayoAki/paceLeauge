import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Activity, CalendarCheck, Check, Headphones, Sun } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { LegalLinks } from '@/components/ui/legal-links';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDateShort } from '@/domain/format';
import { useAccount } from '@/features/account/account-provider';
import { buyPackage, MANAGE_SUBSCRIPTIONS_URL, proPackages, purchasesAvailable, restorePurchases } from '@/features/pro/purchases';
import { markPurchased, useEntitlements, usePro } from '@/features/pro/use-pro';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const FEATURES = [
  { icon: Headphones, title: 'Every guided run', body: 'The full library of coached runs, from tempo to long runs.' },
  { icon: Activity, title: 'Training analytics', body: 'Training load, fitness and fatigue, race predictions and aerobic efficiency.' },
  { icon: Sun, title: 'Heat and heart-rate training', body: 'Plan paces that slow down on hot days, and heart-rate ranges for every session.' },
  { icon: CalendarCheck, title: 'Everything free stays free', body: 'Plans, recording, leagues, records, export and deletion never need Pro.' },
];

/** Pro (docs/ROADMAP.md 3.6, decision 4): $29.99 a year with a 7-day trial, or $4.99 a month. */
export default function ProScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const { pro } = usePro();
  const entitlements = useEntitlements().data?.data ?? null;
  const available = purchasesAvailable();
  const packages = useQuery({ queryKey: ['pro-packages', accountId], queryFn: proPackages, enabled: available, staleTime: 300_000 });
  const [busy, setBusy] = useState<'annual' | 'monthly' | 'restore' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [accountId, 'entitlements'] });
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: [accountId, 'entitlements'] }), 5_000);
  };

  const buy = async (which: 'annual' | 'monthly') => {
    const pkg = packages.data?.[which];
    if (!pkg) return;
    setBusy(which);
    setMessage(null);
    try {
      const outcome = await buyPackage(pkg);
      if (outcome === 'pro') {
        markPurchased();
        refresh();
        setMessage({ tone: 'success', text: 'Welcome to Pro.' });
      } else if (outcome === 'not_pro') {
        setMessage({ tone: 'info', text: 'The purchase went through but Pro isn’t on yet. Try Restore purchases in a minute.' });
      }
    } catch {
      setMessage({ tone: 'danger', text: 'The purchase didn’t go through. You haven’t been charged. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setMessage(null);
    try {
      const restored = await restorePurchases();
      if (restored) markPurchased();
      refresh();
      setMessage(restored ? { tone: 'success', text: 'Pro is back on.' } : { tone: 'info', text: 'No Pro purchase found for this Apple ID.' });
    } catch {
      setMessage({ tone: 'danger', text: 'Couldn’t reach the App Store. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const annual = packages.data?.annual ?? null;
  const monthly = packages.data?.monthly ?? null;
  const trial = annual?.product.introPrice?.price === 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="PaceLeague Pro" variant="close" onBack={() => router.back()} />
      <Text variant="title">Train further with Pro</Text>
      <View style={styles.features}>
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <View key={title} style={styles.feature} accessible accessibilityLabel={`${title}. ${body}`}>
            <Icon size={24} color={colors.accent} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyStrong">{title}</Text>
              <Text variant="label" tone="secondary">
                {body}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {message ? <InlineStatus tone={message.tone === 'info' ? 'info' : message.tone} title={message.text} /> : null}

      {pro ? (
        <Card style={styles.card}>
          <View style={styles.feature}>
            <Check size={22} color={colors.accent} strokeWidth={3} />
            <Text variant="section">You have Pro</Text>
          </View>
          {entitlements?.expires_at_ms ? (
            <Text variant="label" tone="secondary">
              {entitlements.period === 'trial'
                ? `Your free trial ends ${formatDateShort(entitlements.expires_at_ms)}.`
                : entitlements.will_renew
                  ? `Renews ${formatDateShort(entitlements.expires_at_ms)}.`
                  : `Pro until ${formatDateShort(entitlements.expires_at_ms)}.`}
            </Text>
          ) : null}
          {entitlements?.billing_issue ? (
            <InlineStatus tone="warning" title="There’s a problem with your payment." body="Update it in the App Store to keep Pro." />
          ) : null}
          {entitlements?.source === 'revenuecat' ? (
            <SecondaryButton label="Manage subscription" onPress={() => void WebBrowser.openBrowserAsync(MANAGE_SUBSCRIPTIONS_URL)} />
          ) : null}
        </Card>
      ) : !available ? (
        <InlineStatus
          title={Platform.OS === 'web' ? 'Subscribe in the PaceLeague app on your phone.' : 'Subscriptions aren’t available in this build yet.'}
          body="Pro is $29.99 a year with a 7-day free trial, or $4.99 a month."
        />
      ) : packages.isPending ? (
        <Text variant="label" tone="secondary">
          Loading prices…
        </Text>
      ) : !annual && !monthly ? (
        <InlineStatus tone="warning" title="Couldn’t load Pro from the App Store." body="Check your connection and try again." />
      ) : (
        <View style={styles.buttons}>
          {annual ? (
            <View style={styles.option}>
              <PrimaryButton
                label={trial ? 'Start 7-day free trial' : `Yearly · ${annual.product.priceString}`}
                size="large"
                loading={busy === 'annual'}
                disabled={busy !== null}
                onPress={() => void buy('annual')}
                testID="buy-annual"
              />
              <Text variant="caption" tone="secondary" align="center">
                {trial ? `Then ${annual.product.priceString} a year. We’ll remind you 2 days before the trial ends.` : 'Billed once a year.'}
              </Text>
            </View>
          ) : null}
          {monthly ? (
            <SecondaryButton
              label={`Monthly · ${monthly.product.priceString}`}
              loading={busy === 'monthly'}
              disabled={busy !== null}
              onPress={() => void buy('monthly')}
              testID="buy-monthly"
            />
          ) : null}
        </View>
      )}

      {available && !pro ? <TextButton label="Restore purchases" loading={busy === 'restore'} onPress={() => void restore()} /> : null}

      <Text variant="caption" tone="secondary">
        Payment is charged to your App Store account. Subscriptions renew automatically unless cancelled at least 24 hours before the end
        of the current period, in Settings → your name → Subscriptions. Deleting your PaceLeague account doesn’t cancel a subscription.
      </Text>
      <LegalLinks />
    </Screen>
  );
}

const styles = StyleSheet.create({
  features: { gap: space.lg },
  feature: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  card: { gap: space.sm },
  buttons: { gap: space.md },
  option: { gap: space.xs },
});
