import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';

import { pushSupported } from './push';
import { pushRoute } from './push-routes';

// A tap opens its screen once, even if this hook mounts again (sign-in, age check).
const opened = new Set<string>();

/**
 * Opens the screen a tapped push is about (docs/ROADMAP.md 4.9), including the one that launched
 * the app, and refreshes what's on screen when a push arrives while the app is open.
 */
export function usePushResponses(enabled: boolean): void {
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || !pushSupported) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (opened.has(id)) return;
      opened.add(id);
      const route = pushRoute(response.notification.request.content.data);
      if (route) router.push(route as Href);
    };
    void Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => undefined);
    const tapped = Notifications.addNotificationResponseReceivedListener(open);
    const received = Notifications.addNotificationReceivedListener((notification) => {
      if (pushRoute(notification.request.content.data)) void queryClient.invalidateQueries();
    });
    return () => {
      tapped.remove();
      received.remove();
    };
  }, [enabled, router, queryClient]);
}
