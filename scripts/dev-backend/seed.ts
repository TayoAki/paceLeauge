import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

import { competitionWeekAt } from '../../src/domain/calendar';
import { chunk, encodeChunk } from '../../src/domain/route-codec';
import { steadyRun } from '../../src/domain/synthetic';

import { hashPassword } from '../../server/src/auth/passwords';
import { callRpc, type Claims } from '../../server/src/rpc';

/** Every seeded runner signs in with this password (development only). */
export const DEMO_PASSWORD = process.env.DEV_SEED_PASSWORD ?? 'run-with-the-crew';
let demoHash: Promise<string> | null = null;

/**
 * Fictional demo data matching the design packet (docs/packet/sample-fixtures.json): the
 * viewer ("Alex") in a private league "Friday Crew" with seven friends, 640 lifetime XP before
 * this week, Monday 6.60 km and Wednesday 6.40 km this week — so recording Friday's 5.24 km
 * run reproduces the boards (820 → 897 XP, 180 → 257 weekly, 2nd place).
 *
 * Runs go through the real upload protocol (start → chunks → finalize), so every number on
 * screen is computed by the production SQL. Runs that would end in the future are skipped.
 */

interface Member {
  alias: string;
  email: string;
}

/** A demo run: day offset from this week's Monday (negative = earlier weeks), distance, active seconds. */
type DemoRun = [dayOffset: number, distanceM: number, activeS: number, title?: string];

const DAY_MS = 86_400_000;
// Synthetic distances carry +5 m so coordinate rounding can never drop a displayed 0.01 km.
const km = (value: number) => value * 1000 + 5;

const FRIENDS: (Member & { runs: DemoRun[] })[] = [
  {
    alias: 'Maya',
    email: 'maya@demo.paceleague.test',
    runs: [
      [-6, km(6.6), 2300],
      [-4, km(6.4), 2280],
      [0, km(10), 3480],
      [1, km(6.4), 2330],
      [3, km(5), 1850],
    ],
  },
  {
    alias: 'Jules',
    email: 'jules@demo.paceleague.test',
    runs: [
      [-7, km(10), 3700],
      [-5, km(10.2), 3720],
      [-2, km(6.6), 2400],
      [0, km(6.6), 2410],
      [2, km(5.2), 1900],
      [3, km(5.2), 1880],
    ],
  },
  {
    alias: 'Theo',
    email: 'theo@demo.paceleague.test',
    runs: [
      [-3, km(5.2), 1920],
      [1, km(5.2), 1930],
      [2, km(5.2), 1925],
      [4, km(5.1), 1890],
    ],
  },
  {
    alias: 'Rin',
    email: 'rin@demo.paceleague.test',
    runs: [
      [-6, km(8), 2900],
      [0, km(6.6), 2500],
      [2, km(5), 1950],
    ],
  },
  {
    alias: 'Sam',
    email: 'sam@demo.paceleague.test',
    runs: [
      [-5, km(4.5), 1700],
      [1, km(3.9), 1500],
      [3, km(3.9), 1480],
    ],
  },
  {
    alias: 'Dev',
    email: 'dev@demo.paceleague.test',
    runs: [
      [-1, km(7), 2600],
      [2, km(5.2), 2000],
    ],
  },
  {
    alias: 'Ola',
    email: 'ola@demo.paceleague.test',
    runs: [[-4, km(3), 1200]],
  },
];

// Lifetime 640 XP before this week (4 × 125 + 91 + 49), then Monday 91 and Wednesday 89.
const VIEWER_RUNS: DemoRun[] = [
  [-13, km(10.4), 3600, 'Long run'],
  [-11, km(10.1), 3550, 'Tuesday run'],
  [-9, km(2.4), 900, 'Easy shakeout'],
  [-7, km(10.2), 3590, 'Monday run'],
  [-5, km(10.6), 3700, 'Wednesday run'],
  [-3, km(6.6), 2350, 'Friday run'],
  [0, km(6.6), 2340, 'Monday run'],
  [2, km(6.4), 2342, 'Wednesday run'],
];

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function claimsFor(userId: string, email: string): Claims {
  return {
    sub: userId,
    role: 'authenticated',
    email,
    aal: 'aal1',
    amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }],
  };
}

async function rpc<T = any>(pool: pg.Pool, claims: Claims, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await callRpc(pool, fn, args, claims, {
    'x-forwarded-for': 'seed',
  });
  if (result.status >= 300) throw new Error(`${fn}: ${JSON.stringify(result.body)}`);
  return result.body as T;
}

async function ensureRunner(pool: pg.Pool, member: Member): Promise<Claims> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.users (email, email_verified, encrypted_password) values ($1, true, $2)
     on conflict (email) do update set email = excluded.email returning id`,
    [member.email, await (demoHash ??= hashPassword(DEMO_PASSWORD))],
  );
  await pool.query(
    `insert into auth.identities (user_id, provider, provider_id, email) values ($1, 'email', $2, $2) on conflict (provider, provider_id) do nothing`,
    [rows[0]!.id, member.email],
  );
  const claims = claimsFor(rows[0]!.id, member.email);
  const me = await rpc<{ profile: unknown }>(pool, claims, 'get_me');
  if (!me.profile) {
    await rpc(pool, claims, 'save_profile', {
      p_alias: member.alias,
      p_units: 'metric',
      p_goal_days: 3,
      p_notification_tz: 'America/Chicago',
      p_ack_eligibility: true,
    });
  }
  return claims;
}

async function upload(pool: pg.Pool, claims: Claims, [dayOffset, distanceM, activeS, title]: DemoRun, weekStart: number): Promise<boolean> {
  const startAt = weekStart + dayOffset * DAY_MS + 7 * 3_600_000 + Math.round((distanceM % 997) * 1000);
  const run = steadyRun(startAt, distanceM, activeS);
  if (run.endedAt > Date.now()) return false;
  const clientRunId = randomUUID();
  const chunks = chunk(run.points).map((points, seq) => {
    const body = encodeChunk(points);
    return { seq, body, checksum: sha256Hex(body) };
  });
  const dayName = new Date(startAt).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'America/Chicago',
  });
  const start = await rpc<{ run_id: string; version: number }>(pool, claims, 'start_run_upload', {
    p_client_run_id: clientRunId,
    p_started_at_ms: run.startedAt,
    p_ended_at_ms: run.endedAt,
    p_segments: run.segments,
    p_client_distance_m: run.truthDistanceM,
    p_client_active_ms: activeS * 1000,
    p_expected_points: run.points.length,
    p_expected_chunks: chunks.length,
    p_title: title ?? `${dayName} run`,
    p_interrupted: false,
  });
  // The phone uploaded it right after the run, not today: keep the late-upload rule out of the demo.
  await pool.query('update public.runs set first_received_at = to_timestamp(($2::bigint + 60000) / 1000.0) where id = $1', [
    start.run_id,
    run.endedAt,
  ]);
  for (const c of chunks) {
    await rpc(pool, claims, 'put_route_chunk', {
      p_run_id: start.run_id,
      p_seq: c.seq,
      p_points: c.body,
      p_checksum: c.checksum,
    });
  }
  await rpc(pool, claims, 'finalize_run', {
    p_run_id: start.run_id,
    p_expected_version: start.version,
    p_manifest: chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
  });
  return true;
}

export async function seedDemo(pool: pg.Pool, options: { viewerEmail: string; viewerAlias?: string }): Promise<void> {
  const existing = await pool.query(`select 1 from auth.users u join public.profiles p on p.user_id = u.id where u.email = $1`, [
    options.viewerEmail,
  ]);
  if ((existing.rowCount ?? 0) > 0) {
    console.log(`[seed] ${options.viewerEmail} already has a profile — leaving the demo data as is (use --reset to rebuild).`);
    return;
  }
  const weekStart = competitionWeekAt(Date.now()).startsAt;
  const viewer = await ensureRunner(pool, {
    alias: options.viewerAlias ?? 'Alex',
    email: options.viewerEmail,
  });
  const league = await rpc<{ league: { id: string } }>(pool, viewer, 'create_league', { p_name: 'Friday Crew' });
  const invite = await rpc<{ code: string }>(pool, viewer, 'create_league_invite');

  const friends: { alias: string; claims: Claims; runs: DemoRun[] }[] = [];
  for (const friend of FRIENDS) {
    const claims = await ensureRunner(pool, friend);
    await rpc(pool, claims, 'join_league', { p_code: invite.code });
    // Friends share their runs with the league (docs/ROADMAP.md 4.2); Maya shares her maps too.
    // The viewer keeps the defaults: runs visible only to them.
    await rpc(pool, claims, 'set_social_settings', {
      p_default_visibility: 'leagues',
      p_default_map_shared: friend.alias === 'Maya',
      p_follow_approval: null,
      p_discoverable: null,
    });
    friends.push({ alias: friend.alias, claims, runs: friend.runs });
  }
  // Everyone has been in the league for a few weeks, so all of this week's segments count.
  const joinedAt = weekStart - 21 * DAY_MS;
  await pool.query('update public.league_members set joined_at = to_timestamp($2::bigint / 1000.0) where league_id = $1', [
    league.league.id,
    joinedAt,
  ]);
  await pool.query('update public.leagues set created_at = to_timestamp($2::bigint / 1000.0) where id = $1', [league.league.id, joinedAt]);

  let uploaded = 0;
  let skipped = 0;
  const runs = [...VIEWER_RUNS.map((run) => ({ claims: viewer, run })), ...friends.flatMap((f) => f.runs.map((run) => ({ claims: f.claims, run })))];
  for (const { claims, run } of runs) {
    if (await upload(pool, claims, run, weekStart)) uploaded += 1;
    else skipped += 1;
  }
  // A little life in the feed (docs/ROADMAP.md 4.4): kudos and a short thread on Maya's latest run.
  const byAlias = new Map(friends.map((f) => [f.alias, f.claims]));
  const maya = byAlias.get('Maya');
  const latest = maya
    ? await pool.query<{ id: string }>(
        `select id from public.runs where owner_id = $1 and deleted_at is null and status = 'accepted' order by started_at desc limit 1`,
        [maya.sub],
      )
    : null;
  const mayaRun = latest?.rows[0]?.id;
  if (mayaRun) {
    for (const alias of ['Jules', 'Theo', 'Rin']) {
      const claims = byAlias.get(alias);
      if (claims) await rpc(pool, claims, 'set_kudos', { p_run_id: mayaRun, p_on: true });
    }
    const julesClaims = byAlias.get('Jules');
    if (julesClaims) {
      const [thread] = await rpc<{ id: string }[]>(pool, julesClaims, 'add_comment', { p_run_id: mayaRun, p_body: 'Strong finish! That last kilometre looked quick.' });
      if (thread) await rpc(pool, maya!, 'add_comment', { p_run_id: mayaRun, p_body: 'Thanks! Saving some for Sunday.', p_parent_id: thread.id });
    }
  }
  // Leagues 2.0 (docs/ROADMAP.md 4.1): a family league, Saturday's group run and a duel to answer.
  const family = await rpc<{ league: { id: string } }>(pool, viewer, 'create_league', {
    p_name: `The ${options.viewerAlias ?? 'Alex'} family`,
    p_kind: 'family',
  });
  const familyInvite = await rpc<{ code: string }>(pool, viewer, 'create_league_invite', { p_league_id: family.league.id });
  const sam = byAlias.get('Sam');
  if (sam) await rpc(pool, sam, 'join_league', { p_code: familyInvite.code });
  if (maya) {
    // The next Saturday at 08:00 in Chicago that's at least an hour away.
    let saturday = weekStart + 5 * DAY_MS + 8 * 3_600_000;
    while (saturday < Date.now() + 3_600_000) saturday += 7 * DAY_MS;
    await rpc(pool, maya, 'create_group_run', {
      p_title: 'Saturday long run',
      p_starts_at_ms: saturday,
      p_meeting_point: 'Lakefront Trail at Fullerton',
      p_notes: 'Easy pace, coffee after.',
      p_league_id: league.league.id,
    });
  }
  const jules = byAlias.get('Jules');
  const viewerMember = await pool.query<{ id: string }>('select id from public.league_members where league_id = $1 and user_id = $2 and left_at is null', [
    league.league.id,
    viewer.sub,
  ]);
  if (jules && viewerMember.rows[0]) await rpc(pool, jules, 'challenge_duel', { p_member_id: viewerMember.rows[0].id });

  // Clubs (docs/ROADMAP.md 4.5): Maya's public running club, with the viewer as an admin.
  if (maya) {
    const clubRow = await rpc<{ id: string }>(pool, maya, 'create_club', {
      p_name: 'Lakefront Striders',
      p_description: 'Easy miles on the lakefront, Tuesdays and Saturdays. Everyone welcome.',
      p_visibility: 'public',
    });
    for (const claims of [viewer, ...friends.slice(1, 5).map((f) => f.claims)]) await rpc(pool, claims, 'join_club', { p_club_id: clubRow.id });
    // Members for a few weeks, so this week's runs count on the board.
    await pool.query('update private.club_members set joined_at = to_timestamp($2::bigint / 1000.0) where club_id = $1', [clubRow.id, joinedAt]);
    const viewerInClub = await pool.query<{ id: string }>('select id from private.club_members where club_id = $1 and user_id = $2 and left_at is null', [
      clubRow.id,
      viewer.sub,
    ]);
    if (viewerInClub.rows[0]) await rpc(pool, maya, 'promote_club_admin', { p_club_id: clubRow.id, p_member_id: viewerInClub.rows[0].id });
    let tuesday = weekStart + 1 * DAY_MS + 18 * 3_600_000;
    while (tuesday < Date.now() + 3_600_000) tuesday += 7 * DAY_MS;
    await rpc(pool, maya, 'create_group_run', {
      p_title: 'Tuesday lakefront loop',
      p_starts_at_ms: tuesday,
      p_meeting_point: 'Diversey Harbor',
      p_club_id: clubRow.id,
    });
  }

  console.log(
    `[seed] ${options.viewerEmail} ("${options.viewerAlias ?? 'Alex'}") owns "Friday Crew" with ${FRIENDS.length} friends and a family league; ${uploaded} runs uploaded${skipped ? `, ${skipped} future runs skipped` : ''}.`,
  );
}
