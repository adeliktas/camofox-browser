#!/usr/bin/env node
// One-time migration: old camoufox-mcp Firefox profile cookies.sqlite ->
// camofox-browser Netscape cookie file (read at session bootstrap).
//
//   node local/import-old-cookies.mjs [--from ~/.local/share/camoufox-mcp/profile/cookies.sqlite]
//                                     [--to   $CAMOFOX_COOKIES_DIR/cookies.txt]
//                                     [--dry-run]
//
// The profile itself cannot be reused: camofox launches with firefox.launch()
// and persists cookie/localStorage state as JSON per user, so only cookies
// carry over. Logins that rely on localStorage need a fresh sign-in.
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const FROM = arg('from', join(homedir(), '.local/share/camoufox-mcp/profile/cookies.sqlite'));
const TO = arg('to', join(process.env.CAMOFOX_COOKIES_DIR || join(homedir(), '.camofox/cookies'), 'cookies.txt'));
const DRY = process.argv.includes('--dry-run');

if (!statSync(FROM, { throwIfNoEntry: false })) {
  console.error(`no cookie database at ${FROM} (pass --from)`);
  process.exit(1);
}
// Firefox holds the DB open; read a copy so a running browser cannot block us.
const tmp = join(tmpdir(), `moz-cookies-${process.pid}.sqlite`);
copyFileSync(FROM, tmp);
const db = new Database(tmp, { readonly: true });
const rows = db.prepare(
  `SELECT host, path, isSecure, expiry, name, value, isHttpOnly
     FROM moz_cookies ORDER BY host, name`,
).all();
db.close();

const line = (c) => [
  `${c.isHttpOnly ? '#HttpOnly_' : ''}${c.host}`,
  c.host.startsWith('.') ? 'TRUE' : 'FALSE',
  c.path || '/',
  c.isSecure ? 'TRUE' : 'FALSE',
  // Firefox can store expiry in ms (13 digits); Playwright wants unix seconds.
  c.expiry > 1e11 ? Math.floor(c.expiry / 1000) : Math.max(0, Math.floor(c.expiry || 0)),
  c.name,
  c.value,
].join('\t');

const text = `# Netscape HTTP Cookie File\n# imported from ${FROM}\n${rows.map(line).join('\n')}\n`;
if (DRY) {
  console.log(text.split('\n').slice(0, 6).join('\n'));
  console.log(`... ${rows.length} cookies, dry run, nothing written`);
} else {
  mkdirSync(dirname(TO), { recursive: true });
  writeFileSync(TO, text, { mode: 0o600 });
  console.log(`wrote ${rows.length} cookies -> ${TO}`);
  console.log('camofox imports them at session bootstrap, i.e. only for a user id with no saved state yet.');
}
