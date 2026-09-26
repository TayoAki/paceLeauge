// Rasterizes the original PaceLeague "broken-lane P" monogram into the app icon assets.
// Usage: node scripts/assets/generate-icons.mjs   (needs Playwright + Chromium available)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = (name) => resolve(root, 'assets/images', name);

const BG = '#101315';
const LIME = '#D5FF45';

// The P is drawn from primitive shapes, slanted forward, with two lane cuts through the stem.
function monogram({ size, background, scale = 1 }) {
  const s = size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 1024 1024">
  ${background ? `<rect width="1024" height="1024" fill="${background}"/>` : ''}
  <g transform="translate(512 512) scale(${scale}) translate(-512 -512)">
    <g transform="translate(512 512) skewX(-12) translate(-512 -512)">
      <path fill-rule="evenodd" fill="${LIME}" d="
        M 330 230 H 610 C 725 230 800 305 800 420 C 800 535 725 610 610 610 H 470 V 794 H 330 Z
        M 470 350 V 490 H 600 C 645 490 665 460 665 420 C 665 380 645 350 600 350 Z"/>
      <g fill="${background ?? BG}">
        <rect x="310" y="660" width="170" height="26" transform="rotate(-24 395 673)"/>
        <rect x="310" y="724" width="170" height="26" transform="rotate(-24 395 737)"/>
      </g>
    </g>
  </g>
</svg>`;
}

async function render(page, svg, size, file, { transparent = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file);
}

mkdirSync(resolve(root, 'assets/images'), { recursive: true });
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
await render(page, monogram({ size: 1024, background: BG, scale: 0.78 }), 1024, out('icon.png'));
await render(page, monogram({ size: 1024, background: null, scale: 0.6 }), 1024, out('adaptive-icon.png'), {
  transparent: true,
});
await render(page, monogram({ size: 512, background: null, scale: 0.9 }), 512, out('splash-icon.png'), {
  transparent: true,
});
await render(page, monogram({ size: 64, background: BG, scale: 0.85 }), 64, out('favicon.png'));
await browser.close();
