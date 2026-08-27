# Deploy — Docker + Cloudflare Tunnel

Host **this repo** in Docker on your local server; expose it with Cloudflare
Tunnel. The **WPP AI proxy is assumed already running** in its own container —
this app just calls it via `WPP_PROXY_URL`.

```
phones ─┐                         ┌─ WPP proxy (your other container, :3141)
        │  Cloudflare Tunnel      │
  ...───┼────────────────► [ mid-autumn-lanterns :3000 ] ──► gpt-image-2
big screen ┘  (https://lantern.example.com)
```

## 1. Configure

Edit `docker-compose.yml`:

- **`PUBLIC_URL`** → your tunnel hostname, e.g. `https://lantern.example.com`.
  This is what the QR code and every link point to. **Wrong value = QR won't work.**
- **`WPP_PROXY_URL`** → how this container reaches your proxy:
  - proxy on the **same docker network**: `http://<proxy-service-name>:3141`
    (best — put both on one network, see §4)
  - proxy elsewhere on the **host**: `http://host.docker.internal:3141` (default)

## 2. Build & run

```bash
docker compose up -d --build
docker compose logs -f          # watch startup; should print "AI proxy: http://..."
```

Data persists in two named volumes (survive restarts/rebuilds):
- `lantern-data` → the SQLite database (`/data/lanterns.db`)
- `lantern-images` → kids' generated PNGs (`/app/public/lanterns`)

## 3. Cloudflare Tunnel

Point a tunnel at the container's port (`http://localhost:3000`). Two options:

**Quick (one command):**
```bash
cloudflared tunnel --url http://localhost:3000
```
(gives a random `*.trycloudflare.com` URL — put that in `PUBLIC_URL`, redeploy)

**Named tunnel (stable domain):**
```bash
cloudflared tunnel create lanterns
cloudflared tunnel route dns lanterns lantern.example.com
# ~/.cloudflared/config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: /root/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: lantern.example.com
#       service: http://localhost:3000
#     - service: http_404
cloudflared tunnel run lanterns
```
Then set `PUBLIC_URL=https://lantern.example.com` and `docker compose up -d`.

> WebSockets (Socket.IO) work through Cloudflare Tunnel out of the box — no extra config.

## 4. Reaching the WPP proxy on THIS server

Checked on `ssh.vml-team.site` (host `plane`): the WPP proxy is **NOT a
container** — it runs as a host Python process listening on `0.0.0.0:3141`
(pid 1252). So the app reaches it via the host gateway (already configured):
```yaml
    environment:
      WPP_PROXY_URL: "http://host.docker.internal:3141"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```
No shared docker network needed. (If you ever move the proxy into Docker,
switch to a shared network + `http://<proxy-container>:3141`.)

### ⚠️ Two things to fix on the server before it works
1. **Proxy token is EXPIRED** — `/health` returns
   `Token expired … Run: ./update_token.sh <new_token>`. Refresh it (in the
   proxy's directory) or AI generation will fail every time and fall back.
2. **Port 3000 is taken** by `buzz-prod-relay-1`. This app maps to host
   **3005** instead (`3005:3000`). Point the tunnel at `http://localhost:3005`.

## 5. Pages at the event

| URL | Who |
|-----|-----|
| `PUBLIC_URL/`        | phones — colouring |
| `PUBLIC_URL/qr`      | QR page (print / second screen) |
| `PUBLIC_URL/admin`   | operator — approve/reject |
| `PUBLIC_URL/screen`  | big screen — the flying sky |

## Env reference

| Var | Default | Meaning |
|-----|---------|---------|
| `PUBLIC_URL` | LAN IP | Public base URL for QR + links (set this!) |
| `WPP_PROXY_URL` | `http://localhost:3141` | The WPP AI proxy |
| `WPP_PROXY_KEY` | — | Only if the proxy requires `x-api-key` |
| `WPP_IMAGE_QUALITY` | `low` | `low` / `medium` |
| `WPP_IMAGE_BACKGROUND` | `transparent` | gpt-image-2 background |
| `AI_RENDER` | on | set `0` to disable AI (drawings go straight to admin) |
| `DB_PATH` | `./lanterns.db` | SQLite location (point at a volume) |
| `PORT` | `3000` | listen port |

### ponytail: single container + 2 volumes; AI proxy stays external. No k8s, no S3 — a local box behind a tunnel is the right size for one event.
