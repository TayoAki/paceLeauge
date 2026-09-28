import { COUNTRIES, countryName, knownCountry, searchCountries } from '@/features/leaderboards/countries';
import { boardStateLine, defaultCountry, eligibilityLine, inviteCopy, myStatusLine } from '@/features/leaderboards/leaderboard-text';

/** Leaderboard copy and the country list (docs/ROADMAP.md 4.7). */
describe('leaderboard countries', () => {
  it('lists every ISO 3166-1 country once, by name', () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(249);
    expect(COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.code) && c.name.length > 1)).toBe(true);
    expect(countryName('us')).toBe('United States');
    expect(countryName(null)).toBe('your country');
  });

  it('finds countries by name and keeps only codes the server accepts', () => {
    expect(searchCountries('can')[0]).toEqual({ code: 'CA', name: 'Canada' });
    expect(searchCountries('united').map((c) => c.code)).toEqual(expect.arrayContaining(['US', 'GB', 'AE']));
    expect(searchCountries('   ')).toEqual([]);
    expect(knownCountry('gb')).toBe('GB');
    expect(knownCountry('ZZ')).toBeNull();
    expect(defaultCountry('ca')).toBe('CA');
    expect(defaultCountry(undefined)).toBe('US');
  });
});

describe('leaderboard text', () => {
  it('says when results count and why a runner isn’t on the board yet', () => {
    expect(boardStateLine({ state: 'final', final_at_ms: 0 })).toBe('Final results.');
    const provisional = boardStateLine({ state: 'in_review', final_at_ms: Date.parse('2026-09-30T05:00:00Z') }, 'America/Chicago');
    expect(provisional).toBe('Provisional until Wed, Sep 30, 12:00 AM, while results are checked.');
    expect(eligibilityLine({ joined: true, eligible: false, eligible_from: '2026-10-12' })).toBe('You’ll show up from the week of Oct 12, after two weeks of runs.');
    expect(eligibilityLine({ joined: true, eligible: false, eligible_from: null })).toContain('two weeks of runs');
    expect(eligibilityLine({ joined: true, eligible: true, eligible_from: '2026-09-01' })).toBeNull();
    expect(eligibilityLine({ joined: false, eligible: false, eligible_from: null })).toBeNull();
    expect(myStatusLine('held')).toContain('being checked');
    expect(myStatusLine('final')).toBeNull();
    expect(inviteCopy('won_league', 'Tempo')).toMatchObject({ title: 'You won your league’s week' });
    expect(inviteCopy('full_week', 'Seed').body).toContain('never a route');
  });
});
