# Test Plan — Lửa (fires) / Quạt (fans/plays) / Độ cao (height)

> Tài liệu phân tích end-to-end + thiết kế test cho 3 con số cốt lõi của app
> **Mid-Autumn Lanterns**. Chỉ phân tích & thiết kế — **không sửa code sản phẩm**.
> Mọi trích dẫn dạng `server.js:dòng` là snapshot tại thời điểm viết
> (server.js ~1158 dòng, commit `64852c0`).

---

## 0. Từ vựng & ánh xạ 3 con số

| Khái niệm | Ý nghĩa trong code | Nguồn sự thật (server) |
|---|---|---|
| **Lửa (fire)** | Tiền tệ kiếm được từ vòng quay + 5 mini-game. **KHÔNG** phải bảng SQL `fires`. Là `wallet.earned` = tổng `reward` của `spins` + `puzzles` + `games`. | `wallet()` `server.js:310-349` |
| **balance** | Lửa còn lại = `earned - spent`. `spent` = số lượt `paid` × `FIRE_PER_FAN` (mặc định 3). | `server.js:314-339` |
| **Quạt / lượt (fanPlays / playsLeft)** | Số lượt game "tạo gió" dùng được = `freePlays` + `floor(balance / FIRE_PER_FAN)`. | `server.js:341` |
| **freePlays** | Lượt miễn phí: 1 lần `release` (khi thả đèn) + 1 lần `daily`/ngày, **chỉ khi có đèn approved**. | `server.js:319-323` |
| **Độ cao (height)** | Cột `lanterns.height` (INTEGER, m). Tăng khi `POST /api/height/finish`. | schema `server.js:126`, cộng `server.js:846` |
| **kind** | Loại lượt quạt: `release` / `daily` (free) hoặc `paid` (trừ lửa). | `height_plays.kind` `server.js:144`, chọn ở `server.js:817` |

### Bảng SQL vestigial cần lưu ý
- Bảng `fires` (`server.js:164-171`) là **currency bỏ phiếu cũ**, bị `DROP` mỗi lần khởi động và **không còn route nào INSERT**. `emitOwnerFire()` là **no-op** (`server.js:649`). "Lửa" của người dùng KHÔNG nằm ở đây — đừng nhầm khi seed/verify.
- Bảng `votes` / `checkins` (`server.js:207-219`): `checkins` chỉ dùng cho "vote balance" (không liên quan 3 con số); `ensureCheckin` chạy trong `/api/wallet` (`server.js:863`).

### Hằng số cấu hình (env-overridable)
```
FIRE_PER_FAN        = 3      (server.js:252)  # 3 lửa = 1 lượt quạt
HEIGHT_PLAYS        = 3      (server.js:242)  # ⚠ DEAD: không còn enforce (xem R-11)
HEIGHT_DURATION_MS  = 10000  (server.js:243)
HEIGHT_METERS       = 10     (server.js:244)  # mỗi hit = 10m
HEIGHT_MAX_HPS      = 3      (server.js:245)  # trần 3 hit/giây
=> maxHits   = ceil(10000/1000)*3 = 30        (server.js:247)
=> maxMeters = 30*10 = 300 m mỗi lượt         (server.js:248)
WHEEL = [1,4,2,1,4,3]                         (server.js:280)
QUIZ_REWARD=2 ; PUZZLE/SHAKE/BAKE/CATCH_MAX=4 (server.js:285-294)
STREAK_BONUS = {3:+3, 5:+5}                   (server.js:299)
```

---

## 1. Trace end-to-end

### 1.1 Kiếm lửa (earn)
```
POST /api/spin      → +WHEEL[seg] (1..4), +STREAK_BONUS nếu chạm mốc ngày 3/5   server.js:653-673
POST /api/puzzle/win→ ceil(goals/3) cap 4                                        server.js:687-700
POST /api/shake/win → score≥80→4, 50-79→3, <50→2                                 server.js:704-716
POST /api/quiz/win  → flat 2                                                     server.js:720-731
POST /api/fortune/win→ như shake                                                 server.js:735-747
POST /api/catch/win → như shake                                                  server.js:751-763
```
Tất cả ghi vào `spins` / `puzzles` / `games`. `wallet.earned` cộng dồn toàn bộ
sự kiện (không reset theo ngày) — `server.js:310-314`.

**Cổng once-per-day:**
- Spin: `spins(voter,day)` check thủ công trong route (`server.js:656`); không có UNIQUE ở schema (cho `SPIN_UNLIMITED`).
- 5 mini-game: **1 lượt/ngày TỔNG** (`playedAnyGameToday` `server.js:677-682`) + UNIQUE `(voter,day,game)` / `(voter,day)`. Chơi 1 trò khoá cả 5.
- `GAMES_UNLIMITED` (`server.js:228`) làm `gameDay()` gắn timestamp → UNIQUE không bao giờ đụng → chơi vô hạn; đồng thời mở khoá mọi ngày (`gameUnlocked` `server.js:273`) và bỏ cổng once-per-day.

### 1.2 Quy đổi lửa → lượt quạt
Không có "convert" tách riêng. Quy đổi là **hàm thuần** trong `wallet()`:
```
fanPlays = freePlays + floor(balance / FIRE_PER_FAN)   server.js:341
```
Lửa CHỈ bị tiêu khi tạo 1 lượt `paid` (trừ tại START, không phải finish).

### 1.3 Chơi tạo gió → tăng độ cao
```
GET  /api/height/state   → {height, playsLeft, freePlays, balance, active}      server.js:781-794
POST /api/height/start   → tạo height_plays (kind release|daily|paid), trả endsAt server.js:797-826
POST /api/height/finish  → capped hits→meters, UPDATE lanterns.height (tx)       server.js:829-852
```
- START chọn kind: `release` (nếu chưa dùng) → `daily` (nếu ngày nay chưa dùng) → `paid` (`server.js:815-817`).
- FINISH: `added = min(hits,30)*10`, cap 300; transaction cập nhật `height_plays.meters` + `lanterns.height` (`server.js:844-848`); emit `height-changed` (`server.js:850`).
- Idempotency: START theo `request_id` UNIQUE (`server.js:805`) + khôi phục `activePlay` (`server.js:808`); FINISH theo cờ `finalized` (`server.js:837`).

### 1.4 Socket / vòng đời đèn
```
/screen nghe 'new-lantern'{id} → emit 'lantern-shown'{id} → server set appeared=1 (1 lần) → emit 'lantern-appeared'  server.js:1357 / screen.html:531
index.html nghe 'lantern-appeared' → mở nút "Xem lồng đèn" → cho phép START (start yêu cầu appeared) index.html:1483 ; server.js:803
/api/height/finish emit 'height-changed'{id,height}                              server.js:850
```

### 1.5 Frontend tiêu thụ
- `index.html` màn `mine`: `loadHeightState()` (`index.html:715`), START (`index.html:773-798`), đếm hit client-side lọc 200ms/hit (`index.html:800-806`), FINISH gửi `hits` (`index.html:839`).
- Mini-game (vd `shake.html:205`) POST win, `paint(r.wallet)` cập nhật số lửa.
- `rank-height.html` gọi `/api/leaderboard/height` **1 lần** khi load — **không** nghe `height-changed`.

---

## 2. Bản đồ INVARIANTS

| ID | Invariant kỳ vọng | Vị trí thực thi |
|---|---|---|
| I-1 | `balance = earned - paidPlays*FIRE_PER_FAN` và **luôn ≥ 0** | `server.js:317-339` |
| I-2 | `playsLeft = freePlays + floor(balance/FIRE_PER_FAN)` ; **≥ 0** | `server.js:341` |
| I-3 | 1 lượt `paid` tiêu đúng `FIRE_PER_FAN` lửa (không hơn/kém) | `server.js:817-821` |
| I-4 | `release` dùng tối đa **1 lần đời**, `daily` tối đa **1 lần/ngày** | `server.js:319-323, 815-816` |
| I-5 | Mỗi lượt cộng tối đa **300 m** vào height (`hits`≤30) | `server.js:842-843` |
| I-6 | FINISH cộng height **đúng 1 lần** / play (idempotent) | `server.js:837, 844-848` |
| I-7 | START cùng `request_id` **không** tạo lượt/không trừ lửa lần 2 | `server.js:805-806` |
| I-8 | START khi `playsLeft<1` → 403, **không** tạo play | `server.js:812-813` |
| I-9 | START yêu cầu đèn `approved` **và** `appeared=1` | `server.js:801-803` |
| I-10 | `leaderboard/height` chỉ đèn `approved AND height>0`, sort height desc | `server.js:636-641` |
| I-11 | Height game 1 lượt quạt → tối đa 300m; 3 lửa → 1 lượt → tối đa 300m | phối hợp I-3,I-5 |

---

## 3. RỦI RO / BUG tiềm ẩn (theo file:dòng)

> Xếp theo mức độ. Mỗi mục kèm test tương ứng ở §5.

### 🔴 Cao

**R-1 — START không atomic → double-spend / balance âm (race).**
`server.js:811-821`: đọc `wallet()` → kiểm `fanPlays<1` → chọn kind → INSERT, **không** transaction/lock. Hai request song song (2 tab, bấm nhanh, retry mạng) cùng vượt qua check khi chỉ đủ lửa cho 1 lượt → cả hai INSERT `paid` → `spent` vượt `earned` → **balance âm**, và `floor(balanceÂm/3)` khiến `playsLeft` âm sâu (I-1, I-2 vỡ). → Tests C-1, C-2.

**R-2 — `activePlay` check không atomic → nhiều lượt active song song.**
`server.js:808-809` đọc active rồi `server.js:819` INSERT. 2 request khác `request_id` cùng lúc đều thấy "không active" → tạo 2 play `paid` → double-spend + 2 lần cộng height sau đó. → Test C-1.

**R-3 — Kind race → free play bị cấp dư (under-charge).**
`server.js:815-816` đọc `usedRelease/usedDaily` rồi INSERT. 2 request song song có thể cùng nhận `kind='release'` → 2 lượt free thay vì 1 → I-4 vỡ, người dùng được thêm lượt miễn phí (mất "doanh thu" lửa). → Test C-3.

**R-4 — FINISH không kiểm thời gian → gian lận điểm tối đa tức thì.**
`server.js:829-852`: chỉ dùng `hits` client gửi, **không** so với `started_at`/`ends_at`. Client (hoặc curl) gửi `hits=30` ngay lập tức → +300m dù chưa quạt giây nào. Không validate `now >= started_at`, không kiểm play đã hết hạn. → Tests A-14, A-15.

**R-5 — Lửa tiêu ở START, mất vĩnh viễn nếu bỏ dở.**
`paid` được tính `spent` ngay khi INSERT (`server.js:317-318`), nhưng height chỉ cộng ở FINISH. Nếu user START (`paid`) rồi reload/đóng máy/không FINISH → lửa đã trừ, height **không** tăng → "spend nhưng không tăng height". `activePlay` chỉ khôi phục khi `ends_at>now` (`server.js:777`); quá 10s thì play treo `finalized=0` mãi mãi và lửa đã mất. → Tests A-9, A-16, E-4.

**R-6 — `/api/testing` không auth → bất kỳ ai bật GAMES_UNLIMITED toàn server.**
`server.js:870-873` không `requireAuth`/`requireAdmin`. Kẻ xấu POST `{on:true}` → mở farm lửa vô hạn cho mọi người → lửa→quạt→height vô hạn, phá bảng xếp hạng. → Test A-17.

### 🟠 Trung bình

**R-7 — Lệch timezone giữa các "ngày".**
`today()` dùng giờ **máy chủ** (`server.js:233`) cho spin/games/wallet; `todayVN()` dùng **Asia/Ho_Chi_Minh** (`server.js:255`) cho height plays/daily-free. Nếu server không ở tz VN, biên nửa đêm lệch → `daily` free reset lệch ngày với mini-game reset → user thấy lượt free "sai giờ". → Tests U-6, A-18.

**R-8 — Bảng xếp hạng stale.**
`rank-height.html` không nghe `height-changed` (chỉ load 1 lần, `rank-height.html:44-57`). Sau khi ai đó quạt, thứ hạng không tự cập nhật đến khi reload. → Test E-5 (regression/UX).

**R-9 — Phụ thuộc `appeared` để chơi: đèn bị evict khỏi screen.**
`/screen` phát `lantern-shown` khi nhận `new-lantern` (`screen.html:531`) → server set `appeared` lần đầu (`server.js:1357`). Nếu KHÔNG có `/screen` nào mở (screen tắt) → `lantern-shown` không bao giờ tới → `appeared=0` → START luôn 403 `not_appeared` (`server.js:1020`) → user có lửa nhưng không chơi được. → Test A-8.

**R-10 — `no_fire` reset về 0 khi balance thực âm.**
`server.js:813` trả `playsLeft:0` cứng khi `fanPlays<1`, nhưng nếu R-1 đã đẩy balance âm, state (`server.js:790`) trả `playsLeft` âm cho client → UI hiện số âm. → Test C-2.

### 🟡 Thấp / cần khẳng định

**R-11 — `HEIGHT_CFG.playsPerDay` & `heightPlaysUsed()` là dead code.**
Định nghĩa `server.js:242, 772-774` nhưng **không** route nào enforce cap/ngày (chủ ý theo comment `server.js:251`). Rủi ro: hiểu nhầm còn cap 3 lượt/ngày. → Test A-7 khẳng định KHÔNG có cap ngày.

**R-12 — Integer overflow height.**
`height` là INTEGER SQLite (64-bit) — thực tế không đạt. Ghi nhận, không cần test trọng điểm.

**R-13 — GUEST_MODE tạo sub mới mỗi trình duyệt.**
`server.js:529-540`: mỗi guest = ví riêng. Test bằng guest phải giữ cookie phiên; xoá cookie = mất toàn bộ lửa/đèn. → Ảnh hưởng seed (§4).

**R-14 — START `resumed` trả `endsAt` quá khứ.**
Nếu `request_id` cũ trỏ play đã hết hạn/đã finalized, `server.js:806` trả `resumed:true` với `endsAt` quá khứ → client `startFanRound` tính `left≤0` → FINISH ngay (`index.html:822-828`). Với play đã finalized → FINISH trả `already` (an toàn). Cần khẳng định không cộng lửa/height lần 2. → Test A-13.

---

## 4. Công cụ & seed data

### Công cụ đề xuất (khớp stack)
- **`node:test`** (built-in) + **`node:assert/strict`** — không thêm dep runtime.
- **`supertest`** (devDependency) — gọi Express app. **Cần export `app`/`server`** từ server.js; hiện `server.js` không export gì → *khuyến nghị test qua HTTP thật*: `spawn('node server.js')` với env cô lập, hoặc thêm `module.exports` (thay đổi tối thiểu, ngoài phạm vi task này — ghi chú cho user).
- **better-sqlite3 in-memory** (`new Database(':memory:')`) cho **unit test hàm quy đổi**: tách logic `wallet`/quy đổi ra test bằng cách dựng bảng + seed rồi tự tính (hoặc test qua API với `DB_PATH` trỏ file tạm).
- **Auth trong test:** bật `GUEST_MODE=1`, gọi `POST /api/auth/guest` lấy cookie `ml_session`; tái dùng cookie cho mọi request của "user" đó. Admin: `POST /api/admin/login {key:'trungthu2026'}`.
- **Race/concurrency:** `Promise.all([...])` bắn N request đồng thời với cùng cookie.

### Env cô lập cho mỗi lần chạy
```
DB_PATH=<tmpfile.db>        # DB sạch, tránh đụng lanterns.db thật
AI_RENDER=0                 # bỏ gọi WPP proxy → /submit auto pending (moderation) hoặc approved
GUEST_MODE=1                # mint phiên không cần Google
SPIN_UNLIMITED / GAMES_UNLIMITED  # set theo từng nhóm test
PORT=<random>               # tránh đụng cổng
TZ=Asia/Ho_Chi_Minh         # cho nhóm test timezone (R-7); và TZ=UTC cho test lệch
EVENT_START=<hôm nay>       # để gameUnlocked mở trò cần test
FIRE_PER_FAN, HEIGHT_*      # ép giá trị nhỏ khi cần biên
```

### Seed data cần chuẩn bị (viết trực tiếp qua better-sqlite3 vào `DB_PATH`)
- **S-user**: 1 hàng `users(sub,email,...)` — hoặc dùng guest.
- **S-lantern-approved-appeared**: `lanterns(user_sub, status='approved', appeared=1, appeared_at, height=0)` — điều kiện để START.
- **S-lantern-not-appeared**: như trên nhưng `appeared=0` (test R-9/A-8).
- **S-fires-N**: chèn `spins`/`games` với `reward` tổng = N lửa để đạt `balance` mong muốn (vd 3 lửa = đúng 1 lượt paid; 2 lửa = 0 lượt paid).
- **S-freeplays**: KHÔNG chèn `height_plays` kind `release/daily` → còn 2 free; hoặc chèn sẵn để test đã dùng hết free.
- **S-leaderboard**: nhiều `lanterns` approved với `height` khác nhau + hoà `appeared_at` để test tie-break (`server.js:640`).

---

## 5. TEST CASES

> Ký hiệu: **U**=unit, **A**=API/integration, **E**=e2e, **C**=concurrency, **RG**=regression.
> Mỗi case: *Tiền điều kiện → Bước → Kỳ vọng*.

### 5.1 Unit — logic quy đổi (nhóm U) — 10 cases
Có thể test bằng cách seed DB in-memory và gọi API `/api/height/state` + `/api/wallet`, hoặc tái hiện công thức.

- **U-1** Quy đổi lửa→lượt cơ bản. *TĐK*: balance=9, freePlays=0. *KQ*: `playsLeft = floor(9/3)=3`.
- **U-2** Lửa dư không đủ 1 lượt. *TĐK*: balance=2, free=0. *KQ*: `playsLeft=0`, `no_fire` khi START.
- **U-3** Free + paid cộng dồn. *TĐK*: có đèn approved, chưa dùng free, balance=3. *KQ*: `freePlays=2`, `playsLeft=2+1=3`.
- **U-4** `freePlays=0` khi CHƯA có đèn approved. *TĐK*: không đèn. *KQ*: `freePlays=0` (`server.js:323`).
- **U-5** `release` đã dùng → còn 1 free (daily). *TĐK*: 1 row kind=release. *KQ*: `freePlays=1`.
- **U-6** `daily` reset theo `todayVN`. *TĐK*: 1 row kind=daily day=hôm qua. *KQ*: hôm nay `freePlays` tính lại có daily (khẳng định dùng `todayVN`, `server.js:322`).
- **U-7** `earned` cộng dồn spin+puzzle+game. *TĐK*: spins=4, puzzles=4, games=2. *KQ*: `earned=10`.
- **U-8** `spent` chỉ đếm kind=paid. *TĐK*: 2 paid + 3 free. *KQ*: `spent=2*FIRE_PER_FAN`, free không trừ.
- **U-9** maxHits/maxMeters đúng công thức. *KQ*: với cfg mặc định `maxHits=30`, `maxMeters=300` (`server.js:247-248`); đổi env HEIGHT_DURATION_MS=6000 → maxHits=18.
- **U-10** Reward table mini-game. *KQ*: shake score 80→4, 65→3, 20→2 (`server.js:710`); puzzle goals 5→ceil(5/3)=2, 10→cap 4 (`server.js:694`); quiz→2.

### 5.2 API / Integration (nhóm A) — 18 cases

**Height state/start/finish**
- **A-1** `GET /api/height/state` khi chưa có đèn → `{hasLantern:false}` (`server.js:784`).
- **A-2** state khi có đèn appeared → trả `height, playsLeft, freePlays, balance, firePerFan, durationMs, active:null`.
- **A-3** START thành công lần đầu (free release) → `ok, playId, endsAt, kind='release'`; balance **không** đổi (`server.js:817`). Verify không có row spent.
- **A-4** START lần 2 cùng ngày → `kind='daily'`; lần 3 (hết free) với đủ lửa → `kind='paid'`, balance giảm `FIRE_PER_FAN`.
- **A-5** START thiếu `request_id` → 400 `need_request_id` (`server.js:800`).
- **A-6** START cùng `request_id` lặp → `resumed:true`, cùng `playId`, **không** trừ lửa lần 2 (I-7). Verify count `height_plays` không tăng.
- **A-7** **Không có cap lượt/ngày**: nạp nhiều lửa, START/FINISH lặp >3 lần cùng ngày đều OK khi còn lửa (khẳng định R-11 — playsPerDay không enforce).
- **A-8** START khi `appeared=0` → 403 `not_appeared` (R-9). *TĐK*: S-lantern-not-appeared.
- **A-9** START khi `playsLeft<1` (balance<3, hết free) → 403 `no_fire`, **không** tạo play (I-8). Verify count height_plays = 0.
- **A-10** FINISH cơ bản: hits=10 → `added=100`, `total` tăng 100; emit `height-changed`. Verify `lanterns.height` = 100.
- **A-11** FINISH cap trên: hits=999 → `added=300` (I-5). Verify không quá maxMeters.
- **A-12** FINISH idempotent: gọi FINISH 2 lần cùng `play_id` → lần 2 trả `already:true`, height **không** cộng lần 2 (I-6). Verify height chỉ +1 lần.
- **A-13** FINISH play của người khác → 404 `no_play` (`server.js:834`); START resume finalized play → FINISH trả `already`, không cộng lại (R-14).
- **A-14** **FINISH không kiểm thời gian** (R-4): START rồi FINISH ngay lập tức với hits=30 → `added=300` dù chưa hết 10s. *KQ hiện tại*: chấp nhận (BUG). Test khẳng định hành vi & flag để user cân nhắc chặn `now>=ends_at`.
- **A-15** FINISH `hits` âm/không phải số → `Math.max(0,...)` → added=0 (`server.js:832`). Verify không lỗi, height không đổi.
- **A-16** START `paid` rồi KHÔNG finish → balance đã giảm (R-5). Verify `wallet.balance` giảm ngay sau START, height không đổi. Flag chủ ý/không.

**Mini-game & spin (earn)**
- **A-17** `POST /api/testing {on:true}` **không auth** vẫn 200 và bật GAMES_UNLIMITED (R-6). Test khẳng định lỗ hổng để user thêm auth.
- **A-18** Daily free vs mini-game reset lệch tz (R-7): chạy với `TZ=UTC`, so ranh giới ngày `today()` vs `todayVN()` quanh nửa đêm VN.

### 5.3 E2E — luồng chơi thật (nhóm E) — 6 cases
- **E-1** Vòng đầy đủ: guest login → submit (AI off→pending) → admin approve → screen `lantern-shown` set appeared → `lantern-appeared` → state hasLantern → START(release) → FINISH hits=15 → height=150 → xuất hiện trên `/api/leaderboard/height`.
- **E-2** Farm→quạt: chơi shake (được 4 lửa) khi GAMES_UNLIMITED để đạt ≥3 lửa → sau khi hết 2 free, START `paid` trừ 3 lửa → FINISH tăng height. Verify chuỗi earned→balance→playsLeft→height nhất quán.
- **E-3** Hết lượt: dùng hết free + hết lửa → state `playsLeft=0` → nút UI chuyển "Chơi game để nhận thêm lửa" (`index.html:738-742`).
- **E-4** Reload giữa lượt: START (active, ends_at còn) → gọi lại `/api/height/state` → `active` trả `{id,endsAt}`; START lại (khác rid) → `resumed` khôi phục cùng play (`server.js:808`), không trừ thêm.
- **E-5** Leaderboard cập nhật: sau FINISH, `/api/leaderboard/height` phản ánh height mới; **khẳng định** `rank-height.html` KHÔNG tự cập nhật realtime (R-8) — cần reload.
- **E-6** Tie-break bảng xếp hạng: 2 đèn cùng height → đèn `appeared_at` sớm hơn xếp trên (`server.js:640`).

### 5.4 Concurrency / Race (nhóm C) — 6 cases
- **C-1** **Double-spend START** (R-1/R-2): balance=3 (đủ đúng 1 paid, free đã hết). Bắn 2 START đồng thời (khác rid) qua `Promise.all`. *KQ kỳ vọng đúng*: chỉ 1 thành công trừ 3 lửa, cái kia `no_fire`. *KQ hiện tại (bug)*: cả 2 tạo `paid` → balance=-3. Test phát hiện.
- **C-2** **Balance âm** (R-10): sau C-1, `/api/height/state` trả `playsLeft` âm & `balance` âm. Assert phải ≥0.
- **C-3** **Free play race** (R-3): chưa dùng free, bắn 2 START đồng thời. *KQ đúng*: 1 release + 1 daily (hoặc 1 release + 1 paid). *Bug*: 2 release → I-4 vỡ.
- **C-4** FINISH đồng thời cùng play_id: bắn 2 FINISH `Promise.all`. *KQ*: height cộng đúng 1 lần (kiểm tra transaction `server.js:844` + cờ finalized đủ chống double).
- **C-5** START với cùng `request_id` đồng thời (double-click): 2 request cùng rid → nhờ UNIQUE `request_id` chỉ 1 row; cái kia trả existing. Verify count=1 (I-7 dưới tải).
- **C-6** Multi-tab spin: nếu SPIN_UNLIMITED off, 2 spin đồng thời cùng ngày → chỉ 1 ghi (check `server.js:656` không atomic → có thể lọt 2). Verify earned không nhân đôi ngoài ý muốn.

### 5.5 Regression (nhóm RG) — 5 cases
- **RG-1** `emitOwnerFire` là no-op — spin/win không phát socket đổi rank (`server.js:649`); đảm bảo không có listener cũ kỳ vọng sự kiện fire.
- **RG-2** Bảng `fires` bị DROP mỗi khởi động (`server.js:164`) — không route nào phụ thuộc dữ liệu cũ; "lửa" người dùng vẫn còn (nằm ở spins/games).
- **RG-3** GAMES_UNLIMITED bật→tắt runtime (`/api/testing`) — sau khi tắt, cổng once-per-day khôi phục; các row `day#timestamp` cũ không chặn ngày hôm nay.
- **RG-4** Streak bonus chỉ cấp 1 lần tại mốc ngày 3/5 (`server.js:666-670`) — spin ngày thứ 4 không cấp lại bonus ngày 3.
- **RG-5** `/api/height/finish` emit `height-changed` với đúng `{id,height=total}` — screen/clients nhận đúng tổng mới (`server.js:850`).

---

## 6. Tổng kết

- **Tổng test case đề xuất: 45** (U:10, A:18, E:6, C:6, RG:5).
- **Rủi ro nghiêm trọng nhất:**
  1. **R-1/R-2** START không atomic → double-spend lửa & balance/playsLeft âm (race đa-tab/bấm nhanh).
  2. **R-4** FINISH không kiểm thời gian → gian lận +300m tức thì.
  3. **R-6** `/api/testing` không auth → bật farm lửa vô hạn toàn server.
  4. **R-5** Lửa trừ tại START, mất vĩnh viễn nếu bỏ dở lượt paid.
- **Ưu tiên triển khai:** nhóm **C (concurrency)** + **A-14/A-16/A-17** trước, vì chúng bắt các lỗi tính toàn vẹn của 3 con số; sau đó **A/U** cho quy đổi, rồi **E/RG**.
- **Việc cần user làm để chạy được test API:** export `app`/`server` từ `server.js` (hoặc spawn process với env cô lập + `DB_PATH` tạm). Đây là thay đổi ngoài phạm vi task (không sửa trong tài liệu này).
