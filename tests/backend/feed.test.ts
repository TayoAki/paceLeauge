import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { backdateMembership, inCurrentWeek, runAt, uploadRun } from './helpers/runs';

/**
 * The feed with kudos and comments (docs/ROADMAP.md 4.4), and push notifications and moderation at
 * scale (4.9), through the RPCs the app and the API service call.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const publicId = async (user: TestUser) => (await db.rpc(user, 'get_social_settings')).public_id as string;

/** An IANA zone where it is now `hour` o'clock, so quiet hours don't depend on when tests run. */
function zoneAtHour(hour: number): string {
  const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

/** A runner with a phone that can receive pushes, where it's the middle of the day. */
async function withDevice(user: TestUser, platform: 'ios' | 'android' = 'ios'): Promise<string> {
  const token = `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;
  await db.rpc(user, 'register_push_token', { p_token: token, p_platform: platform });
  await db.sql('update public.profiles set notification_tz = $2 where user_id = $1', [user.id, zoneAtHour(12)]);
  return token;
}

async function outbox(user: TestUser) {
  return db.sql<{ kind: string; title: string; body: string; url: string; actors: number; sent_at: Date | null; dropped_at: Date | null; send_after: Date }>(
    'select kind, title, body, url, actors, sent_at, dropped_at, send_after from private.push_outbox where user_id = $1 order by id',
    [user.id],
  );
}

/** Claims every due push (making the user's pending ones due first) and returns those for `tokens`. */
async function claim(tokens: string[], users: TestUser[] = []) {
  if (users.length > 0) {
    await db.sql('update private.push_outbox set send_after = now() where user_id = any($1) and sent_at is null and dropped_at is null', [users.map((u) => u.id)]);
  }
  const rows = await db.sql<{ outbox_id: string; token: string; platform: string; title: string; body: string; url: string; kind: string }>(
    'select * from private.claim_push_batch(500)',
  );
  return rows.filter((r) => tokens.includes(r.token));
}

async function follow(follower: TestUser, followee: TestUser) {
  await db.rpc(follower, 'follow_runner', { p_public_id: await publicId(followee) });
  await db.rpc(followee, 'respond_follow', { p_public_id: await publicId(follower), p_accept: true });
}

// Runs one runner uploads at the same moment are duplicates, so each run gets its own hour.
let slot = 0;

async function sharedRun(owner: TestUser, visibility: string, options: { day?: number; map?: boolean; title?: string } = {}) {
  const start = options.day !== undefined ? inCurrentWeek(options.day) : inCurrentWeek(slot % 7, Math.floor(slot / 7) % 14);
  slot++;
  const { runId } = await uploadRun(db, owner, runAt(start, 4000, 1400), { title: options.title ?? 'Morning run' });
  await db.rpc(owner, 'set_run_sharing', { p_run_id: runId, p_visibility: visibility, p_map_shared: options.map ?? false });
  return runId;
}

async function crew(ownerAlias: string, memberAliases: string[]) {
  const owner = await db.createRunner(ownerAlias);
  await db.rpc(owner, 'create_league', { p_name: `${ownerAlias} crew` });
  const invite = await db.rpc(owner, 'create_league_invite');
  const members: TestUser[] = [];
  for (const alias of memberAliases) {
    const m = await db.createRunner(alias);
    await db.rpc(m, 'join_league', { p_code: invite.code });
    members.push(m);
  }
  const view = await db.rpc(owner, 'get_my_league');
  const idOf = (alias: string) => view.standings.find((s: { alias: string }) => s.alias === alias).member_id as string;
  return { owner, members, idOf };
}

const feedIds = async (user: TestUser) => ((await db.rpc(user, 'get_feed')).items as { run_id: string }[]).map((i) => i.run_id);

describe('feed', () => {
  it('shows my runs, runs followers may see from people I follow and league runs from league-mates, newest first', async () => {
    const { owner: leo, members } = await crew('Leo League', ['Lia Mate']);
    const [lia] = members as [TestUser];
    const fay = await db.createRunner('Fay Followed');
    const stranger = await db.createRunner('Stu Stranger');
    await follow(leo, fay);

    const fayFollowers = await sharedRun(fay, 'followers', { day: 1, map: true });
    const fayPrivate = await sharedRun(fay, 'only_me', { day: 2 });
    const fayLeagues = await sharedRun(fay, 'leagues', { day: 3 });
    const liaLeagues = await sharedRun(lia, 'leagues', { day: 4 });
    const leoOwn = await sharedRun(leo, 'only_me', { day: 5 });
    const strangerEveryone = await sharedRun(stranger, 'everyone', { day: 6 });

    // Fay's league-only run isn't Leo's to see (they share no league); a stranger's public run
    // isn't in the feed because Leo doesn't follow them.
    expect(await feedIds(leo)).toEqual([leoOwn, liaLeagues, fayFollowers]);
    expect(await feedIds(lia)).toEqual([liaLeagues]);
    expect(await feedIds(fay)).toEqual([fayLeagues, fayPrivate, fayFollowers]);
    expect(await feedIds(stranger)).toEqual([strangerEveryone]);

    // Cards carry the shared map only when it's shared, and kudos and comment counts.
    const items = (await db.rpc(leo, 'get_feed')).items as any[];
    expect(items.find((i) => i.run_id === fayFollowers)).toMatchObject({ owner: { alias: 'Fay Followed' }, kudos: 0, kudoed: false, comments: 0, is_mine: false });
    expect(items.find((i) => i.run_id === fayFollowers).route).not.toBeNull();
    expect(items.find((i) => i.run_id === liaLeagues).route).toBeNull();

    // Pages follow on from the last item.
    const first = await db.rpc(leo, 'get_feed', { p_limit: 2 });
    expect(first.items.map((i: any) => i.run_id)).toEqual([leoOwn, liaLeagues]);
    const second = await db.rpc(leo, 'get_feed', { p_limit: 2, p_before_ms: first.next.before_ms, p_before_id: first.next.before_id });
    expect(second.items.map((i: any) => i.run_id)).toEqual([fayFollowers]);
    expect(second.next).toBeNull();

    // Muting leaves someone's runs out of the feed.
    await db.rpc(leo, 'mute_runner', { p_public_id: await publicId(lia), p_muted: true });
    expect(await feedIds(leo)).toEqual([leoOwn, fayFollowers]);
  });
});

describe('kudos and comments', () => {
  it('gives kudos, comments and replies in one-level threads', async () => {
    const ann = await db.createRunner('Ann Author');
    const bo = await db.createRunner('Bo Buddy');
    const cy = await db.createRunner('Cy Crew');
    await follow(bo, ann);
    await follow(cy, ann);
    const runId = await sharedRun(ann, 'followers');

    await expectCode(db.rpc(ann, 'set_kudos', { p_run_id: runId, p_on: true }), 'invalid_input');
    expect(await db.rpc(bo, 'set_kudos', { p_run_id: runId, p_on: true })).toEqual({ run_id: runId, kudos: 1, kudoed: true });
    expect(await db.rpc(bo, 'set_kudos', { p_run_id: runId, p_on: true })).toMatchObject({ kudos: 1 });
    await db.rpc(cy, 'set_kudos', { p_run_id: runId, p_on: true });
    expect((await db.rpc(ann, 'list_kudos', { p_run_id: runId })).map((k: any) => k.alias)).toEqual(['Cy Crew', 'Bo Buddy']);
    expect(await db.rpc(cy, 'set_kudos', { p_run_id: runId, p_on: false })).toMatchObject({ kudos: 1, kudoed: false });

    const afterFirst = await db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: '  Great   pace!\r\n\r\n\r\n\r\nSee you Sunday  ' });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ body: 'Great pace!\n\nSee you Sunday', author: { alias: 'Bo Buddy' }, is_mine: true, can_delete: true, replies: [] });
    const top = afterFirst[0].id;
    await db.rpc(ann, 'add_comment', { p_run_id: runId, p_body: 'Thanks Bo', p_parent_id: top });
    const replyToReply = (await db.rpc(ann, 'list_comments', { p_run_id: runId }))[0].replies[0].id;
    await db.rpc(cy, 'add_comment', { p_run_id: runId, p_body: 'Count me in', p_parent_id: replyToReply });

    const thread = await db.rpc(cy, 'list_comments', { p_run_id: runId });
    expect(thread).toHaveLength(1);
    expect(thread[0].replies.map((r: any) => [r.author.alias, r.body, r.can_delete])).toEqual([
      ['Ann Author', 'Thanks Bo', false],
      ['Cy Crew', 'Count me in', true],
    ]);
    // The run's owner may delete any comment on it.
    expect((await db.rpc(ann, 'list_comments', { p_run_id: runId }))[0].can_delete).toBe(true);
    expect((await db.rpc(bo, 'get_shared_run', { p_run_id: runId })).comments).toBe(3);

    // Someone who can't see the run can't read, comment on or give kudos to it.
    const outsider = await db.createRunner('Out Sider');
    await expectCode(db.rpc(outsider, 'list_comments', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(outsider, 'add_comment', { p_run_id: runId, p_body: 'hi' }), 'not_found');
    await expectCode(db.rpc(outsider, 'set_kudos', { p_run_id: runId, p_on: true }), 'not_found');
    await expectCode(db.rpc(outsider, 'delete_comment', { p_comment_id: top }), 'not_found');

    // Deleting the first comment keeps its replies under a placeholder.
    await db.rpc(bo, 'delete_comment', { p_comment_id: top });
    const after = await db.rpc(cy, 'list_comments', { p_run_id: runId });
    expect(after[0]).toMatchObject({ removed: true, body: null, author: null });
    expect(after[0].replies).toHaveLength(2);
    expect((await db.rpc(cy, 'get_shared_run', { p_run_id: runId })).comments).toBe(2);
    const stored = await db.one<{ body: string | null; removed_by: string }>('select body, removed_by from private.comments where id = $1', [top]);
    expect(stored).toEqual({ body: null, removed_by: 'author' });
  });

  it('filters comments for links, blocked words and hidden characters, and limits bursts', async () => {
    const ann = await db.createRunner('Ann Filter');
    const bo = await db.createRunner('Bo Filter');
    await follow(bo, ann);
    const runId = await sharedRun(ann, 'followers');
    await db.sql(`insert into private.blocked_terms (term) values ('jerkface') on conflict do nothing`);

    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'you jerkface!' }), 'comment_not_allowed');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'JERKFACE' }), 'comment_not_allowed');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'cheap shoes at shoe-deals.com' }), 'comment_not_allowed');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'see https://example.test/x' }), 'comment_not_allowed');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'hidden​text' }), 'invalid_input');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: '   ' }), 'invalid_input');
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'x'.repeat(501) }), 'invalid_input');
    // Whole words only: a longer word that contains a blocked one is fine, and so is a pace.
    await db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'jerkfaces is a word now. 5.30/km pace!' });

    // Eight comments a minute at most (this minute's and the next one's windows are filled, so the
    // check doesn't depend on when the test runs).
    for (let i = 1; i < 8; i++) await db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: `Comment ${i}` });
    await db.sql(
      `insert into private.rate_limits (bucket, window_start, hits)
       select 'comment_burst:' || $1::text, to_timestamp(floor(extract(epoch from now()) / 60) * 60 + s), 8 from unnest(array[0, 60]) s
       on conflict (bucket, window_start) do update set hits = 8`,
      [bo.id],
    );
    await expectCode(db.rpc(bo, 'add_comment', { p_run_id: runId, p_body: 'One too many' }), 'rate_limited');
  });
});

describe('reporting, blocking and deleting remove content everywhere', () => {
  it('hides a reported comment from the reporter, and holds it for everyone after three reports', async () => {
    const owner = await db.createRunner('Rae Runner');
    const troll = await db.createRunner('Tro Commenter');
    const r1 = await db.createRunner('Rep One');
    const r2 = await db.createRunner('Rep Two');
    const r3 = await db.createRunner('Rep Three');
    for (const u of [troll, r1, r2, r3]) await follow(u, owner);
    const runId = await sharedRun(owner, 'followers');
    const [comment] = await db.rpc(troll, 'add_comment', { p_run_id: runId, p_body: 'Nobody cares' });

    await expectCode(db.rpc(r1, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'rude' }), 'invalid_input');
    await expectCode(db.rpc(troll, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'spam' }), 'not_found');
    const report = await db.rpc(r1, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'harassment' });
    expect(report.status).toBe('open');
    expect(report.due_at_ms - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    // Reporting again is the same report.
    expect((await db.rpc(r1, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'spam' })).report_id).toBe(report.report_id);

    expect(await db.rpc(r1, 'list_comments', { p_run_id: runId })).toEqual([]);
    expect((await db.rpc(r1, 'get_feed')).items.find((i: any) => i.run_id === runId).comments).toBe(0);
    expect(await db.rpc(r2, 'list_comments', { p_run_id: runId })).toHaveLength(1);

    await db.rpc(r2, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'harassment' });
    await db.rpc(r3, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'harassment' });
    // Held: gone for everyone but its author until a moderator looks.
    expect(await db.rpc(owner, 'list_comments', { p_run_id: runId })).toEqual([]);
    expect((await db.rpc(owner, 'get_shared_run', { p_run_id: runId })).comments).toBe(0);
    expect(await db.rpc(troll, 'list_comments', { p_run_id: runId })).toHaveLength(1);
  });

  it('hides a reported run from the reporter in the feed, on the profile and by link', async () => {
    const owner = await db.createRunner('Run Reported');
    const viewer = await db.createRunner('Run Reporter');
    await follow(viewer, owner);
    const runId = await sharedRun(owner, 'everyone');
    expect(await feedIds(viewer)).toContain(runId);
    await db.rpc(viewer, 'report_content', { p_kind: 'run', p_id: runId, p_reason: 'cheating' });
    expect(await feedIds(viewer)).not.toContain(runId);
    expect((await db.rpc(viewer, 'get_runner_profile', { p_public_id: await publicId(owner) })).runs).toEqual([]);
    await expectCode(db.rpc(viewer, 'get_shared_run', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(viewer, 'set_kudos', { p_run_id: runId, p_on: true }), 'not_found');
  });

  it('takes a blocked runner’s kudos and comments away, both ways', async () => {
    const owner = await db.createRunner('Blo Owner');
    const pest = await db.createRunner('Pes Blocked');
    const friend = await db.createRunner('Fri Friend');
    await follow(pest, owner);
    await follow(friend, owner);
    const runId = await sharedRun(owner, 'followers');
    await db.rpc(pest, 'set_kudos', { p_run_id: runId, p_on: true });
    const [top] = await db.rpc(friend, 'add_comment', { p_run_id: runId, p_body: 'Nice one' });
    await db.rpc(pest, 'add_comment', { p_run_id: runId, p_body: 'Meh', p_parent_id: top.id });
    await db.rpc(pest, 'add_comment', { p_run_id: runId, p_body: 'Still meh' });

    await db.rpc(owner, 'block_runner', { p_public_id: await publicId(pest) });
    const seen = await db.rpc(owner, 'get_shared_run', { p_run_id: runId });
    expect(seen).toMatchObject({ kudos: 0, comments: 1 });
    expect(await db.rpc(owner, 'list_kudos', { p_run_id: runId })).toEqual([]);
    const threads = await db.rpc(owner, 'list_comments', { p_run_id: runId });
    expect(threads.map((t: any) => [t.body, t.replies.length])).toEqual([['Nice one', 0]]);
    // The blocked runner loses the run everywhere.
    expect(await feedIds(pest)).not.toContain(runId);
    await expectCode(db.rpc(pest, 'list_comments', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(pest, 'add_comment', { p_run_id: runId, p_body: 'hello?' }), 'not_found');
  });

  it('removes a deleted run, and an account being deleted, from every view', async () => {
    const owner = await db.createRunner('Del Owner');
    const fan = await db.createRunner('Del Fan');
    const leaving = await db.createRunner('Del Leaving');
    await follow(fan, owner);
    await follow(leaving, owner);
    const runId = await sharedRun(owner, 'followers');
    await db.rpc(leaving, 'set_kudos', { p_run_id: runId, p_on: true });
    await db.rpc(leaving, 'add_comment', { p_run_id: runId, p_body: 'Bye all' });
    expect(await db.rpc(fan, 'get_shared_run', { p_run_id: runId })).toMatchObject({ kudos: 1, comments: 1 });

    await db.rpc(leaving, 'request_account_deletion', {}, { recentAuth: true });
    expect(await db.rpc(fan, 'get_shared_run', { p_run_id: runId })).toMatchObject({ kudos: 0, comments: 0 });
    expect(await db.rpc(fan, 'list_comments', { p_run_id: runId })).toEqual([]);

    const { version } = await db.rpc(owner, 'get_my_run', { p_run_id: runId });
    await db.rpc(owner, 'delete_run', { p_run_id: runId, p_expected_version: version });
    expect(await feedIds(fan)).not.toContain(runId);
    expect(await feedIds(owner)).not.toContain(runId);
    await expectCode(db.rpc(fan, 'list_comments', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(fan, 'get_shared_run', { p_run_id: runId }), 'not_found');
  });
});

describe('push notifications', () => {
  it('queues every type, and every type can be switched off', async () => {
    const { owner: host, members, idOf } = await crew('Pus Host', ['Pus Mate']);
    const [mate] = members as [TestUser];
    const hostToken = await withDevice(host);
    const mateToken = await withDevice(mate);
    expect(await db.rpc(host, 'get_notification_settings')).toEqual({
      available: false,
      prefs: { kudos: true, comments: true, follows: true, cheers: true, results: true, league: true },
      devices: 1,
    });

    // Each type, once with it on and once with it off.
    const kinds: { kind: string; to: TestUser; fire: (n: number) => Promise<unknown> }[] = [
      {
        kind: 'follows',
        to: host,
        fire: async () => {
          const fan = await db.createRunner(`Fol Fan ${randomUUID().slice(0, 4)}`);
          await db.rpc(fan, 'follow_runner', { p_public_id: await publicId(host) });
        },
      },
      {
        kind: 'kudos',
        to: host,
        fire: async () => {
          const runId = await sharedRun(host, 'leagues');
          await db.rpc(mate, 'set_kudos', { p_run_id: runId, p_on: true });
        },
      },
      {
        kind: 'comments',
        to: host,
        fire: async () => {
          const runId = await sharedRun(host, 'leagues');
          await db.rpc(mate, 'add_comment', { p_run_id: runId, p_body: 'Strong finish' });
        },
      },
      {
        kind: 'cheers',
        to: mate,
        fire: async (n) => {
          // Cheers are once a week per pair: start each round from a clean slate.
          await db.sql('delete from private.cheers where from_user = $1', [host.id]);
          await db.sql('delete from private.push_dedupe where key like $1', [`cheer:%`]);
          await db.rpc(host, 'cheer_member', { p_member_id: idOf('Pus Mate') });
          return n;
        },
      },
    ];
    for (const { kind, to, fire } of kinds) {
      await db.rpc(to, 'set_notification_prefs', { p_prefs: { [kind]: false } });
      await fire(0);
      expect((await outbox(to)).filter((o) => o.kind === kind)).toHaveLength(0);
      await db.rpc(to, 'set_notification_prefs', { p_prefs: { [kind]: true } });
      await fire(1);
      expect((await outbox(to)).filter((o) => o.kind === kind)).toHaveLength(1);
    }
    expect((await db.rpc(host, 'get_notification_settings')).prefs).toEqual({ kudos: true, comments: true, follows: true, cheers: true, results: true, league: true });

    const sent = await claim([hostToken, mateToken], [host, mate]);
    expect(sent.map((s) => [s.kind, s.title, s.body, s.url]).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      ['cheers', 'You got a cheer', 'Pus Host cheered you on this week.', '/league'],
      ['comments', 'New comment on “Morning run”', 'Pus Mate: Strong finish', expect.stringMatching(/^\/shared\//)],
      ['follows', 'Follow request', expect.stringMatching(/^Fol Fan .{4} wants to follow you\.$/), '/profile/people'],
      ['kudos', 'Kudos', 'Pus Mate gave you kudos for “Morning run”.', expect.stringMatching(/^\/shared\//)],
    ]);

    await expectCode(db.rpc(host, 'set_notification_prefs', { p_prefs: { kudos: 'yes' } }), 'invalid_input');
    await expectCode(db.rpc(host, 'set_notification_prefs', { p_prefs: { marketing: true } }), 'invalid_input');
    await expectCode(db.rpc(host, 'register_push_token', { p_token: 'not-a-token', p_platform: 'ios' }), 'invalid_input');
  });

  it('sends week results once the week is final, to members who ran', async () => {
    const { owner, members } = await crew('Res Owner', ['Res Runner', 'Res Resting']);
    const [runner, resting] = members as [TestUser, TestUser];
    const tokens = [await withDevice(owner), await withDevice(runner), await withDevice(resting)];
    for (const u of [owner, runner, resting]) await backdateMembership(db, u, Date.parse('2026-08-01T00:00:00Z'));
    const monday = Date.parse('2026-08-31T12:00:00Z');
    await uploadRun(db, owner, steadyRun(monday, 5_250, 1888));
    await uploadRun(db, runner, steadyRun(monday, 6_450, 2342));

    // Not before the week is final (Tuesday 00:00 Chicago), nor long after.
    expect(await db.one<{ n: number }>(`select private.enqueue_week_results('2026-09-07T20:00:00Z') as n`)).toEqual({ n: 0 });
    expect(await db.one<{ n: number }>(`select private.enqueue_week_results('2026-09-11T20:00:00Z') as n`)).toEqual({ n: 0 });
    await db.sql(`select private.enqueue_week_results('2026-09-08T11:00:00Z')`);
    await db.sql(`select private.enqueue_week_results('2026-09-08T11:05:00Z')`); // once per league and week

    const sent = await claim(tokens, [owner, runner, resting]);
    expect(sent.map((s) => [s.token === tokens[0] ? 'owner' : s.token === tokens[1] ? 'runner' : 'resting', s.title, s.body]).sort()).toEqual([
      ['owner', 'Week results', 'You finished 2nd of 3 in Res Owner crew with 77 XP. A new week has started.'],
      ['runner', 'Week results', 'You finished 1st of 3 in Res Owner crew with 89 XP. A new week has started.'],
    ]);
  });

  it('merges a burst of kudos, waits out quiet hours and drops pushes that should no longer go', async () => {
    const owner = await db.createRunner('Bur Owner');
    const fans = [await db.createRunner('Bur Fan A'), await db.createRunner('Bur Fan B'), await db.createRunner('Bur Fan C')];
    const token = await withDevice(owner);
    for (const fan of fans) await follow(fan, owner);
    // Follow pushes aren't what this test is about.
    await db.sql('delete from private.push_outbox where user_id = $1', [owner.id]);

    const runId = await sharedRun(owner, 'followers');
    for (const fan of fans) await db.rpc(fan, 'set_kudos', { p_run_id: runId, p_on: true });
    // Off and on again isn't a second push.
    await db.rpc(fans[0]!, 'set_kudos', { p_run_id: runId, p_on: false });
    await db.rpc(fans[0]!, 'set_kudos', { p_run_id: runId, p_on: true });
    const queued = await outbox(owner);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.actors).toBe(3);
    // Kudos wait two minutes for others to join them.
    expect(queued[0]!.send_after.getTime() - Date.now()).toBeGreaterThan(60_000);
    const [merged] = await claim([token], [owner]);
    expect(merged!.body).toBe('Bur Fan C and 2 others gave you kudos for “Morning run”.');
    await db.sql(`select private.push_delivered($1, $2)`, [merged!.outbox_id, JSON.stringify([{ id: 'ticket-1', token }])]);

    // At 02:00 where the runner is, a push waits until 07:00.
    await db.sql('update public.profiles set notification_tz = $2 where user_id = $1', [owner.id, zoneAtHour(2)]);
    const [first] = await db.rpc(fans[1]!, 'add_comment', { p_run_id: runId, p_body: 'Night owl' });
    const night = (await outbox(owner)).at(-1)!;
    const wait = night.send_after.getTime() - Date.now();
    expect(wait).toBeGreaterThan(3.9 * 3_600_000);
    expect(wait).toBeLessThanOrEqual(5 * 3_600_000);
    await db.sql('update public.profiles set notification_tz = $2 where user_id = $1', [owner.id, zoneAtHour(12)]);

    // A deleted comment, a block and a switched-off type each drop a waiting push.
    await db.rpc(fans[1]!, 'delete_comment', { p_comment_id: first.id });
    await db.rpc(fans[2]!, 'add_comment', { p_run_id: runId, p_body: 'Blocked soon' });
    await db.rpc(owner, 'block_runner', { p_public_id: await publicId(fans[2]!) });
    const cheerless = await db.createRunner('Bur Follower');
    await db.rpc(cheerless, 'follow_runner', { p_public_id: await publicId(owner) });
    await db.rpc(owner, 'set_notification_prefs', { p_prefs: { follows: false } });
    expect(await claim([token], [owner])).toEqual([]);
    const final = await outbox(owner);
    expect(final.filter((o) => o.dropped_at !== null).map((o) => o.kind).sort()).toEqual(['comments', 'comments', 'follows']);
    expect(final.filter((o) => o.sent_at !== null)).toHaveLength(1);

    // An uninstalled app's token goes.
    await db.sql('select private.push_token_gone($1)', [token]);
    expect((await db.rpc(owner, 'get_notification_settings')).devices).toBe(0);
    expect(await db.sql('select * from private.push_receipts where token = $1', [token])).toEqual([]);
  });

  it('moves a token to whoever signs in on the phone, and keeps ten devices at most', async () => {
    const first = await db.createRunner('Tok First');
    const second = await db.createRunner('Tok Second');
    const token = await withDevice(first);
    await db.rpc(second, 'register_push_token', { p_token: token, p_platform: 'android' });
    expect((await db.rpc(first, 'get_notification_settings')).devices).toBe(0);
    expect((await db.rpc(second, 'get_notification_settings')).devices).toBe(1);
    for (let i = 0; i < 11; i++) await withDevice(second);
    expect((await db.rpc(second, 'get_notification_settings')).devices).toBe(10);
    expect(await db.rpc(first, 'unregister_push_token', { p_token: token })).toEqual({ removed: false });
  });
});

describe('moderation', () => {
  it('acts on reports within the response target in a drill', async () => {
    // Reports from the tests above aren't part of the drill.
    await db.sql('delete from private.reports');
    const owner = await db.createRunner('Mod Owner');
    const author = await db.createRunner('Mod Author');
    const reporter = await db.createRunner('Mod Reporter');
    const second = await db.createRunner('Mod Second');
    for (const u of [author, reporter, second]) await follow(u, owner);
    const runId = await sharedRun(owner, 'followers');
    const [comment] = await db.rpc(author, 'add_comment', { p_run_id: runId, p_body: 'Get lost' });
    const onComment = await db.rpc(reporter, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'harassment' });
    await db.rpc(second, 'report_content', { p_kind: 'comment', p_id: comment.id, p_reason: 'offensive_content' });
    const onRun = await db.rpc(reporter, 'report_content', { p_kind: 'run', p_id: runId, p_reason: 'cheating' });
    const onRunner = await db.rpc(reporter, 'report_content', { p_kind: 'runner', p_id: await publicId(author), p_reason: 'impersonation' });

    const moderator = await db.createRunner('Mod Staff');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'moderation drill', 'ops-test')`, [moderator.id]);
    const queue = await db.rpc(moderator, 'mod_list_reports');
    expect(queue).toHaveLength(4);
    const commentReport = queue.find((r: any) => r.report_id === onComment.report_id);
    expect(commentReport).toMatchObject({
      target_kind: 'comment',
      reason_code: 'harassment',
      content_snapshot: { alias: 'Mod Author', body: 'Get lost', run_title: 'Morning run' },
      overdue: false,
      open_on_target: 2,
      target_state: { removed: false, held: false },
      actions: ['dismiss', 'remove_comment', 'reset_alias'],
    });
    expect(commentReport.due_at_ms - commentReport.created_at_ms).toBe(24 * 3_600_000);
    expect(queue.find((r: any) => r.report_id === onRun.report_id).content_snapshot).not.toHaveProperty('route');
    expect(JSON.stringify(queue)).not.toMatch(/@example\.test|points/);

    await expectCode(db.rpc(moderator, 'mod_resolve_report', { p_report_id: onRunner.report_id, p_action: 'hide_run', p_reason: 'wrong kind' }), 'invalid_input');
    const removed = await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onComment.report_id, p_action: 'remove_comment', p_reason: 'Harassment' });
    expect(removed).toEqual({ report_id: onComment.report_id, status: 'actioned', also_resolved: 1, within_target: true });
    expect(await db.rpc(owner, 'list_comments', { p_run_id: runId })).toEqual([]);
    expect(await db.rpc(author, 'list_comments', { p_run_id: runId })).toEqual([]);

    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onRun.report_id, p_action: 'hide_run', p_reason: 'Car-speed splits' });
    expect(await feedIds(second)).not.toContain(runId);
    expect(await feedIds(owner)).toContain(runId);
    expect((await db.rpc(owner, 'get_my_run', { p_run_id: runId })).visibility).toBe('only_me');
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onRunner.report_id, p_action: 'dismiss', p_reason: 'Not impersonating' });

    const health = await db.rpc(moderator, 'mod_queue_health');
    expect(health).toMatchObject({ response_target_hours: 24, open: 0, overdue: 0, resolved_7d: 4, resolved_within_target_7d: 4 });
    const audit = await db.sql<{ action: string }>('select action from private.moderation_actions where moderator_id = $1 order by id', [moderator.id]);
    expect(audit.map((a) => a.action)).toEqual(['remove_comment', 'hide_run', 'dismiss']);

    // A report past its target shows up in the queue and the health report.
    const late = await db.rpc(second, 'report_content', { p_kind: 'runner', p_id: await publicId(author), p_reason: 'spam' });
    await db.sql(`update private.reports set created_at = now() - interval '30 hours', due_at = now() - interval '6 hours' where id = $1`, [late.report_id]);
    expect((await db.rpc(moderator, 'mod_list_reports'))[0]).toMatchObject({ report_id: late.report_id, overdue: true });
    expect(await db.rpc(moderator, 'mod_queue_health')).toMatchObject({ open: 1, overdue: 1 });
    expect((await db.one<{ h: any }>('select private.health_report() as h')).h).toMatchObject({ overdue_reports: 1 });
    expect((await db.rpc(moderator, 'mod_resolve_report', { p_report_id: late.report_id, p_action: 'dismiss', p_reason: 'Late drill' })).within_target).toBe(false);
    await expectCode(db.rpc(owner, 'mod_queue_health'), 'not_staff');
  });
});

describe('export', () => {
  it('includes my comments, kudos and notification choices', async () => {
    const owner = await db.createRunner('Exp Owner');
    const fan = await db.createRunner('Exp Fan');
    await follow(fan, owner);
    const runId = await sharedRun(owner, 'followers');
    await db.rpc(fan, 'set_kudos', { p_run_id: runId, p_on: true });
    await db.rpc(fan, 'add_comment', { p_run_id: runId, p_body: 'Exported words' });
    await db.rpc(fan, 'set_notification_prefs', { p_prefs: { results: false } });
    const social = (await db.one<{ x: any }>('select private.social_export($1) as x', [fan.id])).x;
    expect(social.comments).toEqual([{ run_id: runId, reply: false, body: 'Exported words', created_at_ms: expect.any(Number), removed_by: null }]);
    expect(social.kudos_given).toEqual([{ run_id: runId, created_at_ms: expect.any(Number) }]);
    expect(social.notifications).toEqual({ prefs: { kudos: true, comments: true, follows: true, cheers: true, results: false, league: true }, devices: 0 });
  });
});
