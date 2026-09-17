'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');
const { seedLantern, seedFire } = require('./helpers/seed');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('smoke: guest login + seeded lantern shows in height state', async () => {
  const u = await guest(srv.base);
  const call = client(srv.base, u.cookie);

  // no lantern yet
  let r = await call('GET', '/api/height/state');
  assert.equal(r.status, 200);
  assert.equal(r.data.hasLantern, false);

  // seed approved+appeared lantern + 9 fire
  seedLantern(srv.dbPath, u.sub, { appeared: 1 });
  seedFire(srv.dbPath, u.sub, 9);

  r = await call('GET', '/api/height/state');
  assert.equal(r.status, 200);
  assert.equal(r.data.hasLantern, true);
  assert.equal(r.data.firePerFan, 3);
  // 1 free (release, has approved lantern) + floor(9/3)=3 => 4
  assert.equal(r.data.freePlays, 1);
  assert.equal(r.data.playsLeft, 4);
  assert.equal(r.data.balance, 9);
});
