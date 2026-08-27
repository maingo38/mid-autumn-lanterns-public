// Mid-Autumn Lanterns — event server.
// Runs entirely on ONE laptop at the booth. No internet needed.
//   - serves the phone colouring page (/) and the big-screen page (/screen)
//   - receives finished lanterns (POST /submit) -> saves to disk + SQLite
//   - pushes "new-lantern" to the screen in real time via Socket.IO
//   - prints a QR code in the terminal so kids can open the page
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const qrcode = require('qrcode');
const { PNG } = require('pngjs');

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

// set to false to skip moderation (auto-approve everything, like before)
const MODERATION = true;

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
const AI = {
  enabled: (process.env.AI_RENDER ?? '1') !== '0',   // on by default; AI_RENDER=0 to disable
  proxyUrl: (process.env.WPP_PROXY_URL || 'http://localhost:3141').replace(/\/$/, ''),
  proxyKey: process.env.WPP_PROXY_KEY || '',          // only if the proxy sets PROXY_API_KEY
  model: process.env.WPP_IMAGE_MODEL || 'gpt-image-2',
  size: process.env.WPP_IMAGE_SIZE || '1024x1024',    // 1024x1024 | 1536x1024 | 1024x1536
  quality: process.env.WPP_IMAGE_QUALITY || 'low',    // auto | low | medium
  background: process.env.WPP_IMAGE_BACKGROUND || 'transparent',  // auto | transparent | opaque
  prompt: process.env.WPP_IMAGE_PROMPT ||
    'Transform this child\'s lantern drawing into a realistic 3D Vietnamese Mid-Autumn ' +
    'paper lantern. Keep the SAME shape, colors and decorations the child drew, but make ' +
    'it look like a real glowing lantern: warm candlelight from inside, paper texture, ' +
    'soft shadows, festive studio product render on a transparent background.',
  // free-draw template: don't force a lantern — render whatever the child actually drew
  freePrompt: process.env.WPP_IMAGE_PROMPT_FREE ||
    'Turn this child\'s freehand drawing into a realistic, cute 3D render of the SAME ' +
    'subject the child drew — keep its shapes, colors and character exactly, just make it ' +
    'look real and three-dimensional with soft lighting and gentle shadows, glowing softly ' +
    'as if lit for a Mid-Autumn festival night, on a transparent background.',
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
app.use(express.static(path.join(__dirname, 'public')));

// simple health check (handy for testing connectivity from a phone)
app.get('/health', (req, res) => res.json({ status: 'ok', ip: lanIP(), time: Date.now() }));

// friendly URL for the big screen (so /screen works, not just /screen.html)
app.get('/screen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'screen.html'));
});

// friendly URL for the standalone QR page (own tab / second monitor / print)
app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// operator moderation console
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

// most recent APPROVED lanterns, newest last — the screen asks for these on load
// (prefer the AI render if one exists)
app.get('/api/recent', (req, res) => {
  const rows = db.prepare(
    "SELECT id, COALESCE(ai_file, file) AS file, template, name, wish, created " +
    "FROM lanterns WHERE status='approved' ORDER BY id DESC LIMIT ?"
  ).all(MAX_ON_SCREEN);
  res.json(rows.reverse());
});

// pending (+ still-processing) lanterns for the operator console
app.get('/api/pending', (req, res) => {
  const rows = db.prepare(
    "SELECT id, file, ai_file, template, name, wish, status, created FROM lanterns " +
    "WHERE status IN ('pending','processing') ORDER BY id ASC"
  ).all();
  res.json(rows);
});

// operator decision: approve -> fly it to the screen; reject -> delete the image
app.post('/api/moderate', (req, res) => {
  const { id, action } = req.body || {};
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  if (action === 'approve') {
    db.prepare("UPDATE lanterns SET status='approved' WHERE id=?").run(id);
    io.emit('new-lantern', { id: row.id, file: row.ai_file || row.file,   // prefer AI render
      template: row.template, name: row.name, wish: row.wish, created: row.created });
    io.emit('pending-changed');
    return res.json({ ok: true });
  }
  if (action === 'reject') {
    db.prepare("UPDATE lanterns SET status='rejected' WHERE id=?").run(id);
    try { fs.unlinkSync(path.join(LANTERN_DIR, row.file)); } catch (e) {}
    if (row.ai_file) try { fs.unlinkSync(path.join(LANTERN_DIR, row.ai_file)); } catch (e) {}
    io.emit('pending-changed');
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'bad action' });
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
      margin: 2, width: 560, errorCorrectionLevel: 'H',   // high error-correction = easier scan
      color: { dark: '#160a28', light: '#ffffff' },       // dark on solid white = max contrast
    });
    res.json({ url, dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr failed' });
  }
});

// NEW WORKFLOW — child previews the AI result before it goes to the operator:
//   POST /preview  -> run AI now, return {id, ai} (base64) so the child sees it
//   POST /confirm  -> child likes it: move that row into the admin queue
//   (no confirm / redraw = the 'preview' row is just left; /preview overwrites on retry)
app.post('/preview', async (req, res) => {
  const { image, template, name } = req.body || {};
  if (!image || !image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'need a PNG data URL' });
  }
  const buf = Buffer.from(image.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = `lantern_${Date.now()}_${Math.floor(performance.now() * 1000) % 100000}.png`;
  fs.writeFileSync(path.join(LANTERN_DIR, file), buf);
  const child = (name || '').toString().trim().slice(0, 16) || null;
  const created = Date.now();
  const info = db.prepare(
    "INSERT INTO lanterns (file, template, name, status, created) VALUES (?, ?, ?, 'preview', ?)"
  ).run(file, template || null, child, created);
  const id = info.lastInsertRowid;

  if (!AI.enabled) {
    // no AI: nothing to preview — behave like a straight submit into moderation
    db.prepare("UPDATE lanterns SET status='pending' WHERE id=?").run(id);
    io.emit('pending-changed');
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

app.post('/confirm', (req, res) => {
  const { id, wish } = req.body || {};
  const row = db.prepare('SELECT * FROM lanterns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const w = (wish || '').toString().trim().slice(0, 140) || null;
  db.prepare("UPDATE lanterns SET status='pending', wish=? WHERE id=?").run(w, id);
  io.emit('pending-changed');
  res.json({ ok: true, moderated: MODERATION });
});

// phone posts { image: "data:image/png;base64,...", template: "star", name: "Bi" }
app.post('/submit', (req, res) => {
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
io.on('connection', (s) => console.log('screen connected:', s.id));

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
  console.log('Admin (duyệt)        :', `${url}/admin`);
  console.log('QR page              :', `${url}/qr`);
  console.log('AI proxy             :', AI.enabled ? AI.proxyUrl : 'OFF');
  console.log('\nKids scan this QR to open the colouring page:\n');
  qrcode.toString(url, { type: 'terminal', small: true }, (err, art) => {
    if (!err) console.log(art);
  });
});
