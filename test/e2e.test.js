'use strict';
// Wave 3 — E2E flows (E-1..E-6) over HTTP + a simulated screen socket.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire, seedPlay, lanternHeight } = require('./helpers/seed');
const { connectScreen } = require('./helpers/screen');

let srv;
before(async () => { srv = await startServer({ GAMES_UNLIMITED: '1' }); });
after(async () => { await srv.stop(); });

async function player(fire = 0, appeared = 0) {
  const g = await guest(srv.base, 'E' + Math.random().toString(36).slice(2, 7));
  const lid = seedLantern(srv.dbPath, g.sub, { appeared });
  if (fire > 0) seedFire(srv.dbPath, g.sub, fire);
  return { ...g, lid, call: client(srv.base, g.cookie) };
}

// E-1 appear via screen socket then play a full release round shows on leaderboard
test('E-1 screen shows lantern -> appeared -> release play -> leaderboard', async () => {
  const p = await player(0, 0); // not appeared yet
  // before appearing, START is blocked
  let s = await p.call('POST', '/api/height/start', { request_id: 'e1-early' });
  assert.equal(s.status, 403);
  assert.equal(s.data.error, 'not_appeared');

  // simulate the big screen displaying it
  const screen = connectScreen(srv.base);
  await screen.ready;
  await screen.showAndWait(p.lid);
  screen.close();

  // now state reflects appeared
  const st = await p.call('GET', '/api/height/state');
  assert.equal(st.data.appeared, true);

  // play a release round; wait for time-gate then finish
  s = await p.call('POST', '/api/height/start', { request_id: 'e1' });
  assert.equal(s.data.kind, 'release');
  await new Promise(r => setTimeout(r, 1100));
  const f = await p.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 3 });
  assert.ok(f.data.added >= 10);

  // shows on leaderboard
  const lb = await p.call('GET', '/api/leaderboard/height');
  assert.ok(lb.data.board.some(x => x.id === p.lid && x.height === f.data.added));
});

// E-2 earn fire via game -> spend on paid play after free used -> height rises
test('E-2 farm fire -> paid play -> height chain consistent', async () => {
  const p = await player(0, 1);
  // burn 2 free
  seedPlay(srv.dbPath, p.sub, p.lid, { kind: 'release' });
  seedPlay(srv.dbPath, p.sub, p.lid, { kind: 'daily' });
  // earn >=3 fire via shake (GAMES_UNLIMITED on)
  const sh = await p.call('POST', '/api/shake/win', { score: 90 });
  assert.equal(sh.data.reward, 4);
  const st1 = await p.call('GET', '/api/height/state');
  assert.equal(st1.data.balance, 4);
  assert.equal(st1.data.playsLeft, 1); // floor(4/3)

  const s = await p.call('POST', '/api/height/start', { request_id: 'e2' });
  assert.equal(s.data.kind, 'paid');
  assert.equal(s.data.balance, 1, 'paid debited 3');
  await new Promise(r => setTimeout(r, 1100));
  const f = await p.call('POST', '/api/height/finish', { play_id: s.data.playId, hits: 3 });
  assert.ok(f.data.added >= 10);
  assert.equal(lanternHeight(srv.dbPath, p.lid), f.data.added);
});

// E-3 out of plays -> playsLeft 0
test('E-3 no free + no fire -> playsLeft 0', async () => {
  const p = await player(0, 1);
  seedPlay(srv.dbPath, p.sub, p.lid, { kind: 'release' });
  seedPlay(srv.dbPath, p.sub, p.lid, { kind: 'daily' });
  const st = await p.call('GET', '/api/height/state');
  assert.equal(st.data.playsLeft, 0);
});

// E-4 reload mid-round: active play resumes, no extra spend
test('E-4 reload mid-round resumes active play', async () => {
  const p = await player(0, 1);
  const s = await p.call('POST', '/api/height/start', { request_id: 'e4' });
  // state now reports active
  const st = await p.call('GET', '/api/height/state');
  assert.ok(st.data.active && st.data.active.id === s.data.playId);
  // a different request_id while active -> resume, not a new play
  const again = await p.call('POST', '/api/height/start', { request_id: 'e4-b' });
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.playId, s.data.playId);
});

// E-5 leaderboard reflects new height after finish (server side; client polls)
test('E-5 leaderboard reflects height after finish', async () => {
  const p = await player(0, 1);
  const pid = seedPlay(srv.dbPath, p.sub, p.lid, {
    kind: 'release', finalized: 0,
    startedAt: Date.now() - 20000, endsAt: Date.now() + 5000, requestId: 'e5',
  });
  const f = await p.call('POST', '/api/height/finish', { play_id: pid, hits: 5 });
  const lb = await p.call('GET', '/api/leaderboard/height');
  const mine = lb.data.board.find(x => x.id === p.lid);
  assert.ok(mine);
  assert.equal(mine.height, f.data.added);
});

// E-6 tie-break: equal height, earlier appeared_at ranks first
test('E-6 leaderboard tie-break by appeared_at', async () => {
  const a = await player(0, 1);
  const b = await player(0, 1);
  const Database = require('better-sqlite3');
  const db = new Database(srv.dbPath);
  const now = Date.now();
  db.prepare('UPDATE lanterns SET height=?, appeared_at=? WHERE id=?').run(70, now - 2000, a.lid);
  db.prepare('UPDATE lanterns SET height=?, appeared_at=? WHERE id=?').run(70, now - 8000, b.lid);
  db.close();
  const lb = await a.call('GET', '/api/leaderboard/height');
  const posA = lb.data.board.findIndex(x => x.id === a.lid);
  const posB = lb.data.board.findIndex(x => x.id === b.lid);
  assert.ok(posB < posA, 'earlier appeared_at ranks above at equal height');
});
