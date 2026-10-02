import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Privacy Policy and Terms, written in Markdown under legal/ and served as plain HTML pages
 * at /legal/privacy and /legal/terms (the app and App Store Connect link to them), and the support
 * page App Store Connect's Support URL points at, served at /support. Only a small Markdown subset
 * is used — headings, paragraphs, lists, bold and links — and all text is escaped first. A
 * document that still contains [placeholders] is marked as a draft on the page.
 */
export type LegalDoc = 'privacy' | 'terms' | 'support';

const SOURCES: Record<LegalDoc, { file: string; title: string; draft: string }> = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy', draft: 'This document still has details to fill in and is not yet in effect.' },
  terms: { file: 'terms.md', title: 'Terms of Service', draft: 'This document still has details to fill in and is not yet in effect.' },
  support: { file: 'support.md', title: 'Support', draft: 'This page still has details to fill in.' },
};

const PLACEHOLDER = /\[[^\]\n]+\](?!\()/;

/** legal/ sits next to db/ — in the repository and in the API image alike. */
export function legalDir(dbDir: string): string {
  return join(dirname(dbDir), 'legal');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|mailto:|\/(?!\/))[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    if (list) out.push(`<ul>\n${list.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`);
    paragraph = [];
    list = null;
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const item = /^[-*] (.+)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item) {
      if (paragraph.length > 0) flush();
      (list ??= []).push(item[1]!);
    } else if (list && /^\s/.test(raw)) {
      // An indented line continues the previous list item.
      list[list.length - 1] += ` ${line}`;
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return out.join('\n');
}

function page(title: string, body: string, draft: string | null): string {
  const banner = draft ? `<p class="draft"><strong>Draft.</strong> ${draft}</p>\n` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — PaceLeague</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #15191b; --muted: #50585d; --link: #3f5f00; --note: #f3f7e1; }
@media (prefers-color-scheme: dark) { :root { --bg: #101315; --fg: #f5f3ea; --muted: #b9bdb6; --link: #d5ff45; --note: #272e33; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; overflow-wrap: anywhere; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 0.5rem; }
h2 { font-size: 1.25rem; margin: 2.2rem 0 0.5rem; }
h3 { font-size: 1.05rem; margin: 1.6rem 0 0.4rem; }
a { color: var(--link); }
li { margin: 0.3rem 0; }
.draft { background: var(--note); padding: 0.75rem 1rem; border-radius: 0.5rem; }
</style>
</head>
<body>
<main>
${banner}${body}
</main>
</body>
</html>
`;
}

/** Rendered pages for the documents present in `dir` (missing files are simply not served). */
export function loadLegalPages(dir: string): Partial<Record<LegalDoc, string>> {
  const pages: Partial<Record<LegalDoc, string>> = {};
  for (const [doc, { file, title, draft }] of Object.entries(SOURCES) as [LegalDoc, (typeof SOURCES)[LegalDoc]][]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const markdown = readFileSync(path, 'utf8');
    pages[doc] = page(title, renderMarkdown(markdown), PLACEHOLDER.test(markdown) ? draft : null);
  }
  return pages;
}
