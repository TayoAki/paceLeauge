import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

import { competitionWeekAt } from '../../src/domain/calendar';
import { destinationPoint } from '../../src/domain/geo';
import { chunk, encodeChunk } from '../../src/domain/route-codec';
import { deriveCues, toRoutePoint, type RoutePoint } from '../../src/domain/routes';
import { buildSyntheticRun, CHICAGO_LAKEFRONT, steadyRun, type SyntheticRun } from '../../src/domain/synthetic';

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
      [-20, km(5.1), 1790],
      [-13, km(5.3), 1850],
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
      [-20, km(5.4), 1880],
      [-13, km(5.6), 1960],
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
      [-19, km(5), 1830],
      [-12, km(5.2), 1905],
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
      [-18, km(4.8), 1760],
      [-11, km(5.1), 1870],
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

async function upload(pool: pg.Pool, claims: Claims, [dayOffset, distanceM, activeS, title]: DemoRun, weekStart: number): Promise<string | null> {
  const startAt = weekStart + dayOffset * DAY_MS + 7 * 3_600_000 + Math.round((distanceM % 997) * 1000);
  return uploadRun(pool, claims, steadyRun(startAt, distanceM, activeS), activeS, title);
}

/** Uploads a synthetic run through the real protocol; null when it would end in the future. */
async function uploadRun(pool: pg.Pool, claims: Claims, run: SyntheticRun, activeS: number, title?: string): Promise<string | null> {
  const startAt = run.startedAt;
  if (run.endedAt > Date.now()) return null;
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
  return start.run_id;
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
  // Teen accounts (docs/ROADMAP.md 4.10), switched on for development only: Kai (16) is in the
  // family league, approved by the viewer; Noa (14) is waiting for approval.
  await pool.query(`select private.set_flag('teen_accounts_enabled', true, 'Development seed', 'dev-seed')`);
  for (const [alias, signal, approve] of [
    ['Kai', 'teen_16_17', true],
    ['Noa', 'teen_13_15', false],
  ] as const) {
    const claims = await ensureRunner(pool, { alias, email: `${alias.toLowerCase()}@demo.paceleague.test` });
    await rpc(pool, claims, 'record_age_signal', { p_signal: signal, p_source: 'guardianDeclared' });
    const request = await rpc<{ id: string }>(pool, claims, 'request_family_join', { p_code: familyInvite.code });
    if (approve) {
      await rpc(pool, viewer, 'decide_family_request', { p_request_id: request.id, p_approve: true });
      await upload(pool, claims, [-1, km(3.1), 1150, 'Sunday run'], weekStart);
    }
  }
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
    // Challenges (docs/ROADMAP.md 4.6): the club's points challenge this month, joined by a few.
    const clubChallenge = await rpc<{ id: string }>(pool, maya, 'create_challenge', { p_metric: 'capped_score', p_target: 500, p_club_id: clubRow.id });
    for (const claims of [viewer, ...friends.slice(1, 3).map((f) => f.claims)]) await rpc(pool, claims, 'join_challenge', { p_challenge_id: clubChallenge.id });
  }
  // The viewer's league has a days challenge, and the viewer is in this month's twelve days.
  const leagueChallenge = await rpc<{ id: string }>(pool, viewer, 'create_challenge', {
    p_metric: 'active_days',
    p_target: 10,
    p_title: 'Ten Days Together',
    p_league_id: league.league.id,
  });
  for (const f of friends.slice(0, 3)) await rpc(pool, f.claims, 'join_challenge', { p_challenge_id: leagueChallenge.id });
  const monthly = await rpc<{ current: { id: string; scope: string; metric: string }[] }>(pool, viewer, 'list_challenges');
  const twelveDays = monthly.current.find((c) => c.scope === 'global' && c.metric === 'active_days');
  if (twelveDays) await rpc(pool, viewer, 'join_challenge', { p_challenge_id: twelveDays.id });

  // Leaderboards (docs/ROADMAP.md 4.7): four friends joined, with accounts old enough and weeks of
  // runs enough to appear. The viewer hasn't joined, so won last week's league and is invited.
  for (const alias of ['Maya', 'Jules', 'Theo', 'Rin']) {
    const claims = byAlias.get(alias);
    if (!claims) continue;
    await pool.query(`update public.profiles set created_at = now() - interval '40 days' where user_id = $1`, [claims.sub]);
    await rpc(pool, claims, 'join_leaderboards', { p_country: 'US' });
  }
  await pool.query('select private.refresh_leaderboards()');

  // Planned routes (docs/ROADMAP.md 5.1): a drawn loop from where the demo runs start.
  const corners: [number, number][] = [
    [0, 800],
    [90, 600],
    [180, 800],
    [270, 600],
  ];
  const loop: RoutePoint[] = [toRoutePoint(CHICAGO_LAKEFRONT)];
  let corner = CHICAGO_LAKEFRONT;
  for (const [bearing, m] of corners) {
    corner = destinationPoint(corner, bearing, m);
    loop.push(toRoutePoint(corner));
  }
  await rpc(pool, viewer, 'save_route', {
    p_route_id: null,
    p_name: 'Loop round the park',
    p_kind: 'drawn',
    p_points: loop,
    p_cues: deriveCues(loop),
    p_ascent_m: null,
  });

  await seedSegments(pool, weekStart);

  console.log(
    `[seed] ${options.viewerEmail} ("${options.viewerAlias ?? 'Alex'}") owns "Friday Crew" with ${FRIENDS.length} friends and a family league, with a club and challenges; ${uploaded} runs uploaded${skipped ? `, ${skipped} future runs skipped` : ''}.`,
  );
}

/** Runners on the segment boards, outside the viewer's league: [day offset from this week's Monday, speed in m/s]. */
const SEGMENT_RUNNERS: (Member & { runs: [number, number][] })[] = [
  // The local regular: the most different days.
  { alias: 'Priya', email: 'priya@demo.paceleague.test', runs: [[-12, 3.4], [-9, 3.5], [-6, 3.5], [-2, 3.6]] },
  // The quickest.
  { alias: 'Marco', email: 'marco@demo.paceleague.test', runs: [[-8, 4.4], [-3, 4.5]] },
  { alias: 'Lena', email: 'lena@demo.paceleague.test', runs: [[-5, 3.8]] },
];

/**
 * Segments (docs/ROADMAP.md 5.3): a moderator (Rowan, staff@demo.paceleague.test) made two
 * segments from routes along the demo runs' line east of the lakefront start. Three runners
 * outside the viewer's league joined the boards and share their runs with everyone, maps
 * included; one of Zed's times was faster than a runner could go, so it waits in the
 * moderation queue. The viewer hasn't joined.
 */
async function seedSegments(pool: pg.Pool, weekStart: number): Promise<void> {
  const staff = await ensureRunner(pool, { alias: 'Rowan', email: 'staff@demo.paceleague.test' });
  await pool.query(`select private.grant_staff_role($1, 'moderator', 'Development seed', 'dev-seed')`, [staff.sub]);
  const east = (m: number) => toRoutePoint(destinationPoint(CHICAGO_LAKEFRONT, 90, m));
  for (const [name, from, to] of [
    ['Park straight', 500, 1500],
    ['Harbor stretch', 1700, 2500],
  ] as const) {
    const route = await rpc<{ id: string }>(pool, staff, 'save_route', {
      p_route_id: null,
      p_name: name,
      p_kind: 'drawn',
      p_points: [east(from), east(to)],
      p_cues: [],
      p_ascent_m: null,
    });
    await rpc(pool, staff, 'mod_create_segment', { p_route_id: route.id, p_name: name, p_surface: 'path' });
  }

  const share = async (claims: Claims, runId: string | null) => {
    if (runId) await rpc(pool, claims, 'set_run_sharing', { p_run_id: runId, p_visibility: 'everyone', p_map_shared: true });
  };
  for (const runner of SEGMENT_RUNNERS) {
    const claims = await ensureRunner(pool, runner);
    await rpc(pool, claims, 'join_segments');
    for (const [dayOffset, speed] of runner.runs) {
      const activeS = Math.round(3000 / speed);
      await share(claims, await upload(pool, claims, [dayOffset, 3000, activeS, 'Morning run'], weekStart));
    }
  }
  // Zed: an easy run with the first segment at 7.5 m/s, held for a moderator.
  const zed = await ensureRunner(pool, { alias: 'Zed', email: 'zed@demo.paceleague.test' });
  await rpc(pool, zed, 'join_segments');
  const startAt = weekStart - 4 * DAY_MS + 18 * 3_600_000;
  const legs = [
    { kind: 'run' as const, durationS: 150, speedMps: 3 },
    { kind: 'run' as const, durationS: 150, speedMps: 7.5 },
    { kind: 'run' as const, durationS: 500, speedMps: 3 },
  ];
  // One stretch: the legs join up without a pause (each leg's first fix repeats the last one).
  const built = buildSyntheticRun({ startAt, legs });
  const run: SyntheticRun = {
    ...built,
    segments: [{ index: 0, startAt: built.startedAt, endAt: built.endedAt }],
    points: built.points.filter((p, i, all) => i === 0 || p.t > all[i - 1]!.t).map((p, seq) => ({ ...p, seq, segmentIndex: 0 })),
  };
  await share(zed, await uploadRun(pool, zed, run, 800, 'Evening run'));
  await pool.query('select private.process_segment_matches(1000)');
}
