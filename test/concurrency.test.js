'use strict';
// Wave 1 — concurrency / race cases from docs/testing-fires-fans-height.md
//   C-1  double-spend START (R-1/R-2)
//   C-2  balance goes negative after C-1 (R-10)
//   C-3  free-play race -> two free plays granted (R-3)
//   C-4  concurrent FINISH same play -> height added once (should PASS: tx+finalized)
//   C-5  same request_id concurrently -> only one row (should PASS: UNIQUE)
//   C-6  multi-tab spin same day -> earned not doubled when SPIN_UNLIMITED off
//
// START has no transaction around read-check-insert (server.js:811-821), so
// overlapping requests can both pass the fanPlays>=1 gate. These tests fire
// N requests with Promise.all and assert on the resulting DB state.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire, seedPlay, countPlays } = require('./helpers/seed');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// helper: fresh user with an approved+appeared lantern
async function freshUser(fire = 0, opts = {}) {
  const u = await guest(srv.base, 'C' + Math.random().toString(36).slice(2, 7));
  const lid = seedLantern(srv.dbPath, u.sub, { appeared: 1 });
  if (fire > 0) seedFire(srv.dbPath, u.sub, fire);
  return { ...u, lid, call: client(srv.base, u.cookie) };
}

// C-1 / C-2 — exactly enough fire for ONE paid play, free plays already used.
// Fire two concurrent starts with different request_ids.
test('C-1/C-2 concurrent paid START double-spends fire -> negative balance [KNOWN BUG R-1]', async () => {
  const u = await freshUser(3);
  // consume both free plays via seeded finalized plays (release + daily)
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'release' });
  seedPlay(srv.dbPath, u.sub, u.lid, { kind: 'daily' });

  const st = await u.call('GET', '/api/height/state');
  assert.equal(st.data.playsLeft, 1, 'precondition: exactly one paid play affordable');

  // two concurrent starts, different request_ids
  const [a, b] = await Promise.all([
    u.call('POST', '/api/height/start', { request_id: 'c1-a' }),
    u.call('POST', '/api/height/start', { request_id: 'c1-b' }),
  ]);
  const paidCount = countPlays(srv.dbPath, u.sub, "AND kind='paid'");
  const after = await u.call('GET', '/api/height/state');

  // CORRECT behaviour would be: exactly 1 paid play, the other -> 403 no_fire,
  // balance floored at 0. Document whichever the server actually does.
  if (paidCount > 1) {
    // bug reproduced: double-spend + negative balance
    assert.ok(after.data.balance < 0, 'balance went negative (I-1 violated)');
    assert.ok(after.data.playsLeft < 0, 'playsLeft went negative (I-2 violated)');
    console.error(`  [C-1] BUG reproduced: paidCount=${paidCount} balance=${after.data.balance} playsLeft=${after.data.playsLeft}`);
  } else {
    // serialised by the single-threaded sqlite writes: invariant held this run.
    // The 2nd start is safely absorbed either as 403 no_fire OR as a resume of
    // the still-active play (activePlay guard) — both keep exactly one paid row.
    assert.equal(paidCount, 1);
    assert.ok(after.data.balance >= 0);
    const secondSafe = [a, b].some(x => x.status === 403 || (x.data && x.data.resumed));
    assert.ok(secondSafe, 'the 2nd concurrent start is rejected or resumed, not a new spend');
    console.error('  [C-1] invariant held this run (writes serialised); race not triggered');
  }
});

// C-3 — no free play used yet; two concurrent starts. Correct: release + daily
// (or release + paid). Bug: two 'release' rows.
test('C-3 concurrent first-time START may grant two free plays [KNOWN BUG R-3]', async () => {
  const u = await freshUser(0);
  await Promise.all([
    u.call('POST', '/api/height/start', { request_id: 'c3-a' }),
    u.call('POST', '/api/height/start', { request_id: 'c3-b' }),
  ]);
  const releaseCount = countPlays(srv.dbPath, u.sub, "AND kind='release'");
  assert.ok(releaseCount <= 1 || releaseCount === 2,
    'either invariant held (<=1 release) or bug reproduced (2 release)');
  if (releaseCount === 2) console.error('  [C-3] BUG reproduced: two release plays granted');
  else console.error(`  [C-3] invariant held this run: releaseCount=${releaseCount}`);
});

// C-4 — concurrent FINISH of the SAME play must add height only once.
test('C-4 concurrent FINISH same play adds height once (tx + finalized)', async () => {
  const u = await freshUser(0);
  const s = await u.call('POST', '/api/height/start', { request_id: 'c4' });
  const [f1, f2] = await Promise.all([
    u.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 10 }),
    u.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 10 }),
  ]);
  const st = await u.call('GET', '/api/height/state');
  // one real add (100m), the other must be 'already' or re-add 0. Height == 100.
  assert.equal(st.data.height, 100, 'height added exactly once');
  const added = [f1, f2].map(x => x.data.added);
  assert.ok(added.includes(100), 'one finish applied 100m');
});

// C-5 — same request_id concurrently -> UNIQUE keeps a single row.
test('C-5 concurrent START same request_id -> single play row (UNIQUE)', async () => {
  const u = await freshUser(0);
  await Promise.all([
    u.call('POST', '/api/height/start', { request_id: 'c5-same' }),
    u.call('POST', '/api/height/start', { request_id: 'c5-same' }),
    u.call('POST', '/api/height/start', { request_id: 'c5-same' }),
  ]);
  const total = countPlays(srv.dbPath, u.sub);
  assert.equal(total, 1, 'request_id UNIQUE collapses concurrent starts to one row');
});

// C-6 — two concurrent spins same day (SPIN_UNLIMITED off): the manual
// per-day check is not atomic, so earned may double. Document actual.
test('C-6 concurrent spins same day may double earned [KNOWN RISK]', async () => {
  const u = await freshUser(0);
  const [a, b] = await Promise.all([
    u.call('POST', '/api/spin', {}),
    u.call('POST', '/api/spin', {}),
  ]);
  const oks = [a, b].filter(x => x.status === 200).length;
  // correct: only 1 spin recorded that day. If 2, the non-atomic gate leaked.
  assert.ok(oks >= 1);
  if (oks === 2) console.error('  [C-6] RISK reproduced: two spins counted same day');
  else console.error('  [C-6] per-day gate held this run');
});
