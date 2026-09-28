#!/usr/bin/env node
// The web app as it ships (docs/ROADMAP.md P.2): a production build behind scripts/web/serve.mjs,
// against the development backend. It signs in, opens the core screens at phone and desktop
// widths, and fails on any browser error (a Content-Security-Policy violation included) or on a
// serious or critical accessibility finding from axe-core.
//
//   npm run db:local && npm run dev:backend -- --reset --seed alex@demo.paceleague.test
//   EXPO_PUBLIC_API_URL=http://127.0.0.1:54400 EXPO_PUBLIC_API_KEY=pl_dev_public_key npm run build:web
//   API_ORIGIN=http://127.0.0.1:54400 PORT=8090 npm run serve:web &
//   node scripts/e2e/web-app-check.mjs                 # APP_URL, OUT_DIR optional
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

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
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const APP_URL = process.env.APP_URL ?? 'http://localhost:8090';
const OUT_DIR = resolve(process.env.OUT_DIR ?? 'artifacts/screenshots/web-app');
const EMAIL = process.env.VIEWER_EMAIL ?? 'alex@demo.paceleague.test';
const PASSWORD = process.env.VIEWER_PASSWORD ?? 'run-with-the-crew';
mkdirSync(OUT_DIR, { recursive: true });

const SCREENS = [
  { path: '/', wait: 'This week', name: 'home' },
  { path: '/run/preflight', wait: 'Record runs with the PaceLeague app.', name: 'record-in-app' },
  { path: '/progress', wait: 'Recent runs', name: 'progress' },
  { path: '/progress/stats', wait: 'Stats and trends', name: 'stats' },
  { path: '/progress/records', wait: 'Personal records', name: 'records' },
  { path: '/league', wait: 'League', name: 'league' },
  { path: '/feed', wait: 'Maya', name: 'feed' },
  { path: '/league/challenges', wait: 'For everyone', name: 'challenges' },
  { path: '/league/leaderboards', wait: 'best three days', name: 'leaderboards' },
  { path: '/train', wait: 'Train', name: 'train' },
  { path: '/profile', wait: 'Profile', name: 'profile' },
  { path: '/profile/privacy', wait: 'Export', name: 'privacy' },
  { path: '/profile/run-settings', wait: 'Run settings', name: 'run-settings' },
  { path: '/profile/notifications', wait: 'Friends and league', name: 'notifications' },
  { path: '/progress/calendar', wait: 'Calendar', name: 'calendar' },
  { path: '/progress/training', wait: 'Training', name: 'training' },
  { path: '/pro', wait: 'Train further with Pro', name: 'pro' },
];

const problems = [];
const browser = await chromium.launch();
for (const viewport of [
  { width: 390, height: 844, label: 'phone' },
  { width: 1280, height: 860, label: 'desktop' },
]) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${viewport.label}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${viewport.label}: console: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${viewport.label}: HTTP ${r.status()} ${r.url()}`);
  });
  const visible = (text) => page.getByText(text, { exact: false }).filter({ visible: true }).first();

  await page.goto(APP_URL);
  await page.getByTestId('continue-email').first().waitFor({ timeout: 60_000 });
  await page.getByTestId('continue-email').first().click();
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.getByTestId('email-input').filter({ visible: true }).first().fill(EMAIL);
  await page.getByTestId('password-input').filter({ visible: true }).first().fill(PASSWORD);
  await page.getByTestId('password-submit').filter({ visible: true }).first().click();
  await page.getByTestId('start-run').first().waitFor({ timeout: 30_000 });

  for (const screen of SCREENS) {
    await page.goto(`${APP_URL}${screen.path}`);
    await visible(screen.wait).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(OUT_DIR, `${viewport.label}-${screen.name}.png`) });
    // Through the debugger rather than a <script> tag, which the app's CSP rightly refuses.
    await page.evaluate(AXE);
    const result = await page.evaluate(async () => {
      // Screens stacked behind the visible one are hidden from assistive technology already.
      const report = await globalThis.axe.run(document, { resultTypes: ['violations'] });
      return report.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
    });
    for (const v of result) problems.push(`${viewport.label} ${screen.name}: axe ${v.impact} ${v.id} — ${v.help} (${v.nodes.join(', ')})`);
    console.log(`${viewport.label} ${screen.name}: ${result.length === 0 ? 'ok' : `${result.length} finding(s)`}`);
  }
  await context.close();
}
await browser.close();

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nThe web app passed: no browser errors, no serious accessibility findings.');
