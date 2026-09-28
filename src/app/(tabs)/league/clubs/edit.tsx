import { useLocalSearchParams, useRouter } from 'expo-router';
import { MessagesSquare } from 'lucide-react-native';
import { useState } from 'react';

import type { Club, ClubVisibility } from '@/api/club-schemas';
import { PrimaryButton, SecondaryButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { useClub, useClubActions } from '@/features/clubs/use-clubs';
import { Text } from '@/design/text';

const VISIBILITY: { value: ClubVisibility; label: string; about: string }[] = [
  { value: 'invite_only', label: 'Invite only', about: 'Only people with a code from you or an admin can join.' },
  { value: 'public', label: 'Public', about: 'Anyone can find the club by name and join. Only members see the board, group runs and chat link.' },
];

function ClubForm({ club }: { club: Club | null }) {
  const router = useRouter();
  const actions = useClubActions();
  const [name, setName] = useState(club?.name ?? '');
  const [description, setDescription] = useState(club?.description ?? '');
  const [visibility, setVisibility] = useState<ClubVisibility>(club?.visibility ?? 'invite_only');
  const [chat, setChat] = useState(club?.chat_url ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const owner = !club || club.my_role === 'owner';
  const clubId = club?.id ?? null;

  const save = async () => {
    setSaved(null);
    const input = { name: name.trim(), description: description.trim() || null, visibility };
    if (!clubId) {
      const created = await actions.create(input);
      if (created) router.replace({ pathname: '/league/clubs/[id]', params: { id: created.id } });
      return;
    }
    if (await actions.update(clubId, input)) setSaved('Saved.');
  };

  const saveChat = async () => {
    if (!clubId) return;
    setSaved(null);
    if (await actions.setChatLink(clubId, chat.trim() || null)) setSaved('Chat link saved.');
  };

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={<PrimaryButton label={club ? 'Save' : 'Start club'} onPress={() => void save()} disabled={name.trim().length < 3} loading={actions.busy} testID="club-save" />}>
      <NavHeader title={club ? 'Edit club' : 'Start a club'} />
      {!club ? (
        <Text variant="body" tone="secondary">
          Up to 500 runners, with a weekly board and group runs. You’ll be the owner and can make others admins.
        </Text>
      ) : null}
      <TextField label="Club name" value={name} onChangeText={setName} maxLength={40} editable={owner} hint={owner ? undefined : 'Only the owner can rename the club.'} testID="club-name" />
      <TextField
        label="About the club (optional)"
        value={description}
        onChangeText={setDescription}
        maxLength={280}
        multiline
        placeholder="Where and when you run, and who’s welcome."
        style={{ minHeight: 80, textAlignVertical: 'top' }}
      />
      {owner ? (
        <>
          <Text variant="labelStrong">Who can join</Text>
          <ChoiceChips<ClubVisibility> label="Who can join" value={visibility} onChange={setVisibility} options={VISIBILITY.map((v) => ({ value: v.value, label: v.label }))} />
          <Text variant="caption" tone="secondary">
            {VISIBILITY.find((v) => v.value === visibility)?.about}
          </Text>
        </>
      ) : null}
      {club ? (
        <>
          <TextField
            label="Group chat link"
            value={chat}
            onChangeText={setChat}
            placeholder="https://chat.whatsapp.com/…"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            hint="Your club’s WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger invite link. Only members see it."
          />
          <SecondaryButton label="Save chat link" icon={MessagesSquare} onPress={() => void saveChat()} disabled={chat.trim() === (club.chat_url ?? '')} loading={actions.busy} />
        </>
      ) : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {saved ? <InlineStatus tone="success" title={saved} /> : null}
    </Screen>
  );
}

/** Start a club or edit one (docs/ROADMAP.md 4.5). */
export default function EditClubScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const club = useClub(id ?? null);
  if (id && !club.data) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Edit club" />
        <Text variant="label" tone="secondary">
          {club.isError ? 'This club isn’t available.' : 'Loading…'}
        </Text>
      </Screen>
    );
  }
  return <ClubForm key={id ?? 'new'} club={club.data?.data ?? null} />;
}
