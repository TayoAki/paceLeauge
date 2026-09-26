import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet } from 'react-native';

import { env } from '@/config/env';
import { Text } from '@/design/text';

/** "By continuing, you agree to Terms and Privacy." — opens the operator's pages when set. */
export function LegalLinks() {
  const router = useRouter();
  const open = (url: string, section: 'terms' | 'privacy') => {
    if (url) void WebBrowser.openBrowserAsync(url);
    else router.push({ pathname: '/legal', params: { section } });
  };
  return (
    <Text variant="caption" tone="secondary" align="center">
      By continuing, you agree to{' '}
      <Text variant="caption" style={styles.link} accessibilityRole="link" onPress={() => open(env.termsUrl, 'terms')}>
        Terms
      </Text>{' '}
      and{' '}
      <Text variant="caption" style={styles.link} accessibilityRole="link" onPress={() => open(env.privacyUrl, 'privacy')}>
        Privacy
      </Text>
      .
    </Text>
  );
}

const styles = StyleSheet.create({ link: { textDecorationLine: 'underline' } });
