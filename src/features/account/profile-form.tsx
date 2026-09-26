import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SegmentedControl, TextField } from '@/components/ui/elements';
import { PROFILE_RULES } from '@/domain/config';
import { useAccount } from '@/features/account/account-provider';
import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

export interface ProfileDraft {
  alias: string;
  units: 'metric' | 'imperial';
  goalDays: number | null;
  ackEligibility: boolean;
}

const aliasProblemCopy = {
  invalid: `Use ${PROFILE_RULES.aliasMinLength}–${PROFILE_RULES.aliasMaxLength} letters, numbers, spaces or . _ ' -`,
  not_allowed: 'That name isn’t available. Try another.',
  taken: 'Someone already uses that name.',
} as const;

export function aliasError(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === 'alias_invalid') return aliasProblemCopy.invalid;
  if (code === 'alias_not_allowed') return aliasProblemCopy.not_allowed;
  if (code === 'alias_taken') return aliasProblemCopy.taken;
  return aliasProblemCopy[code as keyof typeof aliasProblemCopy] ?? null;
}

/** Debounced server-side alias check (the server repeats it on save). */
function useAliasCheck(alias: string, initial: string | null) {
  const { api } = useAccount();
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const value = alias.trim();
    if (!api || value.length < PROFILE_RULES.aliasMinLength || value.toLowerCase() === initial?.toLowerCase()) {
      const t = setTimeout(() => setProblem(null), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      api
        .checkAlias(value)
        .then((r) => setProblem(r.available ? null : r.problem))
        .catch(() => setProblem(null));
    }, 450);
    return () => clearTimeout(t);
  }, [alias, api, initial]);
  return problem;
}

export function ProfileForm({
  draft,
  onChange,
  initialAlias = null,
  serverError,
  showEligibility,
}: {
  draft: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  initialAlias?: string | null;
  serverError?: string | null;
  showEligibility: boolean;
}) {
  const liveProblem = useAliasCheck(draft.alias, initialAlias);
  const tooShort = draft.alias.trim().length > 0 && draft.alias.trim().length < PROFILE_RULES.aliasMinLength;
  const error = serverError ?? (tooShort ? aliasProblemCopy.invalid : aliasError(liveProblem));
  return (
    <View style={{ gap: space.xl }}>
      <TextField
        label="Runner name"
        value={draft.alias}
        onChangeText={(alias) => onChange({ ...draft, alias: alias.slice(0, PROFILE_RULES.aliasMaxLength) })}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={PROFILE_RULES.aliasMaxLength}
        error={error}
        hint="Shown to your league only. Not searchable."
        testID="alias-input"
      />
      <View style={{ gap: space.sm }}>
        <Text variant="labelStrong">Units</Text>
        <SegmentedControl
          label="Distance units"
          value={draft.units}
          onChange={(units) => onChange({ ...draft, units })}
          options={[
            { value: 'metric', label: 'Kilometers' },
            { value: 'imperial', label: 'Miles' },
          ]}
        />
      </View>
      <View style={{ gap: space.sm }}>
        <Text variant="labelStrong">Weekly goal (optional)</Text>
        <Text variant="label" tone="secondary">
          How many active days would feel good? An active day is at least 1 km and 5 minutes.
        </Text>
        <SegmentedControl
          label="Weekly goal"
          value={draft.goalDays === null ? 'none' : String(draft.goalDays)}
          onChange={(v) => onChange({ ...draft, goalDays: v === 'none' ? null : Number(v) })}
          options={[
            { value: 'none', label: 'No goal' },
            { value: '1', label: '1 day' },
            { value: '2', label: '2 days' },
            { value: '3', label: '3 days' },
          ]}
        />
      </View>
      {showEligibility ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: draft.ackEligibility }}
          accessibilityLabel="I’m 18 or older and joining the PaceLeague pilot."
          onPress={() => onChange({ ...draft, ackEligibility: !draft.ackEligibility })}
          style={styles.check}
          testID="eligibility-checkbox">
          <View style={[styles.box, draft.ackEligibility && styles.boxOn]}>
            {draft.ackEligibility ? <Check size={18} color={colors.onAccent} strokeWidth={3} /> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">I’m 18 or older and joining the PaceLeague pilot.</Text>
            <Text variant="label" tone="secondary">
              The pilot is for adults. Running is at your own pace — no medical advice here.
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  check: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start', minHeight: layout.minimumTapTarget },
  box: {
    width: 28,
    height: 28,
    borderRadius: radius.control - 4,
    borderWidth: 2,
    borderColor: colors.controlOutline,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
});
