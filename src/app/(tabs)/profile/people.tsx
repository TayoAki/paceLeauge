import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Link2, Search, Share2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import type { FollowListKind } from '@/api/social-api';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus, Row, RowGroup, SegmentedControl, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { followLink, useFollows, useSocialActions } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

type Tab = Extract<FollowListKind, 'following' | 'followers' | 'requests'>;

/** People (docs/ROADMAP.md 4.3): who you follow, who follows you, requests, search and your link. */
export default function PeopleScreen() {
  const router = useRouter();
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const [tab, setTab] = useState<Tab>('following');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [rotating, setRotating] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const actions = useSocialActions();
  const list = useFollows(tab);
  const requests = useFollows('requests');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const search = useQuery({
    queryKey: [accountId, 'search', debounced],
    enabled: api !== null && debounced.length >= 3,
    queryFn: () => api!.searchRunners(debounced),
    staleTime: 30_000,
  });
  const code = useQuery({ queryKey: [accountId, 'follow-code'], enabled: api !== null, queryFn: () => api!.getFollowCode(false), staleTime: Infinity });

  const link = code.data ? followLink(code.data) : null;
  const shareLink = async () => {
    if (!link) return;
    setShareNote(null);
    try {
      await Share.share({ message: `Follow me on PaceLeague: ${link}` });
    } catch {
      setShareNote(`Copy your link: ${link}`);
    }
  };

  const rotate = async () => {
    if (!api) return;
    await api.getFollowCode(true).catch(() => undefined);
    await code.refetch();
    setRotating(false);
  };

  const open = (publicId: string) => router.push({ pathname: '/runner/[id]', params: { id: publicId } });
  const entries = list.data?.data ?? [];
  const pendingCount = requests.data?.data.length ?? 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="People" />

      <TextField
        label="Find runners by name"
        value={query}
        onChangeText={setQuery}
        placeholder="At least 3 letters"
        autoCapitalize="none"
        autoCorrect={false}
        hint="Only runners who chose to be found by name show up."
        testID="people-search"
      />
      {debounced.length >= 3 ? (
        search.isPending ? (
          <Text variant="label" tone="secondary">
            Searching…
          </Text>
        ) : (search.data ?? []).length === 0 ? (
          <Text variant="label" tone="secondary">
            Nobody by that name. Ask them for their follow link instead.
          </Text>
        ) : (
          <RowGroup>
            {(search.data ?? []).map((r, i, all) => (
              <Row
                key={r.public_id}
                icon={Search}
                label={r.alias}
                hint={r.tier}
                value={r.follow.following === 'accepted' ? 'Following' : r.follow.following === 'pending' ? 'Requested' : undefined}
                onPress={() => open(r.public_id)}
                last={i === all.length - 1}
              />
            ))}
          </RowGroup>
        )
      ) : null}

      <Card style={styles.card}>
        <Text variant="labelStrong">Your follow link</Text>
        <Text variant="caption" tone="secondary">
          Share it with friends so they can follow you. {link ? '' : 'Loading…'}
        </Text>
        {link ? (
          <Text variant="label" selectable numberOfLines={1}>
            {link}
          </Text>
        ) : null}
        <View style={styles.row}>
          <SecondaryButton label="Share link" icon={Share2} onPress={() => void shareLink()} disabled={!link} style={{ flex: 1 }} />
          <TextButton label="New link" onPress={() => setRotating(true)} />
        </View>
        {shareNote ? <InlineStatus title={shareNote} /> : null}
      </Card>

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <TextField label="Have someone’s code?" value={codeInput} onChangeText={setCodeInput} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD1234" />
        </View>
        <TextButton
          label="Open"
          icon={Link2}
          disabled={codeInput.replace(/[^0-9A-Za-z]/g, '').length < 8}
          onPress={() => router.push({ pathname: '/follow/[code]', params: { code: codeInput.replace(/[^0-9A-Za-z]/g, '') } })}
        />
      </View>

      <SegmentedControl<Tab>
        label="Lists"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'following', label: 'Following' },
          { value: 'followers', label: 'Followers' },
          { value: 'requests', label: pendingCount > 0 ? `Requests (${pendingCount})` : 'Requests' },
        ]}
      />
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {entries.length === 0 ? (
        <Card>
          <EmptyState
            title={tab === 'following' ? 'You don’t follow anyone yet.' : tab === 'followers' ? 'No followers yet.' : 'No requests.'}
            body={tab === 'requests' ? 'When you approve followers, their requests wait here.' : 'Share your follow link to get started.'}
          />
        </Card>
      ) : (
        <RowGroup>
          {entries.map((e, i) => (
            <View key={e.public_id}>
              <Row
                label={e.alias}
                hint={e.tier}
                value={tab === 'following' && e.status === 'pending' ? 'Requested' : undefined}
                onPress={() => open(e.public_id)}
                last={i === entries.length - 1 && tab !== 'requests'}
              />
              {tab === 'requests' ? (
                <View style={styles.requestActions}>
                  <TextButton label="Accept" tone="accent" onPress={() => void actions.respond(e.public_id, true)} testID={`accept-${e.alias}`} />
                  <TextButton label="Decline" onPress={() => void actions.respond(e.public_id, false)} />
                </View>
              ) : null}
            </View>
          ))}
        </RowGroup>
      )}

      <ConfirmSheet
        visible={rotating}
        title="Make a new link?"
        body="Your old link and code stop working. People who already follow you keep following."
        confirmLabel="New link"
        onConfirm={() => void rotate()}
        onCancel={() => setRotating(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md },
  requestActions: { flexDirection: 'row', gap: space.lg, paddingHorizontal: space.xl, paddingBottom: space.sm },
});
