import { useState } from 'react';

import { TextButton } from '@/components/ui/buttons';
import { Row, RowGroup, TextField } from '@/components/ui/elements';
import { Sheet } from '@/components/ui/sheet';
import { countryName, searchCountries } from '@/features/leaderboards/countries';
import { Text } from '@/design/text';
import { colors } from '@/design/tokens';

/** Pick the country board to be on (docs/ROADMAP.md 4.7). */
export function CountrySheet({
  visible,
  current,
  suggested,
  onPick,
  onClose,
}: {
  visible: boolean;
  current: string | null;
  /** The phone's region, offered first. */
  suggested: string;
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const matches = searchCountries(query);
  const shortlist = [suggested, ...(current && current !== suggested ? [current] : [])];
  const close = () => {
    setQuery('');
    onClose();
  };
  const pick = (code: string) => {
    setQuery('');
    onPick(code);
  };
  return (
    <Sheet visible={visible} onClose={close} title="Your country">
      <Text variant="body" tone="secondary">
        Your country board shows runners who picked the same country. It’s never worked out from where you run.
      </Text>
      <TextField label="Search countries" value={query} onChangeText={setQuery} autoCorrect={false} placeholder="Canada, Mexico…" testID="country-search" />
      <RowGroup style={{ backgroundColor: colors.surface }}>
        {(matches.length > 0 ? matches.map((c) => c.code) : shortlist).map((code, i, all) => (
          <Row key={code} label={countryName(code)} value={code === current ? 'Current' : undefined} onPress={() => pick(code)} last={i === all.length - 1} />
        ))}
      </RowGroup>
      {query.trim().length > 0 && matches.length === 0 ? (
        <Text variant="caption" tone="secondary">
          No country by that name.
        </Text>
      ) : null}
      <TextButton label="Cancel" onPress={close} />
    </Sheet>
  );
}
