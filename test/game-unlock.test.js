'use strict';
// Verify mini-games unlock by event day: GAME_UNLOCK_DAY = {shake:1, quiz:2,
// puzzle:3, fortune:4, catch:5}. eventDayNum() counts days (VN tz) from
// EVENT_START (=day 1); a game is unlocked when eventDay >= its unlock day.
//
// Instead of predicting eventDay from date math (fragile across tz/DST), each
// scenario reads the eventDay the server actually reports and asserts the
// unlock relation holds for THAT day. We sweep EVENT_START from a week ahead
// (pre-launch) to a week ago (all open) to cover days <=0 through >=5.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');
const { guest, client } = require('./helpers/auth');

function vnTodayPlus(days) {
  const s = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = new Date(s + 'T12:00:00+07:00');   // noon avoids midnight/DST edges
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CAN = { shake: 'canShake', quiz: 'canQuiz', puzzle: 'canPuzzle', fortune: 'canFortune', catch: 'canCatch' };
const UNLOCK_DAY = { shake: 1, quiz: 2, puzzle: 3, fortune: 4, catch: 5 };

async function walletWith(env) {
  const srv = await startServer({ TZ: 'Asia/Ho_Chi_Minh', GAMES_UNLIMITED: '0', SPIN_UNLIMITED: '0', ...env });
  try {
    const g = await guest(srv.base, 'GU' + Math.random().toString(36).slice(2, 6));
    const w = (await client(srv.base, g.cookie)('GET', '/api/wallet')).data.wallet;
    return w;
  } finally { await srv.stop(); }
}

// Core invariant, checked against whatever eventDay the server reports:
// a game is playable iff its unlock day <= eventDay (fresh guest, once-per-day
// gate still open).
function assertUnlockMatchesDay(w) {
  for (const g of Object.keys(CAN)) {
    const shouldOpen = UNLOCK_DAY[g] <= w.eventDay;
    assert.equal(w[CAN[g]], shouldOpen,
      `${g} (unlock ${UNLOCK_DAY[g]}) expected ${shouldOpen ? 'OPEN' : 'LOCKED'} at eventDay=${w.eventDay}`);
  }
}

// Sweep launch offset from +7 (pre-launch) down to -7 (all games long open).
for (let offset = 7; offset >= -7; offset--) {
  test(`EVENT_START = today${offset >= 0 ? '+' + offset : offset} -> unlock matches reported eventDay`, async () => {
    const w = await walletWith({ EVENT_START: vnTodayPlus(offset) });
    assert.equal(typeof w.eventDay, 'number');
    assertUnlockMatchesDay(w);
  });
}

// Pre-launch specifically: launch tomorrow -> eventDay <= 0 -> everything locked.
test('launch tomorrow: pre-launch, all games locked', async () => {
  const w = await walletWith({ EVENT_START: vnTodayPlus(1) });
  assert.ok(w.eventDay <= 0, `pre-launch eventDay=${w.eventDay}`);
  for (const g of Object.keys(CAN)) assert.equal(w[CAN[g]], false, `${g} locked pre-launch`);
});

// Launch day: exactly shake (unlock day 1) opens, the rest wait.
test('launch day: only shake unlocks', async () => {
  const w = await walletWith({ EVENT_START: vnTodayPlus(0) });
  assert.equal(w.eventDay, 1, 'launch day is event day 1');
  assert.equal(w.canShake, true, 'shake opens on day 1');
  assert.equal(w.canQuiz, false);
  assert.equal(w.canPuzzle, false);
  assert.equal(w.canFortune, false);
  assert.equal(w.canCatch, false);
});

// Default config (EVENT_START baked as tomorrow) -> today pre-launch, all locked.
test('default EVENT_START: today pre-launch, all locked', async () => {
  const w = await walletWith({});   // no override -> server.js default
  assert.ok(w.eventDay <= 0, `today pre-launch (eventDay=${w.eventDay})`);
  for (const g of Object.keys(CAN)) assert.equal(w[CAN[g]], false, `${g} locked`);
});
