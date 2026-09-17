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
const { seedLantern, seedFire, seedPlay, expirePlay, lanternHeight } = require('./helpers/seed');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// A-14 — FINISH is now time-gated: an instant finish with hits=999 credits ~0m
// because almost no time has elapsed since started_at (R-4 fixed).
test('A-14 FINISH is time-gated -> instant finish credits ~0m (R-4 fixed)', async () => {
  const u = await guest(srv.base);
  const call = client(srv.base, u.cookie);
  const lid = seedLantern(srv.dbPath, u.sub, { appeared: 1 });

  const s = await call('POST', '/api/height/start', { request_id: 'a14' });
  assert.equal(s.status, 200);
  assert.equal(s.data.kind, 'release');

  // finish instantly with a maxed hit count -> elapsed ~0 -> capped near 0
  const f = await call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 999 });
  assert.equal(f.status, 200);
  // ceil(~0/1000)*3*10 = at most 30m for the first partial second; nowhere near 300
  assert.ok(f.data.added <= 30, `instant finish credited ${f.data.added}m (<=30 expected)`);
  assert.ok(f.data.added < 300, 'instant finish no longer yields full 300m');
  assert.equal(lanternHeight(srv.dbPath, lid), f.data.added);
});

// A-16 — a paid play reserves fire at START (balance drops while it is active),
// but an ABANDONED paid play (expired + never finalized) is refunded (R-5 fixed).
test('A-16 paid START reserves fire; abandoned (expired) play is refunded (R-5 fixed)', async () => {
  const u = await guest(srv.base);
  const call = client(srv.base, u.cookie);
  const lid = seedLantern(srv.dbPath, u.sub, { appeared: 1 });
  seedFire(srv.dbPath, u.sub, 3); // exactly one paid play worth

  // consume the 2 free plays via seeded finalized rows (release + daily)
  seedPlay(srv.dbPath, u.sub, lid, { kind: 'release' });
  seedPlay(srv.dbPath, u.sub, lid, { kind: 'daily' });

  const before = await call('GET', '/api/height/state');
  assert.equal(before.data.balance, 3);
  assert.equal(before.data.playsLeft, 1); // floor(3/3)

  // start a PAID play -> fire reserved while active
  const p = await call('POST', '/api/height/start', { request_id: 'a16-p' });
  assert.equal(p.data.kind, 'paid');
  const active = await call('GET', '/api/height/state');
  assert.equal(active.data.balance, 0, 'fire reserved while the paid play is active');
  assert.equal(active.data.playsLeft, 0);

  // abandon it: force that paid play to be expired + unfinalized (user closed tab)
  expirePlay(srv.dbPath, p.data.playId);

  const refunded = await call('GET', '/api/height/state');
  assert.equal(refunded.data.balance, 3, 'abandoned (expired, unfinalized) paid play is refunded');
  assert.equal(refunded.data.playsLeft, 1);
  // height never moved (nothing finalized)
  assert.equal(lanternHeight(srv.dbPath, lid), 0);
});

// A-17 — /api/testing now requires admin auth (R-6 fixed).
test('A-17 /api/testing rejects unauthenticated toggle (R-6 fixed)', async () => {
  // no cookie at all -> rejected, GAMES_UNLIMITED unchanged
  const on = await fetch(srv.base + '/api/testing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(on.status, 401, 'unauthenticated caller is now rejected');
  const state = await (await fetch(srv.base + '/api/testing')).json();
  assert.equal(state.testing, false, 'flag stays OFF');
});
