#!/usr/bin/env node
// Selfcheck for this camofox stack. Proves what the old camoufox-mcp selfcheck
// proved, plus the two failure modes we had fixed by hand in that repo:
//   1. two clients share ONE browser (tabs/cookies survive an agent reload)
//   2. the browser coming back after the user closes it / kills it
//   3. a second server never starts on the same port
//
//   node local/selfcheck.mjs                    # against the running server
//   CAMOFOX_PORT=9378 node local/selfcheck.mjs  # against another port
//
// Exits non-zero on failure.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENVFILE = join(REPO, 'local/camofox.env');

// Load our env file exactly like the ctl/service do (bash), but let variables
// already in the environment win, so a test port override survives.
const fromFile = spawnSync('bash', ['-c', 'set -a; . "$1"; env -0', 'bash', ENVFILE], { encoding: 'utf8' });
for (const entry of (fromFile.stdout || '').split('\0')) {
  const i = entry.indexOf('=');
  if (i <= 0) continue;
  const k = entry.slice(0, i);
  if (process.env[k] === undefined) process.env[k] = entry.slice(i + 1);
}

const HOST = process.env.CAMOFOX_BIND_HOST || '127.0.0.1';
const PORT = Number(process.env.CAMOFOX_PORT || 8788);
const USER = process.env.CAMOFOX_USER_ID || 'pi';
const BASE = `http://${HOST}:${PORT}`;
const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`ok   ${m}`);

// --- process scoping: kill OUR browser only, never another stack's ----------
const proc = (pid) => {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[1]);
    return { pid: Number(pid), cmd, ppid };
  } catch { return null; }
};
const allPids = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d));
const hasAncestor = (pid, want) => {
  for (let p = pid, i = 0; p > 1 && i < 20; i++) {
    if (want.has(p)) return true;
    const info = proc(p);
    if (!info) return false;
    p = info.ppid;
  }
  return false;
};
const ownBrowsers = () => {
  const servers = new Set(
    // match on the checkout dir name: $HOME/gitrepos may be a symlink here
    allPids().map(proc).filter((p) => p && /camofox-browser\/server\.js/.test(p.cmd)).map((p) => p.pid),
  );
  return allPids()
    .map(proc)
    .filter((p) => p && /camoufox-bin|camoufox\/camoufox/.test(p.cmd) && hasAncestor(p.pid, servers))
    .map((p) => p.pid);
};

// --- stdio MCP client: exactly what an agent spawns ------------------------
function mcpClient(label) {
  const child = spawn(process.execPath, [join(REPO, 'mcp/server.mjs')], {
    env: { ...process.env, CAMOFOX_PORT: String(PORT), CAMOFOX_USER_ID: USER },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  let id = 0;
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const timer = setTimeout(() => reject(new Error(`${label}: ${method} timed out`)), 120000);
    waiters.set(myId, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`${label}: ${method} -> ${JSON.stringify(m.error)}`));
      resolve(m.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  return {
    label,
    init: async () => {
      await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: label, version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call: async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = (r.content || [])
        .map((c) => c.text ?? (c.data ? `<${c.type} ${c.data.length} b64 chars>` : ''))
        .join('');
      if (r.isError) throw new Error(`${label}: ${name} -> ${text.slice(0, 200)}`);
      return text;
    },
    tools: async () => (await rpc('tools/list', {})).tools.map((t) => t.name),
    close: () => child.kill(),
  };
}

const tabIdOf = (text) => {
  try {
    const j = JSON.parse(text);
    return j.tabId || j.tab_id || j.id || (j.tab && j.tab.tabId);
  } catch {
    return (text.match(/"tabId"\s*:\s*"([^"]+)"/) || [])[1];
  }
};

const callRetrying = async (client, name, args, attempts = 8) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await client.call(name, args); } catch (e) { last = e; await sleep(1500); }
  }
  throw last;
};

// ---------------------------------------------------------------------------
const main = async () => {
  const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  if (!h?.ok) return fail(`no healthy server at ${BASE}`);
  ok(`health ok (tabs=${h.activeTabs}, browserConnected=${h.browserConnected})`);
  if (process.env.CAMOFOX_CRASH_REPORT_ENABLED !== 'false') {
    fail('CAMOFOX_CRASH_REPORT_ENABLED is not false (upstream telemetry defaults on)');
  } else ok('telemetry disabled');
  if (process.env.CAMOFOX_BIND_HOST !== '127.0.0.1') fail(`bound to ${process.env.CAMOFOX_BIND_HOST}, not loopback`);
  else ok('loopback bind');

  const a = mcpClient('a');
  await a.init();
  const tools = await a.tools();
  if (tools.length < 25) fail(`only ${tools.length} tools, expected >=25`);
  else ok(`${tools.length} camofox_* tools`);
  if (!tools.every((t) => t.startsWith('camofox_'))) fail('unexpected non-camofox tool name');

  const created = await a.call('camofox_create_tab', { url: 'https://example.com' });
  const tabId = tabIdOf(created);
  if (!tabId) return fail(`create_tab returned no tabId: ${created.slice(0, 200)}`);
  const h2 = await fetch(`${BASE}/health`).then((r) => r.json());
  if (!h2.browserConnected) fail('browser did not connect after create_tab');
  else ok(`created tab ${tabId} (browser connected)`);

  const snap = await a.call('camofox_snapshot', { tabId });
  if (!/example\.com/i.test(snap)) fail(`snapshot lacks example.com content: ${snap.slice(0, 120)}`);
  else ok('snapshot');

  const shot = await a.call('camofox_screenshot', { tabId });

  const shotBytes = Number((shot.match(/<image (\d+) b64 chars>/) || [])[1] || 0);
  if (shotBytes < 10000) fail(`screenshot too small or missing: ${shot.slice(0, 80)}`);
  else ok(`screenshot ${Math.round(shotBytes / 1024)} KiB png`);

  // Second, independent client = what a reloaded agent session sees.
  const b = mcpClient('b');
  await b.init();
  const tabs = await b.call('camofox_list_tabs', {});
  if (!/example\.com/i.test(tabs)) fail(`fresh client does not see the shared tab: ${tabs.slice(0, 200)}`);
  else ok('fresh client sees the same tab (shared browser)');
  const title = await b.call('camofox_evaluate', { tabId, expression: 'document.title' });
  if (!/example/i.test(title)) fail(`fresh client cannot read the shared page: ${title.slice(0, 120)}`);
  else ok('fresh client reads the shared page');

  // Failure mode 1: the browser dies (user closed the window, OOM, kill).
  const victims = ownBrowsers();
  if (!victims.length) fail('no browser process of this checkout found, relaunch test skipped');
  else {
    for (const v of victims) { try { process.kill(v, 'SIGKILL'); } catch {} }
    console.log(`     killed ${victims.length} browser process(es) of this checkout`);
    const back = await callRetrying(b, 'camofox_create_tab', { url: 'https://example.com' })
      .catch((e) => `BROKEN ${e.message}`);
    if (back.startsWith('BROKEN')) fail(`browser did not come back after a kill: ${back.slice(0, 160)}`);
    else ok('browser relaunched after being killed');
  }

  // Failure mode 2: a second server must not start on the same port/profile.
  const ctl = spawnSync(join(REPO, 'local/camofox-ctl'), ['ensure'], { encoding: 'utf8' });
  const ctlOut = `${ctl.stdout}${ctl.stderr}`.trim();
  if (/started:/.test(ctlOut)) fail(`ctl ensure started a second server: ${ctlOut}`);
  else ok('ctl ensure is idempotent');

  a.close(); b.close();
  console.log(failures.length ? `\nFAIL: ${failures.join('; ')}` : '\nPASS: shared persistent Camoufox verified');
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
