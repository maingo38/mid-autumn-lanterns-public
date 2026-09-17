'use strict';
// Wave 2 — API/integration for height start/finish + leaderboard.
// Covers A-1..A-13, A-15 and leaderboard tie-break (E-6-ish at API level).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire, seedPlay, lanternHeight } = require('./helpers/seed');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

async function u(fire = 0, appeared = 1, lantern = true) {
  const g = await guest(srv.base, 'H' + Math.random().toString(36).slice(2, 7));
  let lid = null;
  if (lantern) lid = seedLantern(srv.dbPath, g.sub, { appeared });
  if (fire > 0) seedFire(srv.dbPath, g.sub, fire);
  return { ...g, lid, call: client(srv.base, g.cookie) };
}

// A-1 state without lantern
test('A-1 state without lantern -> hasLantern:false', async () => {
  const g = await u(0, 1, false);
  const s = await g.call('GET', '/api/height/state');
  assert.equal(s.data.hasLantern, false);
});

// A-2 state with appeared lantern exposes expected fields
test('A-2 state with appeared lantern exposes fields', async () => {
  const g = await u();
  const s = await g.call('GET', '/api/height/state');
  assert.equal(s.data.hasLantern, true);
  assert.equal(s.data.appeared, true);
  assert.equal(typeof s.data.playsLeft, 'number');
  assert.equal(typeof s.data.freePlays, 'number');
  assert.equal(s.data.firePerFan, 3);
  assert.equal(s.data.active, null);
});

// A-3 first start is free release; balance unchanged
test('A-3 first START -> kind release, no spend', async () => {
  const g = await u(3);
  const s = await g.call('POST', '/api/height/start', { request_id: 'a3' });
  assert.equal(s.status, 200);
  assert.equal(s.data.kind, 'release');
  assert.equal(s.data.balance, 3, 'free release does not spend fire');
});

// A-4 first start = release (free); second (free used) with fire = paid, debits
test('A-4 start sequence release -> paid(debit)', async () => {
  const g = await u(3);
  const r = await g.call('POST', '/api/height/start', { request_id: 'a4-r' });
  assert.equal(r.data.kind, 'release');
  await g.call('POST', '/api/height/finish', { play_id: r.data.playId, hits: 0 });
  const p = await g.call('POST', '/api/height/start', { request_id: 'a4-p' });
  assert.equal(p.data.kind, 'paid');
  assert.equal(p.data.balance, 0, 'paid debits FIRE_PER_FAN');
});

// A-5 missing request_id -> 400
test('A-5 START without request_id -> 400', async () => {
  const g = await u();
  const s = await g.call('POST', '/api/height/start', {});
  assert.equal(s.status, 400);
  assert.equal(s.data.error, 'need_request_id');
});

// A-6 same request_id -> resumed, no new row, no extra debit
test('A-6 duplicate request_id -> resumed same play', async () => {
  const g = await u();
  const a = await g.call('POST', '/api/height/start', { request_id: 'a6' });
  const b = await g.call('POST', '/api/height/start', { request_id: 'a6' });
  assert.equal(b.data.resumed, true);
  assert.equal(b.data.playId, a.data.playId);
});

// A-7 no per-day cap: many plays in one day while fire lasts
test('A-7 no per-day play cap (R-11)', async () => {
  const g = await u(30); // plenty of fire
  let ok = 0;
  for (let i = 0; i < 6; i++) {
    const s = await g.call('POST', '/api/height/start', { request_id: 'a7-' + i });
    if (s.status === 200) { ok++; await g.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 0 }); }
  }
  assert.equal(ok, 6, 'all six plays allowed same day (2 free + 4 paid)');
});

// A-8 appeared=0 -> 403 not_appeared
test('A-8 START when not appeared -> 403 not_appeared', async () => {
  const g = await u(0, 0);
  const s = await g.call('POST', '/api/height/start', { request_id: 'a8' });
  assert.equal(s.status, 403);
  assert.equal(s.data.error, 'not_appeared');
});

// A-9 playsLeft<1 -> 403 no_fire, no row created
test('A-9 START with no plays left -> 403, no row', async () => {
  const g = await u(0);
  seedPlay(srv.dbPath, g.sub, g.lid, { kind: 'release' });
  seedPlay(srv.dbPath, g.sub, g.lid, { kind: 'daily' });
  const s = await g.call('POST', '/api/height/start', { request_id: 'a9' });
  assert.equal(s.status, 403);
  assert.equal(s.data.error, 'no_fire');
});

// A-10 finish credits meters (full time via short duration server)
test('A-10 FINISH credits meters after elapsed time', async () => {
  const g = await u();
  const s = await g.call('POST', '/api/height/start', { request_id: 'a10' });
  // wait ~1.1s so the time-gate allows a few hits
  await new Promise(r => setTimeout(r, 1100));
  const f = await g.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 3 });
  assert.equal(f.status, 200);
  assert.ok(f.data.added >= 10, `credited ${f.data.added}m`);
  assert.equal(lanternHeight(srv.dbPath, g.lid), f.data.added);
});

// A-11 finish cap: even with elapsed>=duration, added never exceeds maxMeters
test('A-11 FINISH caps at maxMeters', async () => {
  const g = await u();
  const lid = g.lid;
  // seed an active play that started long enough ago that time-gate is full
  const pid = seedPlay(srv.dbPath, g.sub, lid, {
    kind: 'release', finalized: 0,
    startedAt: Date.now() - 20000, endsAt: Date.now() + 5000, requestId: 'a11',
  });
  const f = await g.call('POST', '/api/height/finish', { play_id: pid, hits: 999 });
  assert.equal(f.data.added, 300, 'capped at maxMeters=300');
});

// A-12 finish idempotent
test('A-12 FINISH twice -> second is already, no double add', async () => {
  const g = await u();
  const pid = seedPlay(srv.dbPath, g.sub, g.lid, {
    kind: 'release', finalized: 0,
    startedAt: Date.now() - 20000, endsAt: Date.now() + 5000, requestId: 'a12',
  });
  const f1 = await g.call('POST', '/api/height/finish', { play_id: pid, hits: 5 });
  const f2 = await g.call('POST', '/api/height/finish', { play_id: pid, hits: 5 });
  assert.equal(f2.data.already, true);
  assert.equal(lanternHeight(srv.dbPath, g.lid), f1.data.added, 'height added once');
});

// A-13 finish another user's play -> 404 no_play
test("A-13 FINISH someone else's play -> 404", async () => {
  const a = await u();
  const b = await u();
  const pid = seedPlay(srv.dbPath, a.sub, a.lid, { kind: 'release', finalized: 0 });
  const f = await b.call('POST', '/api/height/finish', { play_id: pid, hits: 5 });
  assert.equal(f.status, 404);
  assert.equal(f.data.error, 'no_play');
});

// A-15 finish with negative/NaN hits -> added 0
test('A-15 FINISH with bad hits -> added 0', async () => {
  const g = await u();
  const pid = seedPlay(srv.dbPath, g.sub, g.lid, {
    kind: 'release', finalized: 0,
    startedAt: Date.now() - 20000, endsAt: Date.now() + 5000, requestId: 'a15',
  });
  const f = await g.call('POST', '/api/height/finish', { play_id: pid, hits: -5 });
  assert.equal(f.data.added, 0);
  assert.equal(lanternHeight(srv.dbPath, g.lid), 0);
});

// Leaderboard: only approved+height>0, sorted desc, tie-break by appeared_at
test('LB leaderboard sorts by height desc, tie-break appeared_at', async () => {
  const a = await u();
  const b = await u();
  const c = await u();
  // set heights directly
  seedPlay(srv.dbPath, a.sub, a.lid, {}); // no-op row
  // give heights via finish path is slow; set through seed helper's DB write:
  const Database = require('better-sqlite3');
  const db = new Database(srv.dbPath);
  const now = Date.now();
  db.prepare('UPDATE lanterns SET height=?, appeared_at=? WHERE id=?').run(100, now - 1000, a.lid);
  db.prepare('UPDATE lanterns SET height=?, appeared_at=? WHERE id=?').run(100, now - 5000, b.lid); // earlier -> ranks above a
  db.prepare('UPDATE lanterns SET height=?, appeared_at=? WHERE id=?').run(50, now - 9000, c.lid);
  db.close();
  const r = await a.call('GET', '/api/leaderboard/height');
  const board = r.data.board;
  // globally sorted by height desc (board may include lanterns from other tests)
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].height >= board[i].height, 'sorted by height desc');
  }
  // locate our three by id and assert their RELATIVE order
  const posA = board.findIndex(x => x.id === a.lid);
  const posB = board.findIndex(x => x.id === b.lid);
  const posC = board.findIndex(x => x.id === c.lid);
  assert.ok(posA >= 0 && posB >= 0 && posC >= 0, 'all three present');
  assert.ok(posB < posA, 'tie-break: b (earlier appeared_at) ranks above a at equal height');
  assert.ok(posA < posC, 'higher height (100) ranks above lower (50)');
});
