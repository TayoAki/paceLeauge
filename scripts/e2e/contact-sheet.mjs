#!/usr/bin/env node
// Lays out walkthrough screenshots side by side, like the packet's design boards.
//   node scripts/e2e/contact-sheet.mjs <out.png|out.jpg> "<title>" <shot.png> [<shot.png> …]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

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

const [out, title, ...files] = process.argv.slice(2);
if (!out || !title || files.length === 0) {
  console.error('usage: contact-sheet.mjs <out.png> "<title>" <shot.png> [...]');
  process.exit(2);
}

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const figures = files
  .map(
    (file) =>
      `<figure><img src="data:image/png;base64,${readFileSync(file).toString('base64')}"><figcaption>${escape(basename(file, '.png'))}</figcaption></figure>`,
  )
  .join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 28px 32px; background: #f4f1e8; font: 14px -apple-system, system-ui, sans-serif; color: #101315; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 0.02em; }
  p { margin: 0 0 20px; color: #555; letter-spacing: 0.12em; text-transform: uppercase; font-size: 11px; }
  main { display: flex; gap: 22px; }
  figure { margin: 0; }
  img { width: 300px; display: block; border-radius: 28px; border: 6px solid #101315; }
  figcaption { margin-top: 8px; color: #555; font-size: 12px; text-align: center; }
</style></head><body><h1>${escape(title)}</h1><p>Web preview · development backend · fictional data</p><main>${figures}</main></body></html>`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: files.length * 322 + 42, height: 800 }, deviceScaleFactor: 1 });
await page.setContent(html);
// .jpg keeps committed evidence small; .png is lossless.
await page.screenshot({ path: out, fullPage: true, ...(/\.jpe?g$/i.test(out) ? { type: 'jpeg', quality: 82 } : {}) });
await browser.close();
console.log(`wrote ${out}`);
