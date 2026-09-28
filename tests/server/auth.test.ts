import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { createPaceApi } from '@/api/pace-api';
import { supabaseTransport } from '@/api/supabase-transport';
import { competitionDate, startOfDay } from '@/domain/calendar';
import { chunk, encodeChunk } from '@/domain/route-codec';
import { steadyRun } from '@/domain/synthetic';

import { signJwt } from '../../server/src/jwt';
import { PUBLIC_KEY, sha256Hex, signIn, startTestApi, type TestApi } from './harness';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

const email = () => `${randomUUID()}@example.test`;

async function raw(path: string, init: RequestInit & { apikey?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.apikey !== null) headers.set('apikey', init.apikey ?? PUBLIC_KEY);
  headers.set('content-type', 'application/json');
  return fetch(`${api.url}${path}`, { ...init, headers });
}

describe('email sign-in codes', () => {
  it('signs in with an emailed code and reaches the RPC endpoint as that runner', async () => {
    const address = email();
    const { client, session } = await signIn(api, address);
    expect(session.user.email).toBe(address);
    expect(session.refresh_token).toMatch(/^[\w-]{40,}$/);

    const me = await client.rpc('get_me');
    expect(me.error).toBeNull();
    expect(me.data.user_id).toBe(session.user.id);
    expect(me.data.profile).toBeNull();

    const user = await client.auth.getUser();
    expect(user.data.user?.identities?.[0]).toMatchObject({ provider: 'email' });
  });

  it('stores only an HMAC of the code, never the code itself', async () => {
    const address = email();
    const client = api.client();
    await client.auth.signInWithOtp({ email: address });
    const code = api.lastCode(address);
    const [row] = await api.db.sql<{ code_hmac: string }>('select code_hmac from auth.one_time_codes where email = $1', [address]);
    expect(row!.code_hmac).not.toContain(code);
    expect(row!.code_hmac).not.toBe(sha256Hex(code));
    expect(row!.code_hmac).not.toBe(sha256Hex(`${address}:${code}`));
  });

  it('accepts a code once, and never after it expires', async () => {
    const address = email();
    const client = api.client();
    await client.auth.signInWithOtp({ email: address });
    const code = api.lastCode(address);
    expect((await client.auth.verifyOtp({ email: address, token: code, type: 'email' })).error).toBeNull();
    const reused = await api.client().auth.verifyOtp({ email: address, token: code, type: 'email' });
    expect(reused.error?.message).toMatch(/expired or is invalid/);

    const later = email();
    await client.auth.signInWithOtp({ email: later });
    await api.db.sql(`update auth.one_time_codes set expires_at = now() - interval '1 second' where email = $1`, [later]);
    const expired = await api.client().auth.verifyOtp({ email: later, token: api.lastCode(later), type: 'email' });
    expect(expired.error?.message).toMatch(/expired or is invalid/);
  });

  it('kills a code after five wrong guesses', async () => {
    const address = email();
    const client = api.client();
    await client.auth.signInWithOtp({ email: address });
    const code = api.lastCode(address);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expect((await client.auth.verifyOtp({ email: address, token: wrong, type: 'email' })).error).not.toBeNull();
    }
    expect((await client.auth.verifyOtp({ email: address, token: code, type: 'email' })).error?.message).toMatch(/expired or is invalid/);
  });

  it('enforces a resend cooldown per address', async () => {
    const address = email();
    const client = api.client();
    expect((await client.auth.signInWithOtp({ email: address })).error).toBeNull();
    const again = await client.auth.signInWithOtp({ email: address });
    expect(again.error?.status).toBe(429);
    expect(again.error?.message).toMatch(/after \d+ seconds/);
    expect(api.mailer.sent.filter((m) => m.to === address)).toHaveLength(1);
  });

  it('limits code requests per client address', async () => {
    const client = api.client('192.0.2.77');
    let limited = false;
    for (let i = 0; i < 31 && !limited; i += 1) {
      const result = await client.auth.signInWithOtp({ email: email() });
      limited = result.error?.status === 429;
    }
    expect(limited).toBe(true);
  });

  it('rejects malformed addresses and unknown accounts when sign-up is not allowed', async () => {
    const client = api.client();
    expect((await client.auth.signInWithOtp({ email: 'not-an-email' })).error?.status).toBe(400);
    const noSignup = await client.auth.signInWithOtp({ email: email(), options: { shouldCreateUser: false } });
    expect(noSignup.error?.status).toBe(422);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and keeps the original sign-in time in the token', async () => {
    const { client, session } = await signIn(api);
    const amr = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).amr[0].timestamp as number;
    const refreshed = await client.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session!.refresh_token).not.toBe(session.refresh_token);
    expect(amr(refreshed.data.session!.access_token)).toBe(amr(session.access_token));
  });

  it('treats reuse of a rotated refresh token as theft and ends the session', async () => {
    const { client, session } = await signIn(api);
    const refreshed = await client.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    // Outside the short grace window for racing requests:
    await api.db.sql(`update auth.refresh_tokens set revoked_at = now() - interval '1 minute' where revoked_at is not null`);
    const stolen = await api.client().auth.refreshSession({ refresh_token: session.refresh_token });
    expect(stolen.error?.message).toMatch(/Already Used/);
    const legitimate = await api.client().auth.refreshSession({ refresh_token: refreshed.data.session!.refresh_token });
    expect(legitimate.error).not.toBeNull();
  });

  it('signs out this device, or every device', async () => {
    const address = email();
    const first = await signIn(api, address);
    const second = await signIn(api, address);
    await first.client.auth.signOut({ scope: 'local' });
    expect((await api.client().auth.refreshSession({ refresh_token: first.session.refresh_token })).error).not.toBeNull();
    const stillThere = await api.client().auth.refreshSession({ refresh_token: second.session.refresh_token });
    expect(stillThere.error).toBeNull();

    const third = await signIn(api, address);
    await third.client.auth.signOut({ scope: 'global' });
    expect((await api.client().auth.refreshSession({ refresh_token: stillThere.data.session!.refresh_token })).error).not.toBeNull();
  });
});

describe('RPC endpoint', () => {
  it('requires the app key, rejects forged tokens and switches role per caller', async () => {
    expect((await raw('/rest/v1/rpc/get_app_config', { method: 'POST', body: '{}', apikey: 'wrong-key-wrong-key' })).status).toBe(401);
    expect((await raw('/rest/v1/rpc/get_app_config', { method: 'POST', body: '{}', apikey: null })).status).toBe(401);

    const anon = await raw('/rest/v1/rpc/get_app_config', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${PUBLIC_KEY}` } });
    expect(anon.status).toBe(200);
    const anonMe = await raw('/rest/v1/rpc/get_me', { method: 'POST', body: '{}' });
    expect(anonMe.status).toBe(401);
    expect(await anonMe.json()).toMatchObject({ code: '42501' });

    const forged = signJwt({ sub: randomUUID(), role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }, 'not-the-secret-not-the-secret-123');
    const rejected = await raw('/rest/v1/rpc/get_me', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${forged}` } });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ code: 'PGRST301' });

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: randomUUID(), role: 'authenticated', aud: 'authenticated', exp: 9e9 })).toString('base64url')}.`;
    expect((await raw('/rest/v1/rpc/get_me', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${none}` } })).status).toBe(401);
  });

  it('answers unknown functions and oversized bodies like PostgREST, with security headers', async () => {
    const missing = await raw('/rest/v1/rpc/not_a_function', { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'PGRST202' });
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missing.headers.get('cache-control')).toBe('no-store');

    const huge = await raw('/rest/v1/rpc/get_app_config', { method: 'POST', body: JSON.stringify({ p: 'x'.repeat(1_100_000) }) });
    expect(huge.status).toBe(413);
  });

  it('runs the whole run upload through the app’s own API client and awards +77 XP', async () => {
    const { client } = await signIn(api);
    const paceApi = createPaceApi(supabaseTransport(client));
    await paceApi.saveProfile({ alias: `Runner${Math.floor(Math.random() * 1e6)}`, units: 'metric', goalDays: 3, notificationTz: 'America/Chicago', ackEligibility: true });
    // Ended half an hour ago, but never across the league's midnight: a run split over two days
    // earns two active-day bonuses.
    let endedAt = Date.now() - 30 * 60_000;
    const midnight = startOfDay(competitionDate(endedAt));
    if (endedAt - 1_888_000 < midnight) endedAt = midnight - 60_000;
    const run = steadyRun(endedAt - 1_888_000, 5246, 1888);
    const clientRunId = randomUUID();
    const chunks = chunk(run.points).map((points, seq) => {
      const body = encodeChunk(points);
      return { seq, body, checksum: sha256Hex(body) };
    });
    const started = await paceApi.startRunUpload({
      clientRunId,
      startedAtMs: run.startedAt,
      endedAtMs: run.endedAt,
      segments: run.segments,
      clientDistanceM: run.truthDistanceM,
      clientActiveMs: 1_888_000,
      expectedPoints: run.points.length,
      expectedChunks: chunks.length,
      title: 'Morning run',
      interrupted: false,
    });
    for (const c of chunks) await paceApi.putRouteChunk(started.run_id, c.seq, c.body, c.checksum);
    const result = await paceApi.finalizeRun(
      started.run_id,
      started.version,
      chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
    );
    expect(result.run.status).toBe('accepted');
    expect(result.run.xp_award).toMatchObject({ total_xp: 77, distance_xp: 52, active_day_bonus: 25 });
    const history = await paceApi.listMyRuns(null, 5);
    expect(history.runs.find((r) => r.client_run_id === clientRunId)?.xp_award?.total_xp).toBe(77);
  });
});

describe('Sign in with Apple', () => {
  const nonce = () => randomUUID();

  it('signs in with a valid identity token and links nothing it shouldn’t', async () => {
    const raw1 = nonce();
    const client = api.client();
    const token = api.appleToken({ nonce: sha256Hex(raw1), email: 'relay123@privaterelay.appleid.com', email_verified: 'true' });
    const result = await client.auth.signInWithIdToken({ provider: 'apple', token, nonce: raw1 });
    expect(result.error).toBeNull();
    expect(result.data.user?.identities?.[0]).toMatchObject({ provider: 'apple' });
    expect(result.data.user?.email).toBe('relay123@privaterelay.appleid.com');
  });

  it('links to an existing account only through an Apple-verified email', async () => {
    const address = email();
    const existing = await signIn(api, address);
    const rawNonce = nonce();
    const verified = await api.client().auth.signInWithIdToken({
      provider: 'apple',
      token: api.appleToken({ nonce: sha256Hex(rawNonce), email: address, email_verified: true }),
      nonce: rawNonce,
    });
    expect(verified.data.user?.id).toBe(existing.session.user.id);

    const other = email();
    const mine = await signIn(api, other);
    const unverifiedNonce = nonce();
    const unverified = await api.client().auth.signInWithIdToken({
      provider: 'apple',
      token: api.appleToken({ nonce: sha256Hex(unverifiedNonce), email: other, email_verified: false }),
      nonce: unverifiedNonce,
    });
    expect(unverified.error).toBeNull();
    expect(unverified.data.user?.id).not.toBe(mine.session.user.id);
  });

  it('rejects wrong audience, wrong nonce, missing nonce, expiry and a foreign signing key', async () => {
    const attempt = async (claims: Record<string, unknown>, rawNonce: string | undefined, options = {}) =>
      (await api.client().auth.signInWithIdToken({ provider: 'apple', token: api.appleToken(claims, options), nonce: rawNonce })).error?.status;
    const n = nonce();
    expect(await attempt({ nonce: sha256Hex(n), aud: 'com.someone.else' }, n)).toBe(400);
    expect(await attempt({ nonce: sha256Hex(n) }, nonce())).toBe(400);
    expect(await attempt({ nonce: sha256Hex(n) }, undefined)).toBe(400);
    expect(await attempt({ nonce: sha256Hex(n), exp: Math.floor(Date.now() / 1000) - 5 }, n)).toBe(400);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await attempt({ nonce: sha256Hex(n) }, n, { key: privateKey })).toBe(400);
    expect(await attempt({ nonce: sha256Hex(n) }, n, { kid: 'unknown-kid' })).toBe(400);
  });
});

describe('review account', () => {
  it('accepts the configured code for one address only, without emailing it', async () => {
    const review = await startTestApi({ REVIEW_ACCOUNT_EMAIL: 'review@paceleague.test', REVIEW_ACCOUNT_CODE: '246810' });
    try {
      const client = review.client();
      expect((await client.auth.signInWithOtp({ email: 'review@paceleague.test' })).error).toBeNull();
      expect(review.mailer.sent).toHaveLength(0);
      expect((await client.auth.verifyOtp({ email: 'review@paceleague.test', token: '246810', type: 'email' })).error).toBeNull();
      const other = review.client();
      await other.auth.signInWithOtp({ email: 'someone@paceleague.test' });
      expect((await other.auth.verifyOtp({ email: 'someone@paceleague.test', token: '246810', type: 'email' })).error).not.toBeNull();
    } finally {
      await review.close();
    }
  });
});
