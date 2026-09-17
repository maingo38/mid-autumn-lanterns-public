'use strict';
// Wave 3 — Regression (RG-1..RG-5).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, admin, client } = require('./helpers/auth');
const { seedLantern, seedFire, seedPlay, todayVN } = require('./helpers/seed');
const { connectScreen } = require('./helpers/screen');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// RG-1 — earning fire (spin) does NOT emit a rank/fire socket event anymore
// (emitOwnerFire is a no-op). We assert a spin succeeds and no 'new-lantern' or
// fire event is required for the wallet to update.
test('RG-1 spin updates wallet without a fire socket event', async () => {
  const g = await guest(srv.base, 'rg1');
  const call = client(srv.base, g.cookie);
  const screen = connectScreen(srv.base);
  await screen.ready;
  let sawFire = false;
  screen.sock.onAny(evt => { if (/fire/i.test(evt)) sawFire = true; });
  const sp = await call('POST', '/api/spin', {});
  assert.equal(sp.status, 200);
  assert.ok(sp.data.wallet.earned >= sp.data.reward);
  await new Promise(r => setTimeout(r, 200));
  screen.close();
  assert.equal(sawFire, false, 'no fire/rank socket event on earn');
});

// RG-2 — the legacy `fires` table is dropped each boot; user fire lives in
// spins/games. A fresh spin still yields balance from spins.
test('RG-2 fire comes from spins/games, not a fires table', async () => {
  const g = await guest(srv.base, 'rg2');
  const call = client(srv.base, g.cookie);
  seedFire(srv.dbPath, g.sub, 6);
  const w = await call('GET', '/api/wallet');
  assert.equal(w.data.wallet.earned, 6);
  assert.equal(w.data.wallet.balance, 6);
});

// RG-3 — /api/testing toggles GAMES_UNLIMITED (admin only now). ON then OFF; the
// per-day gate restores after OFF (a game played under unlimited doesn't block
// a normal day because rows are timestamped while unlimited).
test('RG-3 admin toggles GAMES_UNLIMITED on then off', async () => {
  const a = await admin(srv.base);
  const acall = client(srv.base, a.cookie);
  let r = await acall('POST', '/api/testing', { on: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.testing, true);
  r = await acall('POST', '/api/testing', { on: false });
  assert.equal(r.data.testing, false);
  const state = await (await fetch(srv.base + '/api/testing')).json();
  assert.equal(state.testing, false);
});

// RG-4 — streak bonus is granted once at the day-3 milestone, not re-granted on
// later spins. Seed 2 prior distinct days, then spin today (3rd distinct day):
// bonus +3 fires once.
test('RG-4 streak bonus granted once at milestone', async () => {
  const g = await guest(srv.base, 'rg4');
  const call = client(srv.base, g.cookie);
  // seed spins on 2 earlier distinct days (no bonus rows)
  const Database = require('better-sqlite3');
  const db = new Database(srv.dbPath);
  db.prepare('INSERT INTO spins (voter, day, reward, created) VALUES (?,?,?,?)').run(g.sub, '2026-01-01', 1, Date.now());
  db.prepare('INSERT INTO spins (voter, day, reward, created) VALUES (?,?,?,?)').run(g.sub, '2026-01-02', 1, Date.now());
  db.close();
  // today is the 3rd distinct day -> spin should include bonus:3
  const sp = await call('POST', '/api/spin', {});
  assert.equal(sp.data.days, 3, 'third distinct spin day');
  assert.equal(sp.data.bonus, 3, 'day-3 milestone grants +3 once');
});

// RG-5 — /api/height/finish emits height-changed with {id, height:total}.
test('RG-5 finish emits height-changed with new total', async () => {
  const g = await guest(srv.base, 'rg5');
  const call = client(srv.base, g.cookie);
  const lid = seedLantern(srv.dbPath, g.sub, { appeared: 1, height: 40 });
  const pid = seedPlay(srv.dbPath, g.sub, lid, {
    kind: 'release', finalized: 0,
    startedAt: Date.now() - 20000, endsAt: Date.now() + 5000, requestId: 'rg5',
  });
  const screen = connectScreen(srv.base);
  await screen.ready;
  const evtP = screen.waitHeightChanged(lid);
  const f = await call('POST', '/api/height/finish', { play_id: pid, hits: 3 });
  const evt = await evtP;
  screen.close();
  assert.equal(evt.id, lid);
  assert.equal(evt.height, 40 + f.data.added, 'height-changed carries the new total');
});
