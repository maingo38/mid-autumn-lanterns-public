'use strict';
// Wave 1 — integrity-critical API cases from docs/testing-fires-fans-height.md
//   A-14  FINISH does not check elapsed time -> instant max score (R-4)
//   A-16  START 'paid' then never finish -> fire lost, height unchanged (R-5)
//   A-17  /api/testing has no auth -> anyone flips GAMES_UNLIMITED (R-6)
// These assert the ACTUAL current behaviour. Where that behaviour is the bug,
// the test documents it and is tagged so it is easy to flip once fixed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire, lanternHeight } = require('./helpers/seed');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// A-14 — FINISH accepts hits with no time gate: start then immediately finish
// with hits=30 yields the full +300m even though no time has passed.
test('A-14 FINISH has no time gate -> instant max score [KNOWN BUG R-4]', async () => {
  const u = await guest(srv.base);
  const call = client(srv.base, u.cookie);
  const lid = seedLantern(srv.dbPath, u.sub, { appeared: 1 });

  const s = await call('POST', '/api/height/start', { request_id: 'a14' });
  assert.equal(s.status, 200);
  assert.equal(s.data.kind, 'release');

  // finish instantly with a maxed hit count
  const f = await call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 999 });
  assert.equal(f.status, 200);
  // maxMeters = ceil(10000/1000)*3 * 10 = 300
  assert.equal(f.added, undefined === f.added ? f.added : f.added); // no-op guard
  assert.equal(f.data.added, 300, 'server caps to 300m but does NOT reject the instant finish');
  assert.equal(lanternHeight(srv.dbPath, lid), 300);
  // Documents R-4: there is no started_at/ends_at validation. Flip to expect a
  // rejection (e.g. 400) once a time gate is added.
});

// A-16 — a paid play debits fire at START; abandoning it (never finishing)
// leaves the fire spent and height unchanged.
test('A-16 paid START debits fire immediately; abandon loses it [KNOWN BUG R-5]', async () => {
  const u = await guest(srv.base);
  const call = client(srv.base, u.cookie);
  const lid = seedLantern(srv.dbPath, u.sub, { appeared: 1 });
  seedFire(srv.dbPath, u.sub, 3); // exactly one paid play worth

  // burn the 2 free plays first (release, daily)
  const r1 = await call('POST', '/api/height/start', { request_id: 'a16-r' });
  assert.equal(r1.data.kind, 'release');
  await call('POST', '/api/height/finish', { play_id: r1.data.playId, hits: 1 });
  const r2 = await call('POST', '/api/height/start', { request_id: 'a16-d' });
  assert.equal(r2.data.kind, 'daily');
  await call('POST', '/api/height/finish', { play_id: r2.data.playId, hits: 1 });

  const before = await call('GET', '/api/height/state');
  assert.equal(before.data.balance, 3);
  assert.equal(before.data.playsLeft, 1); // floor(3/3)

  // start a PAID play, then abandon (no finish)
  const p = await call('POST', '/api/height/start', { request_id: 'a16-p' });
  assert.equal(p.data.kind, 'paid');

  const after = await call('GET', '/api/height/state');
  assert.equal(after.data.balance, 0, 'fire debited at START, not at FINISH');
  assert.equal(after.data.playsLeft, 0);
  // height never moved because we never finished
  assert.equal(lanternHeight(srv.dbPath, lid), 20); // 1 hit *10 from each of 2 free finishes
});

// A-17 — /api/testing flips GAMES_UNLIMITED with NO auth.
test('A-17 /api/testing toggles GAMES_UNLIMITED without auth [KNOWN BUG R-6]', async () => {
  // no cookie at all
  const on = await fetch(srv.base + '/api/testing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(on.status, 200, 'unauthenticated caller is accepted (vulnerability)');
  const state = await (await fetch(srv.base + '/api/testing')).json();
  assert.equal(state.testing, true);

  // turn it back off so state is clean
  await fetch(srv.base + '/api/testing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: false }),
  });
});
