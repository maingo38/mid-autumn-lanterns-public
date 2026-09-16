// Mid-Autumn Lanterns — event server.
// Runs entirely on ONE laptop at the booth. No internet needed.
//   - serves the phone colouring page (/) and the big-screen page (/screen)
//   - receives finished lanterns (POST /submit) -> saves to disk + SQLite
//   - pushes "new-lantern" to the screen in real time via Socket.IO
//   - prints a QR code in the terminal so kids can open the page
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const qrcode = require('qrcode');
const { PNG } = require('pngjs');

// ── Google sign-in ─────────────────────────────────────────────────
// Employees scan the QR, sign in with Google, and their Google account id
// (`sub`) becomes their identity everywhere: one account = one lantern, and
// all votes/wallet/streak key off `sub` (not a spoofable localStorage id).
// We verify the ID token via Google's tokeninfo endpoint (no extra dep) and
// mint our own HMAC-signed session cookie.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  '137103551769-kddq37o61e8tmeatqq75cobru22b2nvb.apps.googleusercontent.com';
// secret for signing session cookies. Set SESSION_SECRET in prod; dev fallback
// is a fixed string so restarts don't log everyone out during testing.
const SESSION_SECRET = process.env.SESSION_SECRET || 'mid-autumn-dev-secret-change-me';
const SESSION_DAYS = 7;   // covers the whole 5-day event with margin
// GUEST_MODE=1 lets people in WITHOUT Google (for testing). Each browser gets a
// random guest identity; everything else (1 lantern/account, wallet, games) works.
const GUEST_MODE = process.env.GUEST_MODE === '1';

// ── Background removal ─────────────────────────────────────────────
// gpt-image-2 paints a solid (usually near-white/grey) backdrop. We flood-fill
// inward from every edge, clearing pixels that look like background — matched
// two ways so an uneven backdrop is fully removed:
//   (a) close to the LOCAL edge colour the flood arrived from, OR
//   (b) generally light/desaturated (near-white studio background).
// Whatever the flood can't reach (the lantern) stays. Soft alpha edge = no jaggies.
function removeBackground(buf, tol = 60) {
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  const at = (x, y) => (y * W + x) * 4;

  // reference background = median-ish of all 4 corners (average is fine here)
  let br=0, bg=0, bb=0;
  for (const [x,y] of [[0,0],[W-1,0],[0,H-1],[W-1,H-1]]) {
    const i=at(x,y); br+=data[i]; bg+=data[i+1]; bb+=data[i+2];
  }
  br/=4; bg/=4; bb/=4;

  const isBg = (i) => {
    const r=data[i], g=data[i+1], b=data[i+2];
    // (a) near the sampled corner colour
    const dr=r-br, dg=g-bg, db=b-bb;
    if (Math.sqrt(dr*dr+dg*dg+db*db) <= tol) return true;
    // (b) light & low-saturation = studio backdrop (white/grey haze)
    const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
    if (mx >= 205 && (mx-mn) <= 28) return true;
    return false;
  };

  const seen = new Uint8Array(W*H);
  const qx=[], qy=[];
  const push = (x,y) => { const p=y*W+x; if(!seen[p] && isBg(at(x,y))){ seen[p]=1; qx.push(x); qy.push(y);} };
  for (let x=0;x<W;x++){ push(x,0); push(x,H-1); }
  for (let y=0;y<H;y++){ push(0,y); push(W-1,y); }
  let head=0;
  while (head<qx.length){
    const x=qx[head], y=qy[head]; head++;
    if(x>0)push(x-1,y); if(x<W-1)push(x+1,y);
    if(y>0)push(x,y-1); if(y<H-1)push(x,y+1);
    // also clear diagonally so thin backdrop gaps between strokes are caught
    if(x>0&&y>0)push(x-1,y-1); if(x<W-1&&y>0)push(x+1,y-1);
    if(x>0&&y<H-1)push(x-1,y+1); if(x<W-1&&y<H-1)push(x+1,y+1);
  }
  for (let p=0;p<W*H;p++) if(seen[p]) data[p*4+3]=0;

  // 2px feather for a clean, soft edge
  for (let pass=0; pass<2; pass++){
    const snap = data.slice();
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      const p=y*W+x; if (snap[p*4+3]===0) continue;
      let touchesClear=false;
      if(x>0&&snap[(p-1)*4+3]===0)touchesClear=true;
      else if(x<W-1&&snap[(p+1)*4+3]===0)touchesClear=true;
      else if(y>0&&snap[(p-W)*4+3]===0)touchesClear=true;
      else if(y<H-1&&snap[(p+W)*4+3]===0)touchesClear=true;
      if(touchesClear) data[p*4+3] = Math.min(data[p*4+3], pass===0?170:110);
    }
  }
  return PNG.sync.write(png);
}

const PORT = Number(process.env.PORT || 3000);
const MAX_ON_SCREEN = 80;          // how many lanterns the screen keeps alive at once
const LANTERN_DIR = path.join(__dirname, 'public', 'lanterns');
fs.mkdirSync(LANTERN_DIR, { recursive: true });

// --- tiny persistence: a folder of PNGs + one SQLite row each -------------
// DB_PATH lets you point the database at a mounted volume in Docker.
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'lanterns.db'));
db.exec(`CREATE TABLE IF NOT EXISTS lanterns (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  file      TEXT NOT NULL,
  ai_file   TEXT,                                -- AI-rendered version (if any)
  template  TEXT,
  name      TEXT,
  status    TEXT NOT NULL DEFAULT 'pending',   -- processing | pending | approved | rejected
  created   INTEGER NOT NULL
)`);
// upgrade older DBs: add columns if missing (ignore error if they exist)
try { db.exec('ALTER TABLE lanterns ADD COLUMN name TEXT'); } catch (e) {}
try { db.exec("ALTER TABLE lanterns ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'"); } catch (e) {}
try { db.exec('ALTER TABLE lanterns ADD COLUMN ai_file TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE lanterns ADD COLUMN wish TEXT'); } catch (e) {}
// one lantern per device: tag every row with the phone's localStorage id.
try { db.exec('ALTER TABLE lanterns ADD COLUMN device_id TEXT'); } catch (e) {}
// one lantern per Google account: the account's `sub`. Old rows stay NULL
// (unmapped) — they keep showing on the screen/rank but belong to no account.
try { db.exec('ALTER TABLE lanterns ADD COLUMN user_sub TEXT'); } catch (e) {}
// bước 5 "độ cao": đèn đã xuất hiện trên /screen chưa + tổng độ cao mô phỏng (m)
try { db.exec('ALTER TABLE lanterns ADD COLUMN appeared INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE lanterns ADD COLUMN appeared_at INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE lanterns ADD COLUMN height INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

// game "tạo gió" tăng độ cao — mỗi lượt 10s, chốt điểm server-side.
// request_id: client sinh, UNIQUE -> start lại cùng id không tạo lượt mới (idempotent).
db.exec(`CREATE TABLE IF NOT EXISTS height_plays (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub   TEXT NOT NULL,
  lantern_id INTEGER NOT NULL,
  day        TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  finalized  INTEGER NOT NULL DEFAULT 0,
  meters     INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL
)`);

// Google accounts that have signed in.
db.exec(`CREATE TABLE IF NOT EXISTS users (
  sub      TEXT PRIMARY KEY,
  email    TEXT NOT NULL,
  name     TEXT,
  picture  TEXT,
  created  INTEGER NOT NULL
)`);

// "Đèn Sáng Nhất" ranking game — runs across the whole 5-day event.
// Fire = the voting currency, earned by spinning the wheel once per day.
// Fires and the leaderboard ACCUMULATE over the event (no midnight reset);
// only the once-per-day spin and the once-per-lantern-per-day vote are scoped
// to `day` (YYYY-MM-DD local), so every day gives a fresh reason to come back.
//   fires : one row per (voter gives 1 fire to a lantern) on a given day.
//           UNIQUE(lantern,voter,day) => at most 1 fire per lantern per person/day,
//           but the same lantern can be fired again on later days (cumulative).
//   spins : one row per wheel spin; the once-per-day rule lives in /api/spin.
db.exec('DROP TABLE IF EXISTS fires');   // was schema-less test data this session
db.exec(`CREATE TABLE IF NOT EXISTS fires (
  lantern  INTEGER NOT NULL,
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  created  INTEGER NOT NULL,
  UNIQUE(lantern, voter, day)
)`);
// no UNIQUE(voter,day): the once-per-day rule lives in the /api/spin route so
// SPIN_UNLIMITED=1 can lift it for testing without a schema change.
db.exec(`CREATE TABLE IF NOT EXISTS spins (
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  reward   INTEGER NOT NULL,
  created  INTEGER NOT NULL
)`);
// slide-puzzle mini game: one rewarded WIN per person per day (like spins).
// reward folds into the same cumulative wallet. Kept across restarts.
db.exec(`CREATE TABLE IF NOT EXISTS puzzles (
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  reward   INTEGER NOT NULL,
  created  INTEGER NOT NULL,
  UNIQUE(voter, day)
)`);
// generic once-per-day mini games (shake, quiz, ...). One rewarded play per
// person per day PER game. `data` stores a small JSON blob (quiz result etc.).
// Folds into the same cumulative wallet; kept across restarts.
db.exec(`CREATE TABLE IF NOT EXISTS games (
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  game     TEXT NOT NULL,
  reward   INTEGER NOT NULL,
  data     TEXT,
  created  INTEGER NOT NULL,
  UNIQUE(voter, day, game)
)`);

// ── Voting (separate currency from fire) ──────────────────────────
// A "vote" is NOT fire. Each voter earns +1 vote per distinct day they show up
// (one checkins row per voter/day). Votes accumulate over the event and are
// spent on lanterns — 1 or many, split however the voter likes (no per-lantern
// cap), but never on their own lantern. voteBalance = daysCheckedIn - votesCast.
db.exec(`CREATE TABLE IF NOT EXISTS checkins (
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  created  INTEGER NOT NULL,
  UNIQUE(voter, day)
)`);
// no UNIQUE here: a voter may pile several votes on the same lantern.
db.exec(`CREATE TABLE IF NOT EXISTS votes (
  lantern  INTEGER NOT NULL,
  voter    TEXT NOT NULL,
  day      TEXT NOT NULL,
  created  INTEGER NOT NULL
)`);

// testing switch: SPIN_UNLIMITED=1 lets everyone spin as many times as they want
// (fires still accumulate in the wallet). Default off = one spin per person/day.
const SPIN_UNLIMITED = process.env.SPIN_UNLIMITED === '1';
// GAMES_UNLIMITED lifts the once-per-day cap on ALL games (for testing).
// Implemented by tagging the day key with a timestamp so UNIQUE never collides.
// `let` (not const): the /api/testing toggle flips it at runtime. Env sets the
// initial value; the toggle overrides it until the server restarts.
let GAMES_UNLIMITED = process.env.GAMES_UNLIMITED === '1';
// the day-key a game row is stored under; unlimited => unique each play
function gameDay(day){ return GAMES_UNLIMITED ? day + '#' + Date.now() + Math.random().toString(36).slice(2,6) : day; }

// local calendar day, e.g. "2026-09-04" — the reset boundary for the whole game
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Game "tạo gió" tăng độ cao (bước 5) ────────────────────────────
// Cấu hình dễ chỉnh: 3 lượt/ngày, mỗi lượt 10s, +10m mỗi tương tác hợp lệ,
// tối đa 3 tương tác/giây -> trần điểm mỗi lượt = 10s * 3 * 10m = 300m.
const HEIGHT_CFG = {
  playsPerDay: Number(process.env.HEIGHT_PLAYS || 3),
  durationMs:  Number(process.env.HEIGHT_DURATION_MS || 10000),
  metersPerHit: Number(process.env.HEIGHT_METERS || 10),
  maxHitsPerSec: Number(process.env.HEIGHT_MAX_HPS || 3),
};
HEIGHT_CFG.maxHits = Math.ceil(HEIGHT_CFG.durationMs / 1000) * HEIGHT_CFG.maxHitsPerSec;
HEIGHT_CFG.maxMeters = HEIGHT_CFG.maxHits * HEIGHT_CFG.metersPerHit;

// ngày theo giờ Việt Nam (Asia/Ho_Chi_Minh) cho reset lượt độ cao
function todayVN() {
  const s = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year:'numeric', month:'2-digit', day:'2-digit' });
  return s.slice(0, 10);   // 'YYYY-MM-DD'
}

// the wheel face: 6 segments worth 1–4 fires. Laid out so equal values sit
// OPPOSITE each other (1↔1, 4↔4) for a balanced look; 2 and 3 fill the rest.
// A spin lands on a random segment; reward = that segment's value.
const WHEEL = [1, 4, 2, 1, 4, 3];

// slide-puzzle: fires awarded for the first solve each day.
// roll-the-mooncake maze (db key 'puzzle'): fires scale with score 0..100
// (reached the goal + how fast / how many goals). Max reward when done well.
const PUZZLE_MAX_REWARD = Number(process.env.PUZZLE_MAX_REWARD || 4);
// shake game: fires scale with how hard you shake (client sends a score 0..100).
const SHAKE_MAX_REWARD = Number(process.env.SHAKE_MAX_REWARD || 4);
// quiz: flat reward for finishing the "which mooncake are you" quiz once/day.
const QUIZ_REWARD = Number(process.env.QUIZ_REWARD || 2);
// bake-the-mooncake game (db key 'fortune'): fires scale with how well you kept
// the oven in the target heat zone (client sends a score 0..100).
const BAKE_MAX_REWARD = Number(process.env.BAKE_MAX_REWARD || 4);
// catch-the-rabbit: fires scale with score (client sends catches 0..100).
const CATCH_MAX_REWARD = Number(process.env.CATCH_MAX_REWARD || 4);

// daily check-in streak bonus: extra fires the first time a voter reaches N
// distinct spin-days over the event. Keeps people coming back all 5 days.
//   day 3  -> +3 fires,  day 5 -> +5 fires (+ a badge on the client).
const STREAK_BONUS = { 3: 3, 5: 5 };

// how many distinct days this voter has spun the wheel (their check-in streak)
function spinDays(voter) {
  return db.prepare('SELECT COUNT(DISTINCT day) AS n FROM spins WHERE voter=?').get(voter).n;
}

// wallet is CUMULATIVE across the whole event (no per-day reset):
//   earned = every fire ever won from spins (base rewards + streak bonuses)
//   spent  = every fire ever given to a lantern
// Only canSpin / firedToday are scoped to `day` (the once-per-day gates).
function wallet(voter, day) {
  const spinEarned   = db.prepare('SELECT COALESCE(SUM(reward),0) AS n FROM spins WHERE voter=?').get(voter).n;
  const puzzleEarned = db.prepare('SELECT COALESCE(SUM(reward),0) AS n FROM puzzles WHERE voter=?').get(voter).n;
  const gameEarned   = db.prepare('SELECT COALESCE(SUM(reward),0) AS n FROM games WHERE voter=?').get(voter).n;
  const earned = spinEarned + puzzleEarned + gameEarned;
  const spent  = db.prepare('SELECT COUNT(*) AS n FROM fires WHERE voter=?').get(voter).n;
  const spun   = !!db.prepare('SELECT 1 FROM spins WHERE voter=? AND day=?').get(voter, day);
  const puzzled= !!db.prepare('SELECT 1 FROM puzzles WHERE voter=? AND day=?').get(voter, day);
  const playedRows = db.prepare('SELECT game FROM games WHERE voter=? AND day=?').all(voter, day);
  const played = {}; playedRows.forEach(r => played[r.game] = true);
  const fired  = db.prepare('SELECT lantern FROM fires WHERE voter=? AND day=?').all(voter, day).map(r => r.lantern);
  const earnedToday = db.prepare('SELECT COALESCE(SUM(reward),0) AS n FROM spins WHERE voter=? AND day=?').get(voter, day).n;
  const U = GAMES_UNLIMITED;
  // when testing is OFF, a voter may play only ONE mini game per day total
  // (spin/wheel is separate). Playing any of the 5 locks all five.
  const playedAnyGame = puzzled || played.shake || played.quiz || played.fortune || played.catch;
  const gameOpen = U || !playedAnyGame;
  // votes: +1 per distinct check-in day, spent on others' lanterns (accumulates)
  const voteEarned = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE voter=?').get(voter).n;
  const voteSpent  = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE voter=?').get(voter).n;
  return { balance: earned - spent, earned, spent, earnedToday,
           voteBalance: voteEarned - voteSpent, voteEarned, voteSpent,
           canSpin: SPIN_UNLIMITED || U || !spun,
           canPuzzle: gameOpen, canShake: gameOpen, canQuiz: gameOpen,
           canFortune: gameOpen, canCatch: gameOpen,
           playedAnyGame, firedToday: fired, days: spinDays(voter) };
}

// set to false to skip moderation (auto-approve everything, like before)
const MODERATION = true;

// ── Admin (event organiser) ────────────────────────────────────────
// Simple password gate, verified server-side. Set ADMIN_KEY via env for the
// real event; the default is dev-only. Admin is NOT a Google account.
const ADMIN_KEY = process.env.ADMIN_KEY || 'trungthu2026';
let ACCEPTING = true;   // toggle: are we accepting new lanterns?
// signed admin cookie, reusing the same HMAC scheme as the user session
function signAdmin() {
  const body = Buffer.from(JSON.stringify({ a: 1, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update('admin.' + body).digest('base64url');
  return body + '.' + sig;
}
function verifyAdmin(token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update('admin.' + body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.a === 1 && Date.now() < o.exp; }
  catch (e) { return false; }
}
function requireAdmin(req, res, next) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)ml_admin=([^;]+)/);
  if (m && verifyAdmin(decodeURIComponent(m[1]))) return next();
  return res.status(401).json({ error: 'admin_required' });
}

// ── AI 3D-render step (WPP proxy · gpt-image-2) ────────────────────
// Turns the child's flat drawing into a realistic, 3D-looking lantern by
// sending it as a reference image to gpt-image-2 through the WPP Creative
// Studio proxy (the local wpp-api-main server, OpenAI-images compatible).
//
// Enable by pointing at the running proxy:
//     WPP_PROXY_URL=http://localhost:3141 npm start
// (defaults to http://localhost:3141 — start wpp-api-main first). If the proxy
// is unreachable OR the call fails, we fall back to the child's drawing so the
// event never gets stuck.
//
// Full art-direction prompt for turning a child's sketch into a physical
// handcrafted bamboo+cellophane lantern. Used for BOTH template coloring and
// free-draw (override per-mode with WPP_IMAGE_PROMPT / WPP_IMAGE_PROMPT_FREE).
const LANTERN_PROMPT =
  'Transform the submitted child\'s sketch into ONE physically believable, handcrafted ' +
  'Vietnamese Mid-Autumn lantern. The sketch is the single source of truth for subject, ' +
  'outer silhouette, internal shapes, proportions, color placement and personality. ' +
  'PRESERVE the recognizable subject, the complete outer silhouette, the relative position ' +
  'and scale of every component, the original color family of each area, irregular curves, ' +
  'uneven proportions and the spontaneous imperfect character of the drawing. Do not beautify, ' +
  'correct, simplify or redesign it. ' +
  'CONVERT the principal outlines into thin, hand-bent bamboo ribs defining the outer contour, ' +
  'important internal divisions and distinctive details, adding only the minimum structural ' +
  'braces needed to be buildable. The bamboo shows natural texture, slightly uneven thickness, ' +
  'imperfect hand-bent curves, small tied or glued joints and minor misalignment. Do not force ' +
  'the drawing into a generic round, oval or star shape. ' +
  'COVER the spaces between ribs with translucent colored cellophane matching the sketch colors, ' +
  'with realistic transparency, gentle wrinkles, hand-cut edges, small seams and overlaps, ' +
  'slightly uneven surface tension, darker color where layers overlap and natural internal ' +
  'reflections. Preserve blank or open areas from the sketch; do not fill every empty space. ' +
  'Give it shallow believable 3D volume, like two similar bamboo contour frames connected by ' +
  'short bamboo spacers, viewed from a front three-quarter camera angle so both the original ' +
  'shape and its depth are visible; it may be slightly crooked or asymmetrical. ' +
  'If the sketch has detached elements, keep their original position and connect them only when ' +
  'structurally necessary with a very thin discreet bamboo bridge or short transparent brace — ' +
  'never with hanging strings, cords or threads. ' +
  'Place ONE small warm amber LED inside that gently illuminates the cellophane from within, ' +
  'reveals the bamboo structure, enriches color where layers overlap and produces a soft warm ' +
  'glow without excessive bloom, fire, sparks or magical effects. ' +
  'Show exactly ONE complete lantern floating freely in space with no visible support, centered, ' +
  'front three-quarter view, entire lantern visible with no cropped parts, clearly separated from ' +
  'the background, natural handcrafted scale, soft cinematic lighting and realistic material ' +
  'rendering on a transparent background. ' +
  'It must NOT look like a flat digital illustration, a smooth plastic object, a polished CGI icon, ' +
  'an inflatable object, a fabric sculpture or a neon sign. ' +
  'STRICT: no hanging string, suspension cord, visible thread, hook or ceiling attachment; no hand ' +
  'holding it; no stand or supporting pole; no added text or logo; no additional characters or ' +
  'decorative objects; no generic traditional lantern surrounding the design; no correction of the ' +
  'drawing; no perfect symmetry; no opaque plastic; no smooth vector surfaces; no redesign into a ' +
  'commercial toy. The lantern floats freely and independently.';

const AI = {
  enabled: (process.env.AI_RENDER ?? '1') !== '0',   // on by default; AI_RENDER=0 to disable
  proxyUrl: (process.env.WPP_PROXY_URL || 'http://localhost:3141').replace(/\/$/, ''),
  proxyKey: process.env.WPP_PROXY_KEY || '',          // only if the proxy sets PROXY_API_KEY
  model: process.env.WPP_IMAGE_MODEL || 'gpt-image-2',
  size: process.env.WPP_IMAGE_SIZE || '1024x1024',    // 1024x1024 | 1536x1024 | 1024x1536
  quality: process.env.WPP_IMAGE_QUALITY || 'low',    // auto | low | medium
  background: process.env.WPP_IMAGE_BACKGROUND || 'transparent',  // auto | transparent | opaque
  prompt: process.env.WPP_IMAGE_PROMPT || LANTERN_PROMPT,
  // free-draw template: turn whatever the child drew INTO a real lantern shaped
  // like their drawing, with a visible bamboo frame for a realistic look.
  freePrompt: process.env.WPP_IMAGE_PROMPT_FREE || LANTERN_PROMPT,
  freeTemplate: 'tu-do',
  timeoutMs: Number(process.env.WPP_IMAGE_TIMEOUT || 90000),
  maxRetries: Number(process.env.WPP_IMAGE_RETRIES || 5),   // retry until AI succeeds
  retryBackoffMs: Number(process.env.WPP_IMAGE_BACKOFF || 3000),
};
console.log(AI.enabled
  ? `AI render: ON  (WPP proxy ${AI.proxyUrl}, model=${AI.model}, quality=${AI.quality})`
  : 'AI render: OFF  (set AI_RENDER=1 + run the WPP proxy to enable; using drawings as-is)');

const app = express();
app.use(express.json({ limit: '8mb' }));       // base64 PNG from the phone

// ── session cookie (HMAC-signed, httpOnly) ─────────────────────────
// payload = base64url(JSON).signature ; signature = HMAC-SHA256(payload, secret)
function signSession(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  // constant-time compare
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!obj.sub || !obj.exp || Date.now() > obj.exp) return null;
    return obj;
  } catch (e) { return null; }
}
// parse our cookie and attach req.user = { sub, email, name, picture } | null
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)ml_session=([^;]+)/);
  req.user = m ? verifySession(decodeURIComponent(m[1])) : null;
  next();
});
// gate for routes that require a signed-in employee
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required' });
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

// simple health check (handy for testing connectivity from a phone)
app.get('/health', (req, res) => res.json({ status: 'ok', ip: lanIP(), time: Date.now() }));

// ── auth endpoints ─────────────────────────────────────────────────
// client sends the Google ID token (credential) from Google Identity Services.
// We verify it against Google's tokeninfo endpoint, check it was issued for our
// client id, then upsert the user and set a signed session cookie.
app.post('/api/auth/google', async (req, res) => {
  const credential = (req.body?.credential || '').toString();
  if (!credential) return res.status(400).json({ error: 'need credential' });
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!r.ok) { console.error('auth invalid_token: tokeninfo status', r.status, (await r.text()).slice(0,200)); return res.status(401).json({ error: 'invalid_token' }); }
    const p = await r.json();
    // token must be minted for THIS app and by Google
    if (p.aud !== GOOGLE_CLIENT_ID) { console.error('auth wrong_audience:', p.aud); return res.status(401).json({ error: 'wrong_audience' }); }
    if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') {
      console.error('auth bad_issuer:', p.iss); return res.status(401).json({ error: 'bad_issuer' });
    }
    if (!p.sub) return res.status(401).json({ error: 'no_sub' });
    db.prepare(`INSERT INTO users (sub,email,name,picture,created) VALUES (?,?,?,?,?)
      ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture`)
      .run(p.sub, p.email || '', p.name || null, p.picture || null, Date.now());
    const exp = Date.now() + SESSION_DAYS*24*3600*1000;
    const token = signSession({ sub: p.sub, email: p.email, name: p.name, picture: p.picture, exp });
    res.setHeader('Set-Cookie',
      `ml_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DAYS*24*3600}; HttpOnly; SameSite=Lax`);
    res.json({ ok: true, user: { sub: p.sub, email: p.email, name: p.name, picture: p.picture } });
  } catch (e) {
    console.error('google auth error:', e.message);
    res.status(500).json({ error: 'auth_failed' });
  }
});
// who am I (client calls on load to decide login vs draw)
app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? { sub: req.user.sub, email: req.user.email, name: req.user.name, picture: req.user.picture } : null,
             clientId: GOOGLE_CLIENT_ID, guestMode: GUEST_MODE });
});
// testing bypass: mint a guest session (only when GUEST_MODE is on)
app.post('/api/auth/guest', (req, res) => {
  if (!GUEST_MODE) return res.status(403).json({ error: 'guest_disabled' });
  const sub = 'guest_' + crypto.randomBytes(9).toString('base64url');
  const name = (req.body?.name || 'Khách').toString().slice(0,16);
  db.prepare(`INSERT INTO users (sub,email,name,picture,created) VALUES (?,?,?,?,?)
    ON CONFLICT(sub) DO NOTHING`).run(sub, '', name, null, Date.now());
  const exp = Date.now() + SESSION_DAYS*24*3600*1000;
  const token = signSession({ sub, email:'', name, picture:null, exp });
  res.setHeader('Set-Cookie',
    `ml_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DAYS*24*3600}; HttpOnly; SameSite=Lax`);
  res.json({ ok: true, user: { sub, name } });
});
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ml_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

// friendly URL for the big screen (so /screen works, not just /screen.html)
app.get('/screen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'screen.html'));
});

// friendly URL for the standalone QR page (own tab / second monitor / print)
app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// "Đèn Sáng Nhất" leaderboard page + spin-the-wheel page
app.get('/rank', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rank.html'));
});
app.get('/rank-height', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rank-height.html'));
});
app.get('/spin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'spin.html'));
});
app.get('/puzzle', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'puzzle.html'));
});
app.get('/shake', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shake.html'));
});
app.get('/quiz', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quiz.html'));
});
app.get('/fortune', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fortune.html'));
});
app.get('/catch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'catch.html'));
});
app.get('/hub', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Admin API ──────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const key = (req.body && req.body.key || '').toString();
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'bad_key' });
  res.setHeader('Set-Cookie',
    `ml_admin=${encodeURIComponent(signAdmin())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ml_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
// public: is the event accepting new lanterns? (phone checks this)
app.get('/api/admin/accepting', (req, res) => res.json({ accepting: ACCEPTING }));
app.post('/api/admin/accepting', requireAdmin, (req, res) => {
  ACCEPTING = !!(req.body && req.body.on);
  io.emit('accepting-changed', { accepting: ACCEPTING });
  res.json({ ok: true, accepting: ACCEPTING });
});
// list every lantern (all statuses), newest first
app.get('/api/admin/lanterns', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, file, ai_file, template, name, wish, status, created FROM lanterns ORDER BY id DESC'
  ).all();
  res.json({ lanterns: rows, accepting: ACCEPTING });
});
// hide from screen/rank -> status='rejected'
app.post('/api/admin/hide', requireAdmin, (req, res) => {
  const id = req.body && req.body.id;
  const row = db.prepare('SELECT id FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE lanterns SET status='rejected' WHERE id=?").run(id);
  io.emit('remove-lantern', { id });
  io.emit('pending-changed');
  res.json({ ok: true });
});
// bring back -> status='approved'
app.post('/api/admin/show', requireAdmin, (req, res) => {
  const id = req.body && req.body.id;
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE lanterns SET status='approved' WHERE id=?").run(id);
  io.emit('new-lantern', { id: row.id, file: row.ai_file || row.file,
    template: row.template, name: row.name, wish: row.wish, created: row.created });
  io.emit('pending-changed');
  res.json({ ok: true });
});

// leaderboard: approved lanterns ranked by TOTAL fires over the whole event
// (newest wins ties). ?voter=... also returns that person's wallet so the page
// can gate the fire buttons.
app.get('/api/leaderboard', (req, res) => {
  const day = today();
  // a lantern's "lửa" (ranking score) = votes it received from others
  //   + the game-fire its OWNER earned (spins + puzzle + other mini games).
  // So playing games raises your own lantern, and votes from others add on top.
  const rows = db.prepare(
    "SELECT l.id, COALESCE(l.ai_file, l.file) AS file, l.name, l.wish, l.user_sub, " +
    "  (SELECT COUNT(*) FROM votes v WHERE v.lantern = l.id) " +
    "  + COALESCE((SELECT SUM(reward) FROM spins   WHERE voter = l.user_sub),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM puzzles WHERE voter = l.user_sub),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM games   WHERE voter = l.user_sub),0) AS fires " +
    "FROM lanterns l WHERE l.status='approved' " +
    "ORDER BY fires DESC, l.id DESC LIMIT 50"
  ).all();
  // identity comes from the signed session cookie, not a client-supplied param
  const voter = req.user ? req.user.sub : null;
  if (voter) ensureCheckin(voter, day);
  // don't leak each lantern's owner sub; expose only a `mine` flag for this voter
  const board = rows.map(({ user_sub, ...r }) => ({ ...r, mine: !!voter && user_sub === voter }));
  res.json({ day, board, wallet: voter ? wallet(voter, day) : null });
});

// bảng xếp hạng ĐỘ CAO — xếp height giảm dần; hòa thì đèn xuất hiện sớm hơn (appeared_at, id) đứng trên
app.get('/api/leaderboard/height', (req, res) => {
  const rows = db.prepare(
    "SELECT id, COALESCE(ai_file, file) AS file, name, height, user_sub " +
    "FROM lanterns WHERE status='approved' AND height > 0 " +
    "ORDER BY height DESC, COALESCE(appeared_at, created) ASC, id ASC LIMIT 50"
  ).all();
  const voter = req.user ? req.user.sub : null;
  const board = rows.map(({ user_sub, ...r }) => ({ ...r, mine: !!voter && user_sub === voter }));
  res.json({ board });
});

// after a voter earns game-fire, their own lantern's score changed — recompute
// its total lửa (votes + game-fire) and broadcast so open /rank pages resort live.
function emitOwnerFire(sub) {
  const lant = db.prepare("SELECT id FROM lanterns WHERE user_sub=? AND status='approved' ORDER BY id DESC LIMIT 1").get(sub);
  if (!lant) return;
  const fires = db.prepare(
    "SELECT (SELECT COUNT(*) FROM votes WHERE lantern=?) " +
    "  + COALESCE((SELECT SUM(reward) FROM spins   WHERE voter=?),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM puzzles WHERE voter=?),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM games   WHERE voter=?),0) AS n"
  ).get(lant.id, sub, sub, sub).n;
  io.emit('fire-changed', { id: lant.id, fires });
}

// spin the wheel once per day -> earn 1–4 fires. Returns the landed segment
// index (so the UI can animate to it) and the reward.
app.post('/api/spin', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (!SPIN_UNLIMITED && !GAMES_UNLIMITED && db.prepare('SELECT 1 FROM spins WHERE voter=? AND day=?').get(v, day)) {
    return res.status(409).json({ error: 'already_spun', wallet: wallet(v, day) });
  }
  const segment = Math.floor(Math.random() * WHEEL.length);
  const reward = WHEEL[segment];
  db.prepare('INSERT INTO spins (voter, day, reward, created) VALUES (?, ?, ?, ?)')
    .run(v, day, reward, Date.now());
  // check-in streak: this spin may have just reached a new distinct-day milestone.
  // Award the bonus once, as an extra spins row (so it folds into earned/balance).
  const days = spinDays(v);
  const bonus = STREAK_BONUS[days] || 0;
  if (bonus) {
    db.prepare('INSERT INTO spins (voter, day, reward, created) VALUES (?, ?, ?, ?)')
      .run(v, day, bonus, Date.now());
  }
  emitOwnerFire(v);
  res.json({ ok: true, segment, reward, bonus, days, wheel: WHEEL, wallet: wallet(v, day) });
});

// when testing is OFF, a voter may play only ONE mini game per day. Returns true
// if they've already played any of the 5 today (so the route should reject).
function playedAnyGameToday(voter, day) {
  if (GAMES_UNLIMITED) return false;
  const p = db.prepare('SELECT 1 FROM puzzles WHERE voter=? AND day=?').get(voter, day);
  const g = db.prepare('SELECT 1 FROM games WHERE voter=? AND day=?').get(voter, day);
  return !!(p || g);
}

// roll-the-mooncake maze: client sends `goals` (how many times it reached the
// lantern). Fire table: 1-3 -> 1, 4-6 -> 2, 7-9 -> 3 … capped at PUZZLE_MAX_REWARD.
// First play per day only.
app.post('/api/puzzle/win', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (playedAnyGameToday(v, day)) return res.status(409).json({ error: 'daily_limit', wallet: wallet(v, day) });
  const goals = Math.max(0, Math.min(99, Number(req.body?.goals) || 0));
  // fire table by score: 1-3 goals -> 1 lửa, 4-6 -> 2, 7-9 -> 3 … (capped at PUZZLE_MAX_REWARD)
  const reward = Math.min(PUZZLE_MAX_REWARD, Math.max(1, Math.ceil(goals / 3)));
  const r = db.prepare('INSERT OR IGNORE INTO puzzles (voter, day, reward, created) VALUES (?, ?, ?, ?)')
    .run(v, gameDay(day), reward, Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_won', wallet: wallet(v, day) });
  emitOwnerFire(v);
  res.json({ ok: true, reward, goals, wallet: wallet(v, day) });
});

// shake game: client sends score 0..100 (how hard they shook). Fire table by
// intensity: >=80% -> 4, 50-79% -> 3, <50% -> 2. First play per day only.
app.post('/api/shake/win', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (playedAnyGameToday(v, day)) return res.status(409).json({ error: 'daily_limit', wallet: wallet(v, day) });
  const score = Math.max(0, Math.min(100, Number(req.body?.score) || 0));
  const reward = score >= 80 ? SHAKE_MAX_REWARD : score >= 50 ? 3 : 2;
  const r = db.prepare("INSERT OR IGNORE INTO games (voter, day, game, reward, data, created) VALUES (?, ?, 'shake', ?, ?, ?)")
    .run(v, gameDay(day), reward, JSON.stringify({ score }), Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_played', wallet: wallet(v, day) });
  emitOwnerFire(v);
  res.json({ ok: true, reward, score, wallet: wallet(v, day) });
});

// quiz: flat reward the first time per day. `result` is the mooncake key the
// client computed, stored just for fun/analytics.
app.post('/api/quiz/win', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (playedAnyGameToday(v, day)) return res.status(409).json({ error: 'daily_limit', wallet: wallet(v, day) });
  const result = (req.body?.result || '').toString().slice(0, 40);
  const r = db.prepare("INSERT OR IGNORE INTO games (voter, day, game, reward, data, created) VALUES (?, ?, 'quiz', ?, ?, ?)")
    .run(v, gameDay(day), QUIZ_REWARD, JSON.stringify({ result }), Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_played', wallet: wallet(v, day) });
  emitOwnerFire(v);
  res.json({ ok: true, reward: QUIZ_REWARD, wallet: wallet(v, day) });
});

// bake-the-mooncake: client sends score 0..100 (in-zone time + combo bonus).
// Fire table: >=80% -> 4, 50-79% -> 3, <50% -> 2. First play per day only.
app.post('/api/fortune/win', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (playedAnyGameToday(v, day)) return res.status(409).json({ error: 'daily_limit', wallet: wallet(v, day) });
  const score = Math.max(0, Math.min(100, Number(req.body?.score) || 0));
  const reward = score >= 80 ? BAKE_MAX_REWARD : score >= 50 ? 3 : 2;
  const r = db.prepare("INSERT OR IGNORE INTO games (voter, day, game, reward, data, created) VALUES (?, ?, 'fortune', ?, ?, ?)")
    .run(v, gameDay(day), reward, JSON.stringify({ score }), Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_played', wallet: wallet(v, day) });
  emitOwnerFire(v);
  res.json({ ok: true, reward, score, wallet: wallet(v, day) });
});

// catch-the-rabbit: client sends `score` = catch rate % (caught / spawned).
// Fire table by accuracy: >=80% -> 4, 50-79% -> 3, <50% -> 2. First play per day only.
app.post('/api/catch/win', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  if (playedAnyGameToday(v, day)) return res.status(409).json({ error: 'daily_limit', wallet: wallet(v, day) });
  const score = Math.max(0, Math.min(100, Number(req.body?.score) || 0));
  const reward = score >= 80 ? CATCH_MAX_REWARD : score >= 50 ? 3 : 2;
  const r = db.prepare("INSERT OR IGNORE INTO games (voter, day, game, reward, data, created) VALUES (?, ?, 'catch', ?, ?, ?)")
    .run(v, gameDay(day), reward, JSON.stringify({ score }), Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_played', wallet: wallet(v, day) });
  emitOwnerFire(v);
  res.json({ ok: true, reward, score, wallet: wallet(v, day) });
});

// ── Game "tạo gió" tăng độ cao (bước 5) ────────────────────────────
// đèn approved mới nhất của user (kèm appeared + height)
function myLanternRow(sub){
  return db.prepare(
    "SELECT id, appeared, height FROM lanterns WHERE user_sub=? AND status='approved' ORDER BY id DESC LIMIT 1"
  ).get(sub);
}
function heightPlaysUsed(sub, day){
  return db.prepare('SELECT COUNT(*) AS n FROM height_plays WHERE user_sub=? AND day=?').get(sub, day).n;
}
function activePlay(sub){
  const now = Date.now();
  return db.prepare('SELECT * FROM height_plays WHERE user_sub=? AND finalized=0 AND ends_at>? ORDER BY id DESC LIMIT 1').get(sub, now);
}

// trạng thái bước 5: độ cao, lượt còn lại, lượt đang chạy (nếu có)
app.get('/api/height/state', requireAuth, (req, res) => {
  const sub = req.user.sub, day = todayVN();
  const lant = myLanternRow(sub);
  if (!lant) return res.json({ hasLantern: false });
  const used = heightPlaysUsed(sub, day);
  const ap = activePlay(sub);
  res.json({
    hasLantern: true, appeared: !!lant.appeared, height: lant.height,
    playsLeft: Math.max(0, HEIGHT_CFG.playsPerDay - used),
    playsPerDay: HEIGHT_CFG.playsPerDay, durationMs: HEIGHT_CFG.durationMs,
    active: ap ? { id: ap.id, endsAt: ap.ends_at } : null,
  });
});

// bắt đầu 1 lượt — idempotent theo request_id, trừ 1 lượt khi tạo mới
app.post('/api/height/start', requireAuth, (req, res) => {
  const sub = req.user.sub, day = todayVN(), now = Date.now();
  const rid = (req.body && req.body.request_id || '').toString().slice(0, 64);
  if (!rid) return res.status(400).json({ error: 'need_request_id' });
  const lant = myLanternRow(sub);
  if (!lant) return res.status(404).json({ error: 'no_lantern' });
  if (!lant.appeared) return res.status(403).json({ error: 'not_appeared' });
  // cùng request_id -> trả lại lượt đã tạo (không tạo mới, không trừ thêm)
  const existing = db.prepare('SELECT * FROM height_plays WHERE request_id=?').get(rid);
  if (existing) return res.json({ ok: true, playId: existing.id, endsAt: existing.ends_at, resumed: true });
  // đang có lượt chạy dở -> khôi phục thay vì tạo mới
  const ap = activePlay(sub);
  if (ap) return res.json({ ok: true, playId: ap.id, endsAt: ap.ends_at, resumed: true });
  // hết lượt?
  if (heightPlaysUsed(sub, day) >= HEIGHT_CFG.playsPerDay)
    return res.status(403).json({ error: 'no_plays_left', playsLeft: 0 });
  const endsAt = now + HEIGHT_CFG.durationMs;
  const info = db.prepare(
    'INSERT INTO height_plays (user_sub, lantern_id, day, request_id, started_at, ends_at, created) VALUES (?,?,?,?,?,?,?)'
  ).run(sub, lant.id, day, rid, now, endsAt, now);
  res.json({ ok: true, playId: info.lastInsertRowid, endsAt,
    playsLeft: Math.max(0, HEIGHT_CFG.playsPerDay - heightPlaysUsed(sub, day)) });
});

// chốt 1 lượt — server tính mét từ số hits (đã chặn trần), cộng vào lantern.height
app.post('/api/height/finish', requireAuth, (req, res) => {
  const sub = req.user.sub, day = todayVN(), now = Date.now();
  const playId = Number(req.body && req.body.play_id);
  const hits = Math.max(0, Number(req.body && req.body.hits) || 0);
  const play = db.prepare('SELECT * FROM height_plays WHERE id=? AND user_sub=?').get(playId, sub);
  if (!play) return res.status(404).json({ error: 'no_play' });
  const lant = db.prepare('SELECT id, height FROM lanterns WHERE id=?').get(play.lantern_id);
  // đã chốt rồi -> idempotent: trả kết quả cũ, không cộng lần nữa
  if (play.finalized) {
    return res.json({ ok: true, added: play.meters, total: lant ? lant.height : 0,
      playsLeft: Math.max(0, HEIGHT_CFG.playsPerDay - heightPlaysUsed(sub, day)), already: true });
  }
  // chặn trần hits theo thời lượng, đổi ra mét
  const capped = Math.min(hits, HEIGHT_CFG.maxHits);
  const added = Math.min(capped * HEIGHT_CFG.metersPerHit, HEIGHT_CFG.maxMeters);
  const tx = db.transaction(() => {
    db.prepare('UPDATE height_plays SET finalized=1, meters=? WHERE id=?').run(added, playId);
    db.prepare('UPDATE lanterns SET height=height+? WHERE id=?').run(added, play.lantern_id);
  });
  tx();
  const total = db.prepare('SELECT height FROM lanterns WHERE id=?').get(play.lantern_id).height;
  io.emit('height-changed', { id: play.lantern_id, height: total });
  res.json({ ok: true, added, total,
    playsLeft: Math.max(0, HEIGHT_CFG.playsPerDay - heightPlaysUsed(sub, day)) });
});

// record today's check-in (idempotent) -> grants +1 vote the first time each day
function ensureCheckin(voter, day) {
  db.prepare('INSERT OR IGNORE INTO checkins (voter, day, created) VALUES (?, ?, ?)')
    .run(voter, day, Date.now());
}

// how many fires this voter still has to spend today (and whether they've spun)
app.get('/api/wallet', (req, res) => {
  if (!req.user) return res.json({ day: today(), wheel: WHEEL, wallet: null });
  ensureCheckin(req.user.sub, today());   // showing up today = +1 vote (once/day)
  res.json({ day: today(), wheel: WHEEL, wallet: wallet(req.user.sub, today()) });
});

// cast N votes on a lantern (default 1). Votes are separate from fire; you may
// pile several on one lantern or spread them, but never vote your own lantern.
app.post('/api/vote', requireAuth, (req, res) => {
  const day = today();
  const v = req.user.sub;
  const lanternId = Number(req.body?.id);
  const n = Math.max(1, Math.min(50, Number(req.body?.n) || 1));
  if (!lanternId) return res.status(400).json({ error: 'need id' });
  const row = db.prepare("SELECT id, user_sub FROM lanterns WHERE id=? AND status='approved'").get(lanternId);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.user_sub && row.user_sub === v) return res.status(403).json({ error: 'no_self_vote', wallet: wallet(v, day) });
  ensureCheckin(v, day);
  const w = wallet(v, day);
  if (w.voteBalance < n) return res.status(403).json({ error: 'not_enough_votes', wallet: w });
  const ins = db.prepare('INSERT INTO votes (lantern, voter, day, created) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => { for (let i=0;i<n;i++) ins.run(lanternId, v, day, Date.now()); });
  tx();
  // total lửa = votes received + the target owner's own game-fire (match the board)
  const votesGot = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE lantern=?').get(lanternId).n;
  const owner = row.user_sub;
  const gameFire = owner ? db.prepare(
    "SELECT COALESCE((SELECT SUM(reward) FROM spins   WHERE voter=?),0) " +
    "     + COALESCE((SELECT SUM(reward) FROM puzzles WHERE voter=?),0) " +
    "     + COALESCE((SELECT SUM(reward) FROM games   WHERE voter=?),0) AS n"
  ).get(owner, owner, owner).n : 0;
  const fires = votesGot + gameFire;
  io.emit('fire-changed', { id: lanternId, fires });
  res.json({ ok: true, fires, wallet: wallet(v, day) });
});

// testing toggle: ON = play every game unlimited times; OFF = once per day.
// Server-wide (affects everyone) and resets to the env default on restart.
app.get('/api/testing', (req, res) => res.json({ testing: GAMES_UNLIMITED }));
app.post('/api/testing', (req, res) => {
  GAMES_UNLIMITED = !!(req.body && req.body.on);
  res.json({ testing: GAMES_UNLIMITED });
});

// spend one fire on a lantern. Requires balance > 0 and not already fired today.
app.post('/api/fire', requireAuth, (req, res) => {
  const day = today();
  const lanternId = Number(req.body?.id);
  const v = req.user.sub;
  if (!lanternId) return res.status(400).json({ error: 'need id' });
  const row = db.prepare("SELECT id FROM lanterns WHERE id=? AND status='approved'").get(lanternId);
  if (!row) return res.status(404).json({ error: 'not found' });
  const w = wallet(v, day);
  if (w.balance <= 0) return res.status(403).json({ error: 'no_fires', wallet: w });
  // INSERT OR IGNORE: already fired this lantern today => no-op, refund nothing spent
  const r = db.prepare('INSERT OR IGNORE INTO fires (lantern, voter, day, created) VALUES (?, ?, ?, ?)')
    .run(lanternId, v, day, Date.now());
  if (r.changes === 0) return res.status(409).json({ error: 'already_fired', wallet: w });
  const fires = db.prepare('SELECT COUNT(*) AS n FROM fires WHERE lantern=? AND day=?').get(lanternId, day).n;
  io.emit('fire-changed', { id: lanternId, fires });
  res.json({ ok: true, fires, wallet: wallet(v, day) });
});

// list available lantern templates (any *_lines.png in public/templates)
app.get('/api/templates', (req, res) => {
  const dir = path.join(__dirname, 'public', 'templates');
  const names = fs.readdirSync(dir)
    .filter(f => f.endsWith('_lines.png'))
    .map(f => f.replace(/_lines\.png$/, ''))
    .filter(n => n !== 'star');            // hide the built-in placeholder
  res.json(names);
});

// the lantern this device already released (if any) — the phone calls this on
// load to decide: show "your lantern" instead of the draw flow. Includes its
// current total fires + rank so the child sees how their lantern is doing.
app.get('/api/my-lantern', (req, res) => {
  if (!req.user) return res.json({ lantern: null });
  const row = db.prepare(
    "SELECT id, COALESCE(ai_file, file) AS file, name, wish, status, appeared, height FROM lanterns " +
    "WHERE user_sub=? AND status='approved' ORDER BY id DESC LIMIT 1"
  ).get(req.user.sub);
  if (!row) return res.json({ lantern: null });
  // score = votes received + this owner's own game-fire (same formula as the board)
  const sub = req.user.sub;
  const gameFire = db.prepare(
    "SELECT COALESCE((SELECT SUM(reward) FROM spins   WHERE voter=?),0) " +
    "     + COALESCE((SELECT SUM(reward) FROM puzzles WHERE voter=?),0) " +
    "     + COALESCE((SELECT SUM(reward) FROM games   WHERE voter=?),0) AS n"
  ).get(sub, sub, sub).n;
  const votesGot = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE lantern=?').get(row.id).n;
  const fires = votesGot + gameFire;
  const rank = db.prepare(
    "SELECT COUNT(*)+1 AS r FROM lanterns l WHERE l.status='approved' AND " +
    "( (SELECT COUNT(*) FROM votes v WHERE v.lantern=l.id) " +
    "  + COALESCE((SELECT SUM(reward) FROM spins   WHERE voter=l.user_sub),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM puzzles WHERE voter=l.user_sub),0) " +
    "  + COALESCE((SELECT SUM(reward) FROM games   WHERE voter=l.user_sub),0) ) > ?"
  ).get(fires).r;
  res.json({ lantern: { ...row, fires, rank } });
});

// most recent APPROVED lanterns, newest last — the screen asks for these on load
// (prefer the AI render if one exists)
app.get('/api/recent', (req, res) => {
  const rows = db.prepare(
    "SELECT id, COALESCE(ai_file, file) AS file, template, name, wish, created " +
    "FROM lanterns WHERE status='approved' ORDER BY id DESC LIMIT ?"
  ).all(MAX_ON_SCREEN);
  res.json(rows.reverse());
});

// The address kids reach the colouring page at. Behind Cloudflare Tunnel this
// MUST be the public URL (e.g. https://lantern.example.com), not the LAN IP —
// set PUBLIC_URL in the environment. Falls back to the LAN IP for local dev.
function publicBase() {
  const u = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  return u || `http://${lanIP()}:${PORT}`;
}

// QR (Mid-Autumn colours) pointing at the phone colouring page — shown on the big screen
app.get('/api/qr', async (req, res) => {
  const url = publicBase();
  try {
    const dataUrl = await qrcode.toDataURL(url, {
      margin: 2, width: 720, errorCorrectionLevel: 'M',   // M = ít module hơn -> dễ quét khi in/hiển thị nhỏ
      color: { dark: '#000000', light: '#ffffff' },       // đen thuần trên trắng = tương phản tối đa
    });
    res.json({ url, dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr failed' });
  }
});

// NEW WORKFLOW — child previews the AI result before it goes to the operator:
//   POST /preview  -> run AI now, return {id, ai} (base64) so the child sees it
//   POST /confirm  -> child likes it: fly it straight to the screen (no moderation)
//   (no confirm / redraw = the 'preview' row is just left; /preview overwrites on retry)
app.post('/preview', requireAuth, async (req, res) => {
  const { image, template, name } = req.body || {};
  if (!image || !image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'need a PNG data URL' });
  }
  const sub = req.user.sub;
  // one lantern per Google account: if already released one, don't allow another.
  const existing = db.prepare("SELECT id FROM lanterns WHERE user_sub=? AND status='approved'").get(sub);
  if (existing) return res.status(409).json({ error: 'already_have', id: existing.id });
  const buf = Buffer.from(image.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = `lantern_${Date.now()}_${Math.floor(performance.now() * 1000) % 100000}.png`;
  fs.writeFileSync(path.join(LANTERN_DIR, file), buf);
  const child = (name || '').toString().trim().slice(0, 16) || null;
  const created = Date.now();
  const info = db.prepare(
    "INSERT INTO lanterns (file, template, name, status, user_sub, created) VALUES (?, ?, ?, 'preview', ?, ?)"
  ).run(file, template || null, child, sub, created);
  const id = info.lastInsertRowid;

  if (!AI.enabled) {
    // no AI: preview the raw drawing; /confirm will fly it to the screen
    return res.json({ id, ai: image, aiEnabled: false });
  }

  const prompt = (template === AI.freeTemplate) ? AI.freePrompt : AI.prompt;
  try {
    const aiBuf = await aiRenderWithRetry(buf, prompt);
    const aiFile = file.replace(/\.png$/, '') + '_ai.png';
    fs.writeFileSync(path.join(LANTERN_DIR, aiFile), aiBuf);
    db.prepare("UPDATE lanterns SET ai_file=? WHERE id=?").run(aiFile, id);
    res.json({ id, ai: 'data:image/png;base64,' + aiBuf.toString('base64'), aiEnabled: true });
  } catch (e) {
    console.error(`preview AI failed #${id}:`, e.message);
    res.status(502).json({ id, error: 'ai_failed', message: 'AI render failed' });
  }
});

// bé viết điều ước xong -> CHỈ lưu, chưa lên screen (đợi bấm "Thả lên Bầu trời")
app.post('/confirm', (req, res) => {
  const { id, wish } = req.body || {};
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const w = (wish || '').toString().trim().slice(0, 140) || null;
  db.prepare("UPDATE lanterns SET status='ready', wish=? WHERE id=?").run(w, id);
  res.json({ ok: true });
});

// bé bấm "Thả lên Bầu trời" -> giờ mới bay lên /screen
app.post('/release', requireAuth, (req, res) => {
  const { id } = req.body || {};
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  // the lantern must belong to the signed-in account
  if (row.user_sub && row.user_sub !== req.user.sub) return res.status(403).json({ error: 'not_yours' });
  // one lantern per account: block if this account already released a different one.
  const existing = db.prepare("SELECT id FROM lanterns WHERE user_sub=? AND status='approved' AND id<>?").get(req.user.sub, id);
  if (existing) return res.status(409).json({ error: 'already_have', id: existing.id });
  db.prepare("UPDATE lanterns SET status='approved' WHERE id=?").run(id);
  io.emit('new-lantern', { id: row.id, file: row.ai_file || row.file,   // ưu tiên ảnh AI
    template: row.template, name: row.name, wish: row.wish, created: row.created });
  res.json({ ok: true });
});

// phone posts { image: "data:image/png;base64,...", template: "star", name: "Bi" }
app.post('/submit', (req, res) => {
  if (!ACCEPTING) return res.status(503).json({ error: 'closed' });
  const { image, template, name } = req.body || {};
  if (!image || !image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'need a PNG data URL' });
  }
  const b64 = image.replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const file = `lantern_${Date.now()}_${Math.floor(performance.now() * 1000) % 100000}.png`;
  fs.writeFileSync(path.join(LANTERN_DIR, file), buf);

  const child = (name || '').toString().trim().slice(0, 16) || null;
  const created = Date.now();
  // status flow:  AI on -> 'processing' -> (AI done) -> 'pending' -> admin -> 'approved'
  //               AI off, moderation on -> 'pending'
  //               both off -> 'approved'
  const status = AI.enabled ? 'processing' : (MODERATION ? 'pending' : 'approved');
  const info = db.prepare(
    'INSERT INTO lanterns (file, template, name, status, created) VALUES (?, ?, ?, ?, ?)'
  ).run(file, template || null, child, status, created);
  const id = info.lastInsertRowid;
  const lantern = { id, file, template: template || null, name: child, created };

  if (status === 'approved') {
    io.emit('new-lantern', lantern);   // no AI, no moderation: straight to screen
  } else {
    io.emit('pending-changed');        // show in admin (as processing or pending)
    if (AI.enabled) runAI(id, buf, template).catch(e => console.error('AI error', e));
  }
  res.json({ ok: true, lantern, moderated: MODERATION, ai: AI.enabled });
});

// One AI attempt: call the WPP proxy (gpt-image-2, image-to-image via `images`),
// return the rendered+bg-removed PNG buffer. Throws on any failure.
async function aiRenderOnce(srcBuf, prompt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI.timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (AI.proxyKey) headers['x-api-key'] = AI.proxyKey;
  try {
    const resp = await fetch(`${AI.proxyUrl}/v1/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: AI.model, prompt: prompt || AI.prompt, size: AI.size,
        quality: AI.quality, background: AI.background,
        images: ['data:image/png;base64,' + srcBuf.toString('base64')],
        n: 1, response_format: 'b64_json',
      }),
      signal: ctl.signal,
    });
    if (!resp.ok) throw new Error('proxy ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
    const out = await resp.json();
    const item = out?.data?.[0] || {};
    let aiBuf;
    if (item.b64_json) aiBuf = Buffer.from(item.b64_json, 'base64');
    else if (item.url) aiBuf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
    else throw new Error('no image in proxy response');

    try { aiBuf = removeBackground(aiBuf); }
    catch (e) { console.warn('bg-remove skipped:', e.message); }
    return aiBuf;
  } finally {
    clearTimeout(timer);
  }
}

// aiRenderOnce wrapped in the retry loop; throws if all attempts fail.
async function aiRenderWithRetry(srcBuf, prompt) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr;
  for (let attempt = 1; ; attempt++) {
    try { return await aiRenderOnce(srcBuf, prompt); }
    catch (e) {
      lastErr = e;
      if (AI.maxRetries > 0 && attempt >= AI.maxRetries) throw lastErr;
      console.error(`AI attempt ${attempt} failed: ${e.message} — retrying`);
      await sleep(AI.retryBackoffMs * Math.min(attempt, 4));
    }
  }
}

// EVERY lantern must be AI-rendered. Retry until the proxy succeeds; the row
// stays 'processing' (spinner in admin) across retries and only moves to
// 'pending' once we have a real AI image — never the raw drawing.
async function runAI(id, srcBuf, template) {
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // free-draw template gets an open prompt (render the actual subject, not a lantern)
  const prompt = (template === AI.freeTemplate) ? AI.freePrompt : AI.prompt;

  for (let attempt = 1; ; attempt++) {
    // stop if the operator rejected it while we were retrying
    const cur = db.prepare('SELECT status FROM lanterns WHERE id=?').get(id);
    if (!cur || cur.status === 'rejected') return;
    try {
      const aiBuf = await aiRenderOnce(srcBuf, prompt);
      const aiFile = row.file.replace(/\.png$/, '') + '_ai.png';
      fs.writeFileSync(path.join(LANTERN_DIR, aiFile), aiBuf);
      db.prepare("UPDATE lanterns SET ai_file=?, status='pending' WHERE id=?").run(aiFile, id);
      console.log(`AI ok  #${id} -> ${aiFile} (attempt ${attempt})`);
      break;
    } catch (e) {
      const giveUp = AI.maxRetries > 0 && attempt >= AI.maxRetries;
      console.error(`AI attempt ${attempt} failed #${id}: ${e.message}` +
        (giveUp ? ' — max retries reached, using drawing' : ' — retrying'));
      if (giveUp) {
        // last-resort so the queue never hard-locks; rare in practice
        db.prepare("UPDATE lanterns SET status='pending' WHERE id=?").run(id);
        break;
      }
      io.emit('pending-changed');   // keep admin spinner fresh
      await sleep(AI.retryBackoffMs * Math.min(attempt, 4));
    }
  }
  io.emit('pending-changed');
}

const server = http.createServer(app);
const io = new Server(server);
io.on('connection', (s) => {
  console.log('screen connected:', s.id);
  // /screen báo đèn đã hiển thị -> đánh dấu appeared (1 lần) -> báo về điện thoại
  s.on('lantern-shown', ({ id } = {}) => {
    if (id == null) return;
    const row = db.prepare('SELECT id, appeared FROM lanterns WHERE id=?').get(id);
    if (!row || row.appeared) return;                 // chống lặp: chỉ lần đầu
    db.prepare('UPDATE lanterns SET appeared=1, appeared_at=? WHERE id=?').run(Date.now(), id);
    io.emit('lantern-appeared', { id });
  });
});

// find this laptop's LAN IP so phones on the same WiFi can reach it
function lanIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// bind 0.0.0.0 so Docker port-forwarding / Cloudflare Tunnel can reach it
server.listen(PORT, '0.0.0.0', () => {
  const url = publicBase();
  console.log('\n=== Mid-Autumn Lanterns ===');
  console.log('Phone colouring page :', url);
  console.log('Big screen           :', `${url}/screen`);
  console.log('QR page              :', `${url}/qr`);
  console.log('AI proxy             :', AI.enabled ? AI.proxyUrl : 'OFF');
  console.log('\nKids scan this QR to open the colouring page:\n');
  qrcode.toString(url, { type: 'terminal', small: true }, (err, art) => {
    if (!err) console.log(art);
  });
});
