'use strict';
// Wave 2 — Unit (U-1..U-10): fire→fan-play→height conversion logic, exercised
// through /api/height/state and /api/wallet with seeded DB state.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire, seedPlay } = require('./helpers/seed');

let srv;
// GAMES_UNLIMITED so mini-game earn endpoints are unlocked regardless of EVENT_START.
before(async () => { srv = await startServer({ GAMES_UNLIMITED: '1' }); });
after(async () => { await srv.stop(); });

async function userWith({ fire = 0, appeared = 1, lantern = true } = {}) {
  const u = await guest(srv.base, 'U' + Math.random().toString(36).slice(2, 7));
  let lid = null;
  if (lantern) lid = seedLantern(srv.dbPath, u.sub, { appeared });
  if (fire > 0) seedFire(srv.dbPath, u.sub, fire);
  return { ...u, lid, call: client(srv.base, u.cookie) };
}

// U-1 basic fire->plays: balance 9, no free -> floor(9/3)=3 (use lantern w/ both free used)
test('U-1 fire->plays: balance 9 with no free plays -> 3', async () => {
  const u = await userWith({ fire: 9 });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'release' });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'daily' });
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.freePlays, 0);
  assert.equal(s.data.balance, 9);
  assert.equal(s.data.playsLeft, 3);
});

// U-2 leftover fire < 1 play: balance 2, no free -> 0, START -> no_fire
test('U-2 balance 2, no free -> playsLeft 0 and START no_fire', async () => {
  const u = await userWith({ fire: 2 });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'release' });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'daily' });
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.playsLeft, 0);
  const start = await u.call('POST', '/api/height/start', { request_id: 'u2' });
  assert.equal(start.status, 403);
  assert.equal(start.data.error, 'no_fire');
});

// U-3 free + paid stack: has lantern, no free used, balance 3 -> free 1 + 1 = 2
test('U-3 free(1) + paid(1) stack -> playsLeft 2', async () => {
  const u = await userWith({ fire: 3 });
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.freePlays, 1);
  assert.equal(s.data.playsLeft, 2);
});

// U-4 no approved lantern -> freePlays 0 (state reports hasLantern:false)
test('U-4 no lantern -> hasLantern false (freePlays 0)', async () => {
  const u = await userWith({ lantern: false });
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.hasLantern, false);
});

// U-5 release used -> no free left (only 1 free per lantern now)
test('U-5 release used -> freePlays 0', async () => {
  const u = await userWith({});
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'release' });
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.freePlays, 0);
});

// U-6 free play is one-time (release), not per-day: a legacy 'daily' row from
// another day does not grant an extra free play today.
test('U-6 free play is one-time release, not per-day', async () => {
  const u = await userWith({});
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'daily', day: '2000-01-01' });
  const s = await u.call('GET', '/api/height/state');
  // only the one-time release free play counts -> 1
  assert.equal(s.data.freePlays, 1);
});

// U-7 earned accumulates across spin+puzzle+game
test('U-7 earned accumulates spin+puzzle+game', async () => {
  const u = await userWith({});
  // spin (1..4), puzzle (goals 9 -> 3), quiz (2). Use APIs so earn path is real.
  const sp = await u.call('POST', '/api/spin', {});
  const pz = await u.call('POST', '/api/puzzle/win', { goals: 9 });
  const qz = await u.call('POST', '/api/quiz/win', { result: 'x' });
  const expected = sp.data.reward + (sp.data.bonus || 0) + pz.data.reward + qz.data.reward;
  const w = await u.call('GET', '/api/wallet');
  assert.equal(w.data.wallet.earned, expected);
  assert.equal(pz.data.reward, 3);
  assert.equal(qz.data.reward, 2);
});

// U-8 spent counts only kind=paid (finalized/active); free never charges
test('U-8 spent counts only paid plays', async () => {
  const u = await userWith({ fire: 6 });
  // 2 free finalized + 1 paid finalized => spent = 1*3 = 3
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'release' });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'daily' });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'paid' });
  const w = await u.call('GET', '/api/wallet');
  assert.equal(w.data.wallet.earned, 6);
  assert.equal(w.data.wallet.spent, 3);
  assert.equal(w.data.wallet.balance, 3);
});

// U-9 maxHits/maxMeters from cfg (default) reflected in state.durationMs
test('U-9 state exposes durationMs (10000 default)', async () => {
  const u = await userWith({});
  const s = await u.call('GET', '/api/height/state');
  assert.equal(s.data.durationMs, 10000);
  assert.equal(s.data.firePerFan, 3);
});

// U-10 reward tables: puzzle ceil(goals/3) cap 4; shake tiers
test('U-10 reward tables: puzzle cap 4, shake tiers', async () => {
  const u = await userWith({});
  const pz = await u.call('POST', '/api/puzzle/win', { goals: 99 });
  assert.equal(pz.data.reward, 4, 'puzzle capped at 4');
  // shake is a different game key so still allowed under GAMES_UNLIMITED
  const sh = await u.call('POST', '/api/shake/win', { score: 65 });
  assert.equal(sh.data.reward, 3, 'shake 50-79 -> 3');
});
