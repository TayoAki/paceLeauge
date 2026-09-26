/**
 * Smoke-tests a deployed PaceLeague API over HTTPS with the app's own client code.
 *
 *   (default)  creates two throwaway accounts with passwords and checks: password rules, wrong
 *              and duplicate sign-ups refused, a password change, a profile save, a full run
 *              upload (+77 XP), that neither runner can read the other's run, that a forged token
 *              and a private function are refused, the legal pages, refresh and logout; finally it
 *              requests deletion of both accounts, which the service's job loop carries out
 *              within a minute.
 *   send / verify <codeA> <codeB>
 *              the same checks for emailed sign-in codes. With EMAIL_PROVIDER=log the codes are
 *              in the service's deploy logs (search "sign-in code"); otherwise they are emailed,
 *              so set SMOKE_EMAILS to two inboxes you can read.
 *
 *   export SMOKE_API_URL=https://… SMOKE_API_KEY=…    # the app's EXPO_PUBLIC_API_URL / _KEY
 *   npm run smoke:api
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../../src/api/errors';
import { createPaceApi, type PaceApi } from '../../src/api/pace-api';
import { supabaseTransport } from '../../src/api/supabase-transport';
import { chunk, encodeChunk } from '../../src/domain/route-codec';
import { steadyRun } from '../../src/domain/synthetic';
import { signJwt } from '../../server/src/jwt';

// Typed explicitly: without Expo's generated env types, process.env values are `any`.
const env: Record<string, string | undefined> = process.env;
const url = (env.SMOKE_API_URL ?? '').replace(/\/+$/, '');
const key = env.SMOKE_API_KEY ?? '';
const statePath = resolve(import.meta.dirname, '../../artifacts/smoke-state.json');

function client(): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function raw(path: string, bearer: string | null, apikey = key, body: unknown = {}) {
  const headers: Record<string, string> = { apikey, 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

let failures = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error instanceof ApiError && error.code === code, `expected ${code}, got ${error instanceof ApiError ? error.code : String(error)}`);
}

async function send() {
  const emails = env.SMOKE_EMAILS
    ? env.SMOKE_EMAILS.split(',').map((e) => e.trim().toLowerCase())
    : [1, 2].map(() => `smoke-${randomBytes(4).toString('hex')}@example.com`);
  expect(emails.length === 2, 'SMOKE_EMAILS must list exactly two addresses');
  for (const email of emails) {
    const { error } = await client().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    expect(!error, `requesting a code for ${email}: ${error?.message}`);
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ url, emails }));
  console.log(`Codes requested for ${emails.join(' and ')}.\nThen run: npm run smoke:api -- verify <codeA> <codeB>`);
}

interface Runner {
  email: string;
  client: SupabaseClient;
  api: PaceApi;
}

async function baseChecks() {
  await check('health', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status === 200, `HTTP ${res.status}`);
    return `HSTS ${res.headers.get('strict-transport-security') ? 'on' : 'off'}`;
  });
  await check('anonymous app config', async () => {
    const config = await createPaceApi(supabaseTransport(client())).getAppConfig();
    return `competition ${config.competition_enabled ? 'on' : 'off'}, registration ${config.registration_enabled ? 'on' : 'off'}`;
  });
  await check('wrong API key is refused', async () => {
    expect((await raw('/rest/v1/rpc/get_app_config', null, 'not-the-key')).status === 401, 'expected 401');
  });
  await check('forged access token is refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = signJwt(
      { sub: randomUUID(), role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 600 },
      randomBytes(32).toString('hex'),
    );
    expect((await raw('/rest/v1/rpc/get_me', forged)).status === 401, 'expected 401');
  });
  await check('privacy policy and terms pages', async () => {
    const pages = await Promise.all(['privacy', 'terms'].map((doc) => fetch(`${url}/legal/${doc}`)));
    expect(
      pages.every((res) => res.status === 200 && res.headers.get('content-type')?.startsWith('text/html')),
      pages.map((res) => res.status).join(', '),
    );
    const drafts = (await Promise.all(pages.map((res) => res.text()))).filter((html) => html.includes('class="draft"')).length;
    return drafts > 0 ? `${drafts} still marked as drafts` : 'published';
  });
}

async function verify(codes: string[]) {
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { url: string; emails: string[] };
  expect(state.url === url, `the codes were requested from ${state.url}`);
  expect(codes.length === 2, 'pass both codes, in the order the addresses were printed');
  await baseChecks();

  const runners = state.emails.map((email) => ({ email, client: client() }));
  await check('sign in with the emailed codes', async () => {
    for (const [i, r] of runners.entries()) {
      const { error } = await r.client.auth.verifyOtp({ email: r.email, token: codes[i]!, type: 'email' });
      expect(!error, `${r.email}: ${error?.message}`);
    }
  });
  const [a, b] = runners.map((r) => ({ ...r, api: createPaceApi(supabaseTransport(r.client)) }));
  if (!a || !b || failures > 0) return;
  await accountChecks(a, b);
}

async function passwords() {
  await baseChecks();
  const password = () => `smoke ${randomBytes(9).toString('base64url')}`;
  const runners = [1, 2].map(() => ({ email: `smoke-${randomBytes(4).toString('hex')}@example.com`, password: password(), client: client() }));
  await check('create two accounts with passwords', async () => {
    for (const r of runners) {
      const { data, error } = await r.client.auth.signUp({ email: r.email, password: r.password });
      expect(!error && data.session, `${r.email}: ${error?.message}`);
    }
  });
  const [a, b] = runners.map((r) => ({ ...r, api: createPaceApi(supabaseTransport(r.client)) }));
  if (!a || !b || failures > 0) return;

  await check('wrong password, duplicate account and weak password are refused', async () => {
    const wrong = await client().auth.signInWithPassword({ email: a.email, password: 'not the password' });
    expect(wrong.error?.code === 'invalid_credentials', `wrong password: ${wrong.error?.code ?? 'accepted'}`);
    const duplicate = await client().auth.signUp({ email: a.email, password: password() });
    expect(duplicate.error?.code === 'user_already_exists', `duplicate: ${duplicate.error?.code ?? 'accepted'}`);
    const weak = await client().auth.signUp({ email: `smoke-${randomBytes(4).toString('hex')}@example.com`, password: 'password1' });
    expect(weak.error?.code === 'weak_password', `weak: ${weak.error?.code ?? 'accepted'}`);
  });
  await check('change password: the old one stops working', async () => {
    const next = password();
    const { error } = await a.client.auth.updateUser({ password: next });
    expect(!error, `change failed: ${error?.message}`);
    expect((await client().auth.signInWithPassword({ email: a.email, password: a.password })).error, 'the old password still works');
    expect(!(await client().auth.signInWithPassword({ email: a.email, password: next })).error, 'the new password does not work');
  });
  await accountChecks(a, b);
}

async function accountChecks(a: Runner, b: Runner) {
  await check('save both profiles', async () => {
    for (const r of [a, b]) {
      await r.api.saveProfile({
        alias: `Smoke${randomBytes(3).toString('hex')}`,
        units: 'metric',
        goalDays: 3,
        notificationTz: 'America/Chicago',
        ackEligibility: true,
      });
    }
    return `get_me → ${(await a.api.getMe()).profile?.alias ?? 'no profile'}`;
  });

  let runId = '';
  await check('upload a run through the app client: +77 XP', async () => {
    const fresh = (await a.api.listMyRuns(null, 1)).runs.length === 0;
    const activeMs = 1_888_000;
    const run = steadyRun(Date.now() - 30 * 60_000 - activeMs, 5246, activeMs / 1000);
    const chunks = chunk(run.points).map((points, seq) => {
      const body = encodeChunk(points);
      return { seq, body, checksum: createHash('sha256').update(body).digest('hex') };
    });
    const started = await a.api.startRunUpload({
      clientRunId: randomUUID(),
      startedAtMs: run.startedAt,
      endedAtMs: run.endedAt,
      segments: run.segments,
      clientDistanceM: run.truthDistanceM,
      clientActiveMs: activeMs,
      expectedPoints: run.points.length,
      expectedChunks: chunks.length,
      title: 'Smoke test',
      interrupted: false,
    });
    for (const c of chunks) await a.api.putRouteChunk(started.run_id, c.seq, c.body, c.checksum);
    const result = await a.api.finalizeRun(
      started.run_id,
      started.version,
      chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
    );
    runId = result.run.id;
    const xp = result.run.xp_award;
    expect(result.run.status === 'accepted', `run ${result.run.status}`);
    expect(!fresh || xp?.total_xp === 77, `expected +77 XP on a first run, got ${JSON.stringify(xp)}`);
    return `${chunks.length} chunks, ${run.points.length} points, ${JSON.stringify(xp)}`;
  });

  await check("runners can't read each other's runs", async () => {
    expect(runId, 'no run was uploaded');
    await rejectsWith(b.api.getMyRun(runId), 'not_found');
    await rejectsWith(b.api.getMyRunRoute(runId), 'not_found');
    expect(!(await b.api.listMyRuns(null, 20)).runs.some((r) => r.id === runId), "the run is in the other runner's history");
    expect((await a.api.getMyRun(runId)).id === runId, 'the owner cannot read the run');
  });
  await check('private functions are not exposed', async () => {
    const { data } = await b.client.auth.getSession();
    const res = await raw('/rest/v1/rpc/set_flag', data.session?.access_token ?? null, key, { p_key: 'competition_enabled', p_enabled: false });
    expect(res.status === 404 && res.body?.code === 'PGRST202', `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  });
  await check('refresh rotates the session', async () => {
    const before = (await a.client.auth.getSession()).data.session;
    const { data, error } = await a.client.auth.refreshSession();
    expect(!error && data.session, `refresh failed: ${error?.message}`);
    expect(data.session.refresh_token !== before?.refresh_token, 'refresh token did not rotate');
    await a.api.getMe();
  });
  await check('request deletion of both accounts', async () => {
    const states = [await a.api.requestAccountDeletion(), await b.api.requestAccountDeletion()];
    expect(
      states.every((s) => s.state === 'queued' || s.state === 'running' || s.state === 'completed'),
      JSON.stringify(states),
    );
    return states.map((s) => s.state).join(', ');
  });
  await check('logout ends the session', async () => {
    const refreshToken = (await a.client.auth.getSession()).data.session?.refresh_token;
    expect(refreshToken, 'no session');
    expect(!(await a.client.auth.signOut()).error, 'logout failed');
    const { error } = await client().auth.refreshSession({ refresh_token: refreshToken });
    expect(error, 'the refresh token still works after logout');
  });
}

async function main() {
  expect(/^https?:\/\//.test(url) && key, 'set SMOKE_API_URL and SMOKE_API_KEY');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'send') return send();
  if (command === 'verify') await verify(args);
  else if (command === undefined) await passwords();
  else throw new Error('usage: api-smoke.ts [send | verify <codeA> <codeB>]');
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
