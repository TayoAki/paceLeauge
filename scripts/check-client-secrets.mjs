#!/usr/bin/env node
// Guards the rule that the app bundle only ever holds public configuration (REQ-014):
//   • app code (src/, app.config.ts, index.ts) never references a service-role/secret key,
//     the Auth admin API, a database driver or server-only code, and never hardcodes a JWT;
//   • app code only reads EXPO_PUBLIC_* variables, and none of them is named like a secret;
//   • no tracked file contains a private key block or a Supabase secret API key.
// Exits non-zero with a list of findings. Run by `npm run check:secrets` and in CI.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Folders .gitignore leaves out, for builds without git (the web app's Docker image). */
const UNTRACKED_DIRS = new Set(['node_modules', 'dist', 'dist-web', 'web-build', 'coverage', 'artifacts', 'playwright-report', 'test-results']);
/** Generated native projects, ignored only at the root: the ios and android folders in modules/ are source. */
const UNTRACKED_ROOT_DIRS = new Set(['ios', 'android']);

/** The files git would commit; where there's no git or repository, every file outside those folders and hidden ones. */
function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const skipped =
          UNTRACKED_DIRS.has(entry.name) || (dir === root && UNTRACKED_ROOT_DIRS.has(entry.name)) || (entry.name.startsWith('.') && entry.name !== '.github');
        if (entry.isDirectory()) {
          if (!skipped) walk(path);
        } else if (entry.isFile()) {
          found.push(relative(root, path).split(sep).join('/'));
        }
      }
    };
    walk(root);
    return found;
  }
}

const files = listFiles().filter((f) => existsSync(resolve(root, f)) && statSync(resolve(root, f)).isFile());

const isAppCode = (f) => (/^src\/.*\.(ts|tsx|js|jsx)$/.test(f) && !/__tests__\//.test(f)) || f === 'app.config.ts' || f === 'index.ts';
const isText = (f) => !/\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|zip|pdf|mp4|db|sqlite)$/i.test(f);

// [pattern, finding, appliesToComments]
const APP_RULES = [
  [/service[_-]?role/i, 'mentions the service role', false],
  [/SUPABASE_(SERVICE|SECRET)|SERVICE_KEY|JWT_SECRET/, 'references a privileged key variable'],
  [/\bsb_secret_/, 'contains a Supabase secret API key'],
  [/\.auth\.admin\b/, 'uses the Auth admin API'],
  [/from\s+['"](pg|postgres|node:[a-z_]+)['"]|require\(\s*['"](pg|postgres|node:[a-z_]+)['"]\s*\)/, 'imports a server-only module'],
  [/from\s+['"][./]*(scripts|server|db|tests)\//, 'imports server or test code'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'hardcodes a JWT (keys must come from the environment)'],
];
const REPO_RULES = [
  [/-----BEGIN ((RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/, 'contains a private key'],
  [/\bsb_secret_[A-Za-z0-9_-]{16,}/, 'contains a Supabase secret API key'],
];

const findings = [];
for (const file of files.filter(isText)) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const lines = text.split('\n');
  const rules = isAppCode(file) ? [...APP_RULES, ...REPO_RULES] : REPO_RULES;
  lines.forEach((line, i) => {
    const comment = /^\s*(\/\/|\/?\*)/.test(line);
    for (const [pattern, why, inComments = true] of rules) {
      if ((inComments || !comment) && pattern.test(line)) findings.push(`${file}:${i + 1} ${why}`);
    }
    if (!isAppCode(file) || file === 'app.config.ts') return;
    for (const match of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = match[1];
      if (!name.startsWith('EXPO_PUBLIC_') && name !== 'NODE_ENV') findings.push(`${file}:${i + 1} reads non-public variable ${name}`);
    }
  });
  if (isAppCode(file) || file === '.env.example') {
    for (const match of text.matchAll(/EXPO_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE|PRIVATE|PASSWORD)[A-Z0-9_]*/g)) {
      findings.push(`${file} defines a secret-looking public variable ${match[0]}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`✗ Client secret check failed (${findings.length}):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ Client secret check passed (${files.length} files; app code holds public configuration only).`);
