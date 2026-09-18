'use strict';
// POST /api/admin/delete-account wipes an account by one of its lanterns:
// lantern rows (+image files), the users row, and every voter/user_sub table.
// A lantern with NULL user_sub (old, unmapped) deletes just that one row.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers/server');
const { admin } = require('./helpers/auth');
const { seedLantern, seedFire, todayVN } = require('./helpers/seed');

let srv, adminCookie;
before(async () => { srv = await startServer(); ({ cookie: adminCookie } = await admin(srv.base)); });
after(async () => { await srv && srv.stop(); });

function db(fn){ const d = new Database(srv.dbPath); try { return fn(d); } finally { d.close(); } }
async function del(id){
  const r = await fetch(srv.base + '/api/admin/delete-account', {
    method:'POST', headers:{ cookie:adminCookie, 'content-type':'application/json' },
    body: JSON.stringify({ id }),
  });
  return { status:r.status, data: await r.json().catch(()=>({})) };
}

test('delete-account wipes the account across every table + image files', async () => {
  const sub = 'user-del-1';
  const id = seedLantern(srv.dbPath, sub, { appeared:1 });
  seedFire(srv.dbPath, sub, 4);
  // give the lantern a real file on disk + an ai_file, and rows in more tables
  const dir = path.join(require('./helpers/server').ROOT, 'public', 'lanterns');
  const f1 = 'del-test-1.png', f2 = 'del-test-1_ai.png';
  fs.writeFileSync(path.join(dir, f1), 'x'); fs.writeFileSync(path.join(dir, f2), 'y');
  db(d => {
    d.prepare('UPDATE lanterns SET file=?, ai_file=? WHERE id=?').run(f1, f2, id);
    d.prepare('INSERT INTO votes (lantern,voter,day,created) VALUES (?,?,?,?)').run(id, sub, todayVN(), Date.now());
    d.prepare('INSERT INTO checkins (voter,day,created) VALUES (?,?,?)').run(sub, todayVN(), Date.now());
    d.prepare('INSERT INTO users (sub,email,name,created) VALUES (?,?,?,?)').run(sub, 'a@b.c', 'Del', Date.now());
  });

  const r = await del(id);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.account, true);

  db(d => {
    assert.equal(d.prepare('SELECT COUNT(*) n FROM lanterns WHERE user_sub=?').get(sub).n, 0, 'lanterns gone');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM users WHERE sub=?').get(sub).n, 0, 'user gone');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM spins WHERE voter=?').get(sub).n, 0, 'spins gone');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM votes WHERE voter=?').get(sub).n, 0, 'votes gone');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM checkins WHERE voter=?').get(sub).n, 0, 'checkins gone');
  });
  assert.equal(fs.existsSync(path.join(dir, f1)), false, 'file removed');
  assert.equal(fs.existsSync(path.join(dir, f2)), false, 'ai file removed');
});

test('NULL user_sub lantern: only that row is deleted, no account wipe', async () => {
  const id = db(d => d.prepare(
    "INSERT INTO lanterns (file, template, name, status, created) VALUES ('n.png','ong-sao','X','approved',?)"
  ).run(Date.now()).lastInsertRowid);
  const r = await del(id);
  assert.equal(r.status, 200);
  assert.equal(r.data.account, false);
  assert.equal(r.data.deleted, 1);
  db(d => assert.equal(d.prepare('SELECT COUNT(*) n FROM lanterns WHERE id=?').get(id).n, 0));
});

test('missing lantern id -> 404', async () => {
  const r = await del(999999);
  assert.equal(r.status, 404);
});
