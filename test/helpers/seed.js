'use strict';
// Seed the server's temp DB directly with better-sqlite3. Used to put a user in
// a precise state (approved+appeared lantern, N fire) before hitting the API.
// The server opened the same file; better-sqlite3 uses WAL-less default here so
// writes are visible immediately to the server process.
const Database = require('better-sqlite3');

// today() in server uses server-local time; todayVN() uses Asia/Ho_Chi_Minh.
// Tests run with TZ=Asia/Ho_Chi_Minh so both agree.
function todayVN() {
  const s = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  return s.slice(0, 10);
}

function withDb(dbPath, fn) {
  const db = new Database(dbPath);
  try { return fn(db); } finally { db.close(); }
}

// Create an approved lantern for `sub`. appeared=1 makes /api/height/start allowed.
function seedLantern(dbPath, sub, { appeared = 1, height = 0, appearedAt = Date.now() } = {}) {
  return withDb(dbPath, db => {
    const info = db.prepare(
      "INSERT INTO lanterns (file, template, name, status, created, user_sub, appeared, appeared_at, height) " +
      "VALUES (?,?,?,'approved',?,?,?,?,?)"
    ).run('test.png', 'ong-sao', 'Test', Date.now(), sub, appeared ? 1 : 0, appearedAt, height);
    return info.lastInsertRowid;
  });
}

// Grant `fire` fire by inserting a spin row (earned is cumulative over spins+games+puzzles).
function seedFire(dbPath, sub, fire) {
  if (fire <= 0) return;
  withDb(dbPath, db => {
    db.prepare('INSERT INTO spins (voter, day, reward, created) VALUES (?,?,?,?)')
      .run(sub, todayVN(), fire, Date.now());
  });
}

// Insert a height_plays row of a given kind (to simulate used free plays, etc.).
function seedPlay(dbPath, sub, lanternId, { kind = 'paid', day = todayVN(), finalized = 1, meters = 0, requestId } = {}) {
  return withDb(dbPath, db => {
    const now = Date.now();
    const rid = requestId || ('seed_' + Math.random().toString(36).slice(2));
    const info = db.prepare(
      'INSERT INTO height_plays (user_sub, lantern_id, day, request_id, started_at, ends_at, finalized, meters, created, kind) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(sub, lanternId, day, rid, now, now + 10000, finalized ? 1 : 0, meters, now, kind);
    return info.lastInsertRowid;
  });
}

function lanternHeight(dbPath, lanternId) {
  return withDb(dbPath, db => db.prepare('SELECT height FROM lanterns WHERE id=?').get(lanternId)?.height);
}

function countPlays(dbPath, sub, where = '') {
  return withDb(dbPath, db =>
    db.prepare(`SELECT COUNT(*) AS n FROM height_plays WHERE user_sub=? ${where}`).get(sub).n);
}

module.exports = { seedLantern, seedFire, seedPlay, lanternHeight, countPlays, todayVN };
