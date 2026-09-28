/**
 * Where a push may take the runner when tapped (docs/ROADMAP.md 4.9). The server sets `url` in each
 * push's data; the app opens only these routes, whatever a payload says.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED = [
  new RegExp(`^/shared/${UUID}$`),
  new RegExp(`^/runner/${UUID}$`),
  new RegExp(`^/league/challenges/${UUID}$`),
  /^\/league$/,
  /^\/profile\/people$/,
  /^\/feed$/,
];

export function pushRoute(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const url = (data as { url?: unknown }).url;
  if (typeof url !== 'string' || url.length > 100) return null;
  return ALLOWED.some((pattern) => pattern.test(url)) ? url : null;
}
