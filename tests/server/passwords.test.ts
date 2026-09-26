import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPaceApi } from '@/api/pace-api';
import { supabaseTransport } from '@/api/supabase-transport';

import { setTemporaryPassword } from '../../server/src/auth/admin';
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from '../../server/src/auth/passwords';
import { createPool } from '../../server/src/db';
import { loadLegalPages, renderMarkdown } from '../../server/src/legal';
import { sha256Hex, signIn, startTestApi, type TestApi } from './harness';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

const email = () => `${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery';

function claimsOf(token: string): { amr: { method: string; timestamp: number }[] } {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

async function signUp(address = email(), password = PASSWORD) {
  const client = api.client();
  const { data, error } = await client.auth.signUp({ email: address, password });
  if (error || !data.session) throw error ?? new Error('no session');
  return { client, email: address, session: data.session };
}

async function passwordSignIn(address: string, password: string) {
  return api.client().auth.signInWithPassword({ email: address, password });
}

describe('password hashing and rules', () => {
  it('stores salted scrypt hashes that verify only the right password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(await hashPassword(PASSWORD)).not.toBe(hash);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('Correct horse battery', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$999999999$8$1$a$b')).toBe(false);
  });

  it('refuses short, over-long and guessable passwords', () => {
    expect(passwordProblem('short1!', 'a@b.co')).toBe('too_short');
    expect(passwordProblem('x'.repeat(129), 'a@b.co')).toBe('too_long');
    expect(passwordProblem('Password123', 'a@b.co')).toBe('too_common');
    expect(passwordProblem('aaaaaaaaaa', 'a@b.co')).toBe('too_common');
    expect(passwordProblem('alexander', 'alexander@example.com')).toBe('too_common');
    expect(passwordProblem(PASSWORD, 'a@b.co')).toBeNull();
    // Length counts characters, not bytes.
    expect(passwordProblem('ünïcödé!', 'a@b.co')).toBeNull();
  });

  it('makes unambiguous, unique temporary passwords', () => {
    expect(temporaryPassword()).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
    expect(new Set(Array.from({ length: 50 }, temporaryPassword)).size).toBe(50);
  });
});

describe('email + password accounts', () => {
  it('signs up with a session, a hashed password and an unverified address', async () => {
    const { client, email: address, session } = await signUp();
    expect(claimsOf(session.access_token).amr[0]?.method).toBe('password');
    expect(session.user.email).toBe(address);
    expect(session.user.email_confirmed_at).toBeNull();
    const [row] = await api.db.sql<{ encrypted_password: string; email_verified: boolean }>(
      'select encrypted_password, email_verified from auth.users where email = $1',
      [address],
    );
    expect(row!.encrypted_password).toMatch(/^scrypt\$/);
    expect(row!.encrypted_password).not.toContain(PASSWORD);
    expect(row!.email_verified).toBe(false);
    await expect(createPaceApi(supabaseTransport(client)).getMe()).resolves.toMatchObject({ profile: null });
  });

  it('signs in with the right password only, whatever the address casing', async () => {
    const { email: address } = await signUp();
    expect((await passwordSignIn(address, 'not the password')).error).toMatchObject({ status: 400, code: 'invalid_credentials' });
    expect((await passwordSignIn(email(), PASSWORD)).error).toMatchObject({ status: 400, code: 'invalid_credentials' });
    const right = await passwordSignIn(address.toUpperCase(), PASSWORD);
    expect(right.error).toBeNull();
    expect(claimsOf(right.data.session!.access_token).amr[0]?.method).toBe('password');
  });

  it('refuses a second account for one address, weak passwords and bad addresses', async () => {
    const { email: address } = await signUp();
    expect((await api.client().auth.signUp({ email: address, password: 'another good one' })).error).toMatchObject({
      status: 422,
      code: 'user_already_exists',
    });
    const common = await api.client().auth.signUp({ email: email(), password: 'password1' });
    expect(common.error).toMatchObject({ status: 422, code: 'weak_password' });
    expect((common.error as unknown as { reasons: string[] }).reasons).toEqual(['pwned']);
    expect((await api.client().auth.signUp({ email: email(), password: 'abc' })).error).toMatchObject({ code: 'weak_password' });
    expect((await api.client().auth.signUp({ email: 'not-an-email', password: PASSWORD })).error).toMatchObject({ status: 400, code: 'validation_failed' });
  });

  it('limits guessing per address, even from many devices', async () => {
    const { email: address } = await signUp();
    for (let i = 0; i < 10; i += 1) {
      expect((await passwordSignIn(address, `wrong guess ${i}`)).error?.code).toBe('invalid_credentials');
    }
    expect((await passwordSignIn(address, PASSWORD)).error).toMatchObject({ status: 429 });
  });

  it('changes the password after a recent sign-in and ends the other sessions', async () => {
    const { client, email: address } = await signUp();
    const other = api.client();
    expect((await other.auth.signInWithPassword({ email: address, password: PASSWORD })).error).toBeNull();

    expect((await client.auth.updateUser({ password: PASSWORD })).error).toMatchObject({ code: 'same_password' });
    expect((await client.auth.updateUser({ password: 'short' })).error).toMatchObject({ code: 'weak_password' });
    expect((await client.auth.updateUser({ password: 'a brand new secret' })).error).toBeNull();

    expect((await passwordSignIn(address, PASSWORD)).error?.code).toBe('invalid_credentials');
    expect((await passwordSignIn(address, 'a brand new secret')).error).toBeNull();
    // The other device is signed out; this one carries on.
    expect((await other.auth.refreshSession()).error).not.toBeNull();
    expect((await client.auth.refreshSession()).error).toBeNull();
  });

  it('asks for a fresh sign-in before changing the password on an old session', async () => {
    const { client, email: address } = await signUp();
    await api.db.sql(`update auth.sessions s set signed_in_at = now() - interval '20 minutes' from auth.users u where u.id = s.user_id and u.email = $1`, [address]);
    // A refreshed token keeps the original sign-in time.
    expect((await client.auth.refreshSession()).error).toBeNull();
    expect((await client.auth.updateUser({ password: 'a brand new secret' })).error).toMatchObject({ status: 400, code: 'reauthentication_needed' });
  });

  it('counts a password sign-in as recent for account deletion', async () => {
    const { client } = await signUp();
    await expect(createPaceApi(supabaseTransport(client)).requestAccountDeletion()).resolves.toMatchObject({ state: 'queued' });
  });
});

describe('proving an address reclaims an account registered with it', () => {
  it('an emailed code clears a password someone else set and ends their sessions', async () => {
    const victim = email();
    const squatter = await signUp(victim, 'squatters secret one');
    const client = api.client();
    expect((await client.auth.signInWithOtp({ email: victim })).error).toBeNull();
    const verified = await client.auth.verifyOtp({ email: victim, token: api.lastCode(victim), type: 'email' });
    expect(verified.error).toBeNull();
    expect(verified.data.user?.id).toBe(squatter.session.user.id);

    expect((await passwordSignIn(victim, 'squatters secret one')).error?.code).toBe('invalid_credentials');
    expect((await squatter.client.auth.refreshSession()).error).not.toBeNull();
    expect((await api.db.sql<{ email_verified: boolean }>('select email_verified from auth.users where email = $1', [victim]))[0]!.email_verified).toBe(true);
  });

  it('so does Apple’s verified email', async () => {
    const victim = email();
    const squatter = await signUp(victim, 'squatters secret two');
    const nonce = randomUUID();
    const apple = await api
      .client()
      .auth.signInWithIdToken({ provider: 'apple', token: api.appleToken({ nonce: sha256Hex(nonce), email: victim, email_verified: 'true' }), nonce });
    expect(apple.error).toBeNull();
    expect(apple.data.user?.id).toBe(squatter.session.user.id);
    expect((await passwordSignIn(victim, 'squatters secret two')).error?.code).toBe('invalid_credentials');
  });

  it('a password set after proving the address stays', async () => {
    const { client, email: address } = await signIn(api);
    expect((await client.auth.updateUser({ password: 'owner chose this' })).error).toBeNull();
    await api.db.sql(`update auth.one_time_codes set sent_at = now() - interval '2 minutes' where email = $1`, [address]);
    await signIn(api, address);
    expect((await passwordSignIn(address, 'owner chose this')).error).toBeNull();
  });
});

describe('operator password reset', () => {
  it('sets a temporary password and signs the account out everywhere', async () => {
    const { client, email: address } = await signUp();
    const pool = createPool({ databaseUrl: api.db.url, databaseSsl: 'disable', databasePoolMax: 1 });
    try {
      expect(await setTemporaryPassword(pool, email())).toBeNull();
      const temporary = await setTemporaryPassword(pool, address);
      expect(temporary).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
      expect((await client.auth.refreshSession()).error).not.toBeNull();
      expect((await passwordSignIn(address, PASSWORD)).error?.code).toBe('invalid_credentials');
      expect((await passwordSignIn(address, temporary!)).error).toBeNull();
    } finally {
      await pool.end();
    }
  });
});

describe('legal pages', () => {
  it('renders a small Markdown subset, escaping everything else', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text, a [link](https://example.com) and <script>.\n\n- one\n- two\n  continued\n\n## Next');
    expect(html).toBe(
      '<h1>Title</h1>\n<p>Some <strong>bold</strong> text, a <a href="https://example.com">link</a> and &lt;script&gt;.</p>\n<ul>\n<li>one</li>\n<li>two continued</li>\n</ul>\n<h2>Next</h2>',
    );
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('marks a document that still has placeholders as a draft', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-legal-'));
    writeFileSync(join(dir, 'privacy-policy.md'), '# Privacy\n\nOperated by [Operator legal name].');
    writeFileSync(join(dir, 'terms.md'), '# Terms\n\nSee the [privacy policy](https://example.com/privacy).');
    const pages = loadLegalPages(dir);
    expect(pages.privacy).toContain('class="draft"');
    expect(pages.terms).not.toContain('class="draft"');
  });

  it('serves both pages without an API key, under a strict content policy', async () => {
    for (const doc of ['privacy', 'terms']) {
      const res = await fetch(`${api.url}/legal/${doc}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await res.text()).toContain('<h1>');
    }
  });
});

describe('with password sign-in turned off', () => {
  let off: TestApi;

  beforeAll(async () => {
    off = await startTestApi({ PASSWORD_SIGN_IN: 'false' });
  });

  afterAll(async () => {
    await off.close();
  });

  it('refuses sign-up and password sign-in', async () => {
    expect((await off.client().auth.signUp({ email: email(), password: PASSWORD })).error).toMatchObject({ status: 422, code: 'signup_disabled' });
    expect((await off.client().auth.signInWithPassword({ email: email(), password: PASSWORD })).error).toMatchObject({ code: 'provider_disabled' });
  });
});
