import { checkAge, classifyRange, type AgePort, type AgeRangeAnswer } from '@/features/account/age-check';

function port(overrides: Partial<AgePort> = {}): AgePort & { asked: number } {
  const p = {
    platform: 'ios' as const,
    iosMajor: 26,
    asked: 0,
    isEligible: async () => true as boolean | null,
    signalsAccess: async () => null,
    requestRange: async (): Promise<AgeRangeAnswer> => ({ lowerBound: 18, upperBound: null, source: 'selfDeclared' }),
    ...overrides,
  };
  const request = p.requestRange;
  p.requestRange = async () => {
    p.asked += 1;
    return request();
  };
  return p;
}

const declined = Object.assign(new Error('declined'), { code: 'ERR_AGE_RANGE_USER_DECLINED' });
const unavailable = Object.assign(new Error('not available'), { code: 'ERR_AGE_RANGE_NOT_AVAILABLE' });

describe('classifyRange', () => {
  it.each([
    [{ lowerBound: 18, upperBound: null }, 'adult'],
    [{ lowerBound: 21, upperBound: 25 }, 'adult'],
    [{ lowerBound: 13, upperBound: 15 }, 'teen_13_15'],
    [{ lowerBound: 16, upperBound: 17 }, 'teen_16_17'],
    [{ lowerBound: 13, upperBound: 17 }, 'teen_13_15'],
    [{ lowerBound: null, upperBound: 12 }, 'minor'],
    [{ lowerBound: null, upperBound: 17 }, 'minor'],
    [{ lowerBound: null, upperBound: null }, null],
    [{ lowerBound: 16, upperBound: null }, null],
  ])('%j → %s', (range, expected) => {
    expect(classifyRange({ ...range, source: null })).toBe(expected);
  });
});

describe('checkAge on iOS', () => {
  it('records an adult with the declaration type', async () => {
    await expect(checkAge(port(), 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'adult', source: 'selfDeclared' });
  });

  it('refuses a child under 13', async () => {
    const p = port({ requestRange: async () => ({ lowerBound: null, upperBound: 12, source: 'guardianDeclared' }) });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'minor', source: 'guardianDeclared' });
  });

  it('makes a teen account for 13 to 17, in two bands', async () => {
    const older = port({ requestRange: async () => ({ lowerBound: 16, upperBound: 17, source: 'guardianDeclared' }) });
    await expect(checkAge(older, 'sign_up')).resolves.toEqual({ outcome: 'teen', signal: 'teen_16_17', source: 'guardianDeclared' });
    const younger = port({ requestRange: async () => ({ lowerBound: 13, upperBound: 15, source: 'selfDeclared' }) });
    await expect(checkAge(younger, 'sign_up')).resolves.toEqual({ outcome: 'teen', signal: 'teen_13_15', source: 'selfDeclared' });
  });

  it('skips the prompt where the OS says age rules do not apply', async () => {
    const p = port({ isEligible: async () => false });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'not_regulated' });
    expect(p.asked).toBe(0);
  });

  it('does not trust the placeholder adult returned before iOS 26', async () => {
    const p = port({ iosMajor: 18 });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'os_unsupported' });
    expect(p.asked).toBe(0);
  });

  it('asks at sign-up when eligibility is unknown (iOS 26.0–26.1), but not for existing accounts', async () => {
    const signUp = port({ isEligible: async () => null });
    await expect(checkAge(signUp, 'sign_up')).resolves.toMatchObject({ outcome: 'allowed', signal: 'adult' });
    expect(signUp.asked).toBe(1);

    const existing = port({ isEligible: async () => null });
    await expect(checkAge(existing, 'existing')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'not_confirmed' });
    expect(existing.asked).toBe(0);
  });

  it('treats an eligibility error as unknown', async () => {
    const p = port({
      isEligible: async () => {
        throw new Error('boom');
      },
    });
    await expect(checkAge(p, 'sign_up')).resolves.toMatchObject({ outcome: 'allowed', signal: 'adult' });
  });

  it('blocks a regulated runner who declines, and explains why', async () => {
    const p = port({
      requestRange: async () => {
        throw declined;
      },
    });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'needs_age', reason: 'declined' });
  });

  it('falls back to the self-declaration when an unregulated runner declines', async () => {
    const p = port({
      isEligible: async () => null,
      requestRange: async () => {
        throw declined;
      },
    });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'declined' });
  });

  it('reports an unavailable answer in a regulated region', async () => {
    const p = port({
      requestRange: async () => {
        throw unavailable;
      },
    });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'needs_age', reason: 'unavailable' });
  });

  it('drops malformed source tokens', async () => {
    const p = port({ requestRange: async () => ({ lowerBound: 18, upperBound: null, source: 'not a token!' }) });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'adult', source: 'declared' });
  });
});

describe('checkAge on Android', () => {
  const android = (overrides: Partial<AgePort>) => port({ platform: 'android', iosMajor: null, ...overrides });

  it('uses Play Age Signals when shared', async () => {
    const p = android({ signalsAccess: async () => 'SHARED', requestRange: async () => ({ lowerBound: 18, upperBound: null, source: 'TIER_C' }) });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'adult', source: 'TIER_C' });
  });

  it('makes a teen account for a teen reported by Play, and refuses a child', async () => {
    const teen = android({ signalsAccess: async () => 'SHARED', requestRange: async () => ({ lowerBound: 13, upperBound: 15, source: 'TIER_B' }) });
    await expect(checkAge(teen, 'sign_up')).resolves.toEqual({ outcome: 'teen', signal: 'teen_13_15', source: 'TIER_B' });
    const child = android({ signalsAccess: async () => 'SHARED', requestRange: async () => ({ lowerBound: 0, upperBound: 12, source: 'TIER_B' }) });
    await expect(checkAge(child, 'sign_up')).resolves.toEqual({ outcome: 'minor', source: 'TIER_B' });
  });

  it('asks the runner to verify when Play requires it', async () => {
    await expect(checkAge(android({ signalsAccess: async () => 'VERIFICATION_REQUIRED' }), 'sign_up')).resolves.toEqual({
      outcome: 'needs_age',
      reason: 'verification_required',
    });
  });

  it('falls back where Play does not share signals', async () => {
    const p = android({ signalsAccess: async () => 'NOT_SHARED' });
    await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'not_shared' });
    expect(p.asked).toBe(0);
  });
});

it('never prompts on the web', async () => {
  const p = port({ platform: 'web', iosMajor: null });
  await expect(checkAge(p, 'sign_up')).resolves.toEqual({ outcome: 'allowed', signal: 'not_required', source: 'web' });
  expect(p.asked).toBe(0);
});
