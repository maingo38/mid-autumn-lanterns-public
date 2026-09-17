'use strict';
// Spawn the real server.js in an isolated env (temp DB, random port, guest auth)
// and expose its base URL. No product code is modified; tests talk over HTTP.
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Start a fresh server. `env` overrides merge over the isolated defaults.
async function startServer(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ml-test-'));
  const dbPath = path.join(dir, 'lanterns.db');
  const port = 30000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      GUEST_MODE: '1',
      AI_RENDER: '0',
      SESSION_SECRET: 'test-secret',
      TZ: 'Asia/Ho_Chi_Minh',
      FIRE_PER_FAN: '3',
      // default OFF; individual tests re-launch with GAMES_UNLIMITED when needed
      ...env,
    },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', d => { if (process.env.TEST_DEBUG) process.stderr.write(d); });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return {
    base, dbPath, port,
    async stop() {
      child.kill('SIGKILL');
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server did not become healthy in time');
}

module.exports = { startServer, ROOT };
