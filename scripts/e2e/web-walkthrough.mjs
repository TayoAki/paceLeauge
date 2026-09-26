#!/usr/bin/env node
// Browser walkthrough of the real app (web development preview) against the local development
// backend. It signs in, records Friday's 5.24 km run from the design packet with a scripted
// GPS feed and a controlled clock, syncs it, visits every V1 screen, and saves screenshots.
//
//   npm run db:local && npm run dev:backend -- --reset --seed alex@demo.paceleague.test
//   EXPO_PUBLIC_SUPABASE_URL=… EXPO_PUBLIC_SUPABASE_ANON_KEY=… npx expo start --web --port 8081
//   node scripts/e2e/web-walkthrough.mjs            # APP_URL, OUT_DIR, HEADED=1 optional
//
// Web is a development preview: this proves screens, flows and server integration, not GPS
// quality or iOS background behaviour (see docs/DEVICE_TEST_PROTOCOL.md).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function loadPlaywright() {
  for (const name of ['playwright-core', 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try {
      return await import(name);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Playwright is not installed (npm i -D playwright-core).');
}

const { chromium } = await loadPlaywright();
const APP_URL = process.env.APP_URL ?? 'http://localhost:8081';
const OUT_DIR = resolve(process.env.OUT_DIR ?? 'artifacts/screenshots/web');
const VIEWER = process.env.VIEWER_EMAIL ?? 'alex@demo.paceleague.test';
const NEWCOMER = `new-${Date.now().toString(36)}@demo.paceleague.test`;
const OTP = process.env.DEV_BACKEND_OTP ?? '123456';
// Friday 25 September 2026, 06:55 in Chicago — the packet's "Friday morning" run.
const START_TIME = new Date(process.env.START_TIME ?? '2026-09-25T06:55:00-05:00');
const RUN = { distanceM: 5246, activeS: 1888 };
mkdirSync(OUT_DIR, { recursive: true });

/** Scripted geolocation: the page sees a normal Geolocation API fed by window.__geo.push(). */
const FAKE_GEO = `(() => {
  let permission = 'prompt';
  let current = null;
  let nextId = 1;
  const watchers = new Map();
  const waiting = [];
  const position = (p) => ({ coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  const geolocation = {
    getCurrentPosition(ok, fail) {
      if (permission === 'denied') { setTimeout(() => fail && fail({ code: 1, message: 'denied', PERMISSION_DENIED: 1 }), 0); return; }
      permission = 'granted';
      if (current) setTimeout(() => ok(position(current)), 0); else waiting.push(ok);
    },
    watchPosition(ok) { const id = nextId++; watchers.set(id, ok); return id; },
    clearWatch(id) { watchers.delete(id); },
  };
  Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geolocation });
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (d) => d && d.name === 'geolocation'
    ? Promise.resolve({ name: 'geolocation', state: permission, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })
    : query(d);
  window.__geo = {
    setPermission(state) { permission = state; },
    push(lat, lon, acc) {
      current = { lat, lon, acc };
      if (permission !== 'granted') return;
      const p = position(current);
      while (waiting.length) waiting.shift()(p);
      for (const cb of watchers.values()) cb(p);
    },
    watchers() { return watchers.size; },
  };
})();`;

// A tilted elliptical loop by the lake, parameterised by arc length (metres → lat/lon).
const ORIGIN = { lat: 41.8819, lon: -87.6166 };
const M_PER_DEG = (6371008.8 * Math.PI) / 180;
const loop = (() => {
  const a = 1000;
  const b = 650;
  const tilt = (20 * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= 20000; i += 1) {
    const t = (i / 20000) * 2 * Math.PI;
    const x0 = a * Math.cos(t) - a;
    const y0 = b * Math.sin(t);
    pts.push({ x: x0 * Math.cos(tilt) - y0 * Math.sin(tilt), y: x0 * Math.sin(tilt) + y0 * Math.cos(tilt) });
  }
  const cumulative = [0];
  for (let i = 1; i < pts.length; i += 1) cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cumulative[cumulative.length - 1];
  return (distance) => {
    const d = distance % total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= d) lo = mid;
      else hi = mid;
    }
    const f = (d - cumulative[lo]) / (cumulative[hi] - cumulative[lo] || 1);
    const x = pts[lo].x + f * (pts[hi].x - pts[lo].x);
    const y = pts[lo].y + f * (pts[hi].y - pts[lo].y);
    return { lat: ORIGIN.lat + y / M_PER_DEG, lon: ORIGIN.lon + x / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)) };
  };
})();

const errors = [];
let shots = 0;

async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    timezoneId: 'America/Chicago',
    locale: 'en-US',
    colorScheme: 'dark',
    hasTouch: true,
  });
  await context.addInitScript(FAKE_GEO);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Download the React DevTools|findDOMNode|shadow\*|pointerEvents/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.clock.install({ time: START_TIME });
  return { context, page };
}

async function settle(page, ms = 600) {
  // Let queued fake-clock timers (query notifications, animations) run, then paint.
  await page.clock.runFor(ms).catch(() => {});
  await page.waitForTimeout(250);
}

async function shot(page, name) {
  await settle(page);
  shots += 1;
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  console.log(`  📸 ${name}`);
}

async function step(page, title, fn) {
  console.log(`▶ ${title}`);
  try {
    await fn();
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAILED-${title.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    throw error;
  }
}

const tab = (page, name) => page.getByRole('tab', { name: new RegExp(name) }).or(page.getByRole('link', { name: new RegExp(`^${name}`) })).first();
const visible = (page, text, options = {}) => page.getByText(text, { exact: false, ...options }).first().waitFor({ state: 'visible', timeout: options.timeout ?? 20_000 });

async function signIn(page, email) {
  await page.goto(APP_URL);
  await page.getByTestId('continue-email').waitFor({ timeout: 60_000 });
  await page.getByTestId('continue-email').click();
  await page.getByTestId('email-input').fill(email);
  await page.getByTestId('send-code').click();
  await page.getByTestId('code-input').fill(OTP);
  await page.getByTestId('verify-code').click();
}

/** Waits (without advancing the test clock) until the live distance shows `distanceM`. */
async function catchUp(page, distanceM) {
  const target = Math.floor(distanceM / 10) / 100 - 0.01;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const shown = Number.parseFloat((await page.getByTestId('live-distance').innerText()).trim());
    if (shown >= target) return;
    if (Date.now() > deadline) throw new Error(`live distance stuck at ${shown} km (expected ≥ ${target})`);
    await page.waitForTimeout(200);
  }
}

async function pushFix(page, distanceM, acc = 4) {
  const p = loop(distanceM);
  await page.evaluate(([lat, lon, a]) => window.__geo.push(lat, lon, a), [p.lat, p.lon, acc]);
}

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
try {
  // ---------------------------------------------------------------- returning runner
  const { page } = await newPage(browser);

  await step(page, 'S01 welcome', async () => {
    await page.goto(APP_URL);
    await page.getByTestId('continue-email').waitFor({ timeout: 90_000 });
    await shot(page, '01-welcome');
  });

  await step(page, 'sign in with email code', async () => {
    await page.getByTestId('continue-email').click();
    await page.getByTestId('email-input').fill(VIEWER);
    await shot(page, '01b-sign-in-email');
    await page.getByTestId('send-code').click();
    await page.getByTestId('code-input').waitFor();
    await page.getByTestId('code-input').fill(OTP);
    await shot(page, '01c-sign-in-code');
    await page.getByTestId('verify-code').click();
    await page.getByTestId('start-run').waitFor({ timeout: 30_000 });
  });

  await step(page, 'S03 today before the run', async () => {
    await visible(page, '820');
    await visible(page, '2 of 3');
    await shot(page, '03-today');
  });

  await step(page, 'S04 preflight', async () => {
    await page.getByTestId('start-run').click();
    await page.getByTestId('preflight-primary').waitFor();
    await pushFix(page, 0, 30);
    await shot(page, '04a-preflight-permission');
    await page.getByTestId('preflight-primary').click();
    for (let i = 0; i < 4; i += 1) {
      await pushFix(page, 0, 4);
      await page.clock.runFor(1000);
    }
    await visible(page, 'Good');
    await shot(page, '04-preflight-ready');
  });

  await step(page, 'countdown and start', async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
    await pushFix(page, 0, 4);
    await page.getByTestId('preflight-primary').click();
    await visible(page, 'Starting in');
    await shot(page, '04b-countdown');
    for (let i = 0; i < 3; i += 1) {
      await pushFix(page, 0, 4);
      await page.clock.runFor(1000);
      await page.waitForTimeout(100);
    }
    await page.getByTestId('pause-button').waitFor({ timeout: 20_000 });
  });

  await step(page, 'S05 record 5.24 km in 31:28', async () => {
    const perSecond = RUN.distanceM / RUN.activeS;
    await pushFix(page, 0, 4);
    for (let s = 1; s <= RUN.activeS; s += 1) {
      await page.clock.runFor(1000);
      await pushFix(page, s * perSecond, s % 97 === 0 ? 9 : 4);
      // A phone delivers one fix per second; give the preview's journal time to commit each one.
      await page.waitForTimeout(40);
      if (s % 300 === 0) {
        await catchUp(page, s * perSecond);
        console.log(`    ${s}s`);
      }
      if (s === 600) await shot(page, '05a-running-early');
    }
    await catchUp(page, RUN.distanceM);
    await visible(page, '5.24');
    await shot(page, '05-running');
  });

  await step(page, 'S06 pause, then finish', async () => {
    await page.getByTestId('pause-button').click();
    await page.getByTestId('finish-button').waitFor();
    await shot(page, '06-paused');
    await page.getByTestId('finish-button').click();
    await page.getByTestId('summary-distance').waitFor({ timeout: 20_000 });
    await page.clock.resume();
  });

  await step(page, 'S07 summary with accepted XP', async () => {
    await visible(page, '+77 XP', { timeout: 45_000 });
    await visible(page, '52 distance');
    await shot(page, '07-summary');
  });

  await step(page, 'S13 share preview', async () => {
    await page.getByText('Share stats', { exact: true }).first().click();
    await page.getByTestId('share-image').waitFor();
    await shot(page, '13-share');
    await page.getByRole('button', { name: /close/i }).first().click();
    await page.getByTestId('summary-done').waitFor();
  });

  await step(page, 'S03 today after the run', async () => {
    await page.getByTestId('summary-done').click();
    await page.getByTestId('start-run').waitFor();
    await visible(page, '897');
    await visible(page, '3 of 3');
    await shot(page, '03b-today-after');
  });

  let inviteCode = null;
  await step(page, 'S09 weekly league', async () => {
    await tab(page, 'League').click();
    await visible(page, 'Friday Crew');
    await visible(page, '257');
    await shot(page, '09-league');
    await page.getByTestId('invite-friends').click();
    await visible(page, 'Invite');
    await settle(page, 1500);
    const text = await page.locator('body').innerText();
    inviteCode = /\b([0-9A-HJKMNP-TV-Z]{4}[-\s]?[0-9A-HJKMNP-TV-Z]{4})\b/.exec(text)?.[1]?.replace(/[-\s]/g, '') ?? null;
    await shot(page, '09b-invite-sheet');
    await page.keyboard.press('Escape');
    await page.getByText(/^(Done|Close)$/).first().click().catch(() => {});
  });

  await step(page, 'league rules', async () => {
    await page.goto(`${APP_URL}/league/rules`);
    await visible(page, 'best');
    await shot(page, '09c-league-rules');
    await page.goBack();
  });

  await step(page, 'S11 progress', async () => {
    await tab(page, 'Progress').click();
    await visible(page, '897');
    await visible(page, 'Friday morning');
    await shot(page, '11-progress');
  });

  await step(page, 'S12 run detail', async () => {
    await page.getByText('Friday morning', { exact: true }).first().click();
    await visible(page, 'Splits');
    await visible(page, 'Only you can see this route');
    await shot(page, '12-run-detail');
    await page.mouse.wheel(0, 900);
    await shot(page, '12b-run-detail-splits');
    await page.goBack();
  });

  await step(page, 'S14 profile and privacy', async () => {
    await tab(page, 'Profile').click();
    await page.getByTestId('profile-privacy').waitFor();
    await shot(page, '14-profile');
    await page.getByTestId('profile-privacy').click();
    await page.getByTestId('export-data').waitFor();
    await shot(page, '14b-privacy');
  });

  await step(page, 'S15 export', async () => {
    await page.getByTestId('export-data').click();
    await settle(page, 2500);
    await shot(page, '15-export');
  });

  // ---------------------------------------------------------------- newcomer
  const newcomer = await newPage(browser);
  const p2 = newcomer.page;
  await newcomer.page.clock.resume();

  await step(p2, 'S02 onboarding', async () => {
    await signIn(p2, NEWCOMER);
    await p2.getByTestId('alias-input').waitFor({ timeout: 30_000 });
    await shot(p2, '02-onboarding');
    await p2.getByTestId('alias-input').fill('Riley');
    await p2.getByTestId('eligibility-checkbox').click();
    await shot(p2, '02b-onboarding-filled');
    await p2.getByTestId('onboarding-continue').click();
    await p2.getByTestId('start-run').waitFor({ timeout: 30_000 });
    await shot(p2, '03c-today-new-runner');
  });

  await step(p2, 'S08 no league yet', async () => {
    await tab(p2, 'League').click();
    await p2.getByTestId('create-league').waitFor();
    await shot(p2, '08-league-empty');
    await p2.getByTestId('join-league').click();
    await p2.getByTestId('join-code-input').waitFor();
    await shot(p2, '08b-join-code');
  });

  if (inviteCode) {
    await step(p2, 'S10 invite preview and join', async () => {
      await p2.goto(`${APP_URL}/invite/${inviteCode}`);
      await visible(p2, 'Friday Crew', { timeout: 30_000 });
      await shot(p2, '10-invite');
      await p2.getByTestId('join-confirm').click();
      await visible(p2, 'Friday Crew');
      await visible(p2, 'Maya');
      await shot(p2, '10b-joined-league');
    });
  } else {
    errors.push('walkthrough: no invite code found on the invite sheet');
  }

  await step(p2, 'S16 delete account', async () => {
    await tab(p2, 'Profile').click();
    await p2.getByTestId('profile-privacy').click();
    await p2.getByTestId('delete-account').click();
    await settle(p2, 800);
    await shot(p2, '16-delete-account');
  });
} finally {
  await browser.close();
}

console.log(`\n${shots} screenshots in ${OUT_DIR}`);
if (errors.length) {
  console.log(`\n${errors.length} browser errors:`);
  for (const e of [...new Set(errors)]) console.log(`  ${e}`);
  process.exitCode = 1;
}
