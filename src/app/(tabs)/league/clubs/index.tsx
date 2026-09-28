import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Globe, Lock, Plus, Search } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Club } from '@/api/club-schemas';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus, Row, RowGroup, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { useClubActions, useMyClubs } from '@/features/clubs/use-clubs';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function clubLine(club: Club): string {
  return `${club.visibility === 'public' ? 'Public' : 'Invite only'} · ${club.member_count} ${club.member_count === 1 ? 'runner' : 'runners'}`;
}

/**
 * Clubs (docs/ROADMAP.md 4.5): the runner's clubs, public clubs found by name, and joining an
 * invite-only club with a code.
 */
export default function ClubsScreen() {
  const router = useRouter();
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const mine = useMyClubs();
  const actions = useClubActions();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const search = useQuery({
    queryKey: [accountId, 'club-search', debounced],
    enabled: api !== null && debounced.length >= 3,
    queryFn: () => api!.searchClubs(debounced),
    staleTime: 30_000,
  });
  const open = (id: string) => router.push({ pathname: '/league/clubs/[id]', params: { id } });
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const clubs = mine.data?.data ?? [];

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Clubs" />
      <Text variant="body" tone="secondary">
        Bigger groups for your running club, parkrun or office, with a weekly board and group runs. There’s no chat inside PaceLeague.
      </Text>

      {clubs.length === 0 && mine.data ? (
        <Card>
          <EmptyState title="You’re not in a club yet." body="Find a public club by name, join one with a code, or start your own." />
        </Card>
      ) : (
        <RowGroup>
          {clubs.map((c, i) => (
            <Row
              key={c.id}
              icon={c.visibility === 'public' ? Globe : Lock}
              label={c.name}
              hint={clubLine(c)}
              value={c.my_role ? ROLE[c.my_role] : undefined}
              onPress={() => open(c.id)}
              last={i === clubs.length - 1}
            />
          ))}
        </RowGroup>
      )}
      <SecondaryButton label="Start a club" icon={Plus} onPress={() => router.push('/league/clubs/edit')} testID="start-club" />

      <TextField
        label="Find a public club"
        value={query}
        onChangeText={setQuery}
        placeholder="At least 3 letters"
        autoCorrect={false}
        testID="club-search"
      />
      {debounced.length >= 3 ? (
        search.isPending ? (
          <Text variant="label" tone="secondary">
            Searching…
          </Text>
        ) : (search.data ?? []).length === 0 ? (
          <Text variant="label" tone="secondary">
            No public clubs by that name. Invite-only clubs don’t show up here.
          </Text>
        ) : (
          <RowGroup>
            {(search.data ?? []).map((c, i, all) => (
              <Row key={c.id} icon={Search} label={c.name} hint={clubLine(c)} value={c.is_member ? 'Joined' : undefined} onPress={() => open(c.id)} last={i === all.length - 1} />
            ))}
          </RowGroup>
        )
      ) : null}

      <View style={styles.code}>
        <View style={styles.fill}>
          <TextField label="Have a club code?" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="ABCD-EFGH" maxLength={9} />
        </View>
        <TextButton
          label="Join"
          disabled={clean.length !== 8 || actions.busy}
          onPress={() =>
            void actions.joinByCode(clean).then((club) => {
              if (club) {
                setCode('');
                open(club.id);
              }
            })
          }
          testID="club-code-join"
        />
      </View>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  code: { flexDirection: 'row', alignItems: 'flex-end', gap: space.md },
  fill: { flex: 1 },
});
