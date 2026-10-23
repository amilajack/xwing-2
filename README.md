# Rogue Vector

A Three.js/WebGL2 space dogfight with single-player and four-player co-op. Fly
an X-wing against TIE fighters, TIE interceptors, and stealth bombers through
a dense asteroid field with keyboard, mouse, touch, or phone-tilt controls.

## Run locally

Requires Node.js 22.13 or newer and pnpm 12.6.0. Install the pinned pnpm
version with `corepack enable && corepack prepare pnpm@12.6.0 --activate`.

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000). Ultra is the default
graphics preset. Development uses Turbopack. Phone motion controls require
Safari permission and a secure context. iPhone Safari does not show the
motion-permission prompt from a plain
LAN `http://` URL, so serve the game over HTTPS, for example with Tailscale
Serve:

```bash
# Terminal 1
pnpm run build
pnpm start

# Terminal 2
tailscale serve --bg 3000
```

Open the HTTPS address `tailscale serve` prints on the iPhone, tap **Launch fighter**,
allow motion access, and calibrate the neutral phone position. The game asks
for landscape orientation and displays a rotate prompt when the browser cannot
lock orientation itself. For stable phone testing, use `pnpm start`; `pnpm run
dev` enables Next.js HMR and can refresh Safari or Brave while the router is
initializing. The development server also rejects hosts it does not know, so
to use it through the tunnel, put that host in `ALLOWED_DEV_ORIGINS` in
`.env.local`.

Useful checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run verify:browser
```

`pnpm run check` runs whitespace checks, lint, type checking, and the production
build and tests. `pnpm install` installs the version-controlled pre-commit hook,
which runs the same checks and blocks commits on failure.

The game owns its Three.js renderer and animation loop directly. Press P in
flight to inspect frame timing, draw calls, triangles, and render scale.

The browser verification launches headed Chrome through Playwright so Ultra
uses the Mac GPU instead of headless Chromium's software SwiftShader renderer.
It checks changing idle and combat frames, WebGL2, controls, camera switching,
all graphics tiers, HTTP/console errors, and a visual fleet lineup. Evidence is
written under `outputs/playwright/`.

## Controls

- Mouse or arrow keys: continuously pitch and yaw through unrestricted
  360-degree free flight
- Left click or Space: roll the ship profile 90 degrees
- Right click or Control: fire
- C: chase/cockpit camera
- P: performance diagnostics
- Escape: pause
- Gamepad: left stick, A, RT, and Y respectively

Forward speed automatically ramps from the reference project's 4× to 9×
multiplier, but movement follows the X-wing's local forward axis instead of a
fixed world-space corridor. Pitch and yaw use damped angular velocity, the
camera follows the ship's complete orientation, and the arena wraps on all
three axes for continuous dogfighting.

## Graphics and performance

Low (shown as “Lowest / Performance”) is the only preset allowed to use
simplified ship LODs. Medium, High, Ultra, and Custom use high-detail ship
assets. The asteroid field always uses the high-detail glTF and is rendered with
GPU instancing. Projectiles and explosions are pooled, gameplay uses a fixed
60 Hz simulation, and adaptive resolution can scale GPU load without changing
combat or scoring.

Ultra defaults to 120 FPS, 2× DPR, full effects, dynamic shadows, 6,000 stars,
and 560 asteroid instances. Settings apply live and persist locally.

## Sketchfab assets

The reviewed high-quality source models and licenses are listed in
[ASSET_SOURCES.md](./ASSET_SOURCES.md). Sketchfab requires authentication for
free downloads, so keep your API token in the shell and run:

```bash
SKETCHFAB_API_TOKEN=your_token pnpm run assets:sketchfab
```

The importer verifies each model's creator, downloadable status, and CC BY
license before replacing anything. It converts the source to GLB, applies
lossless draw-call and vertex-cache optimizations, validates it, and derives
lowest-preset ship LODs. Full source geometry and 2K quality-92 textures are
preserved for every other preset; Lowest alone uses simplified geometry and 1K
textures.

## Four-pilot co-op

Single-player remains available through **Launch fighter**. Choose a callsign and
use **Quick Join**, **Create private room**, or an invite link to fly co-op.
The server supports one squad of four pilots. Private rooms are excluded from
Quick Join. Disconnected slots remain reserved for 15 seconds; the ship stays
vulnerable. A destroyed pilot respawns after five seconds. Escape opens a local
menu while squad combat continues.

Co-op requires native WebTransport and a network allowing UDP 443. Current
Chrome/Edge are suitable for the browser regression. Unsupported browsers and
blocked connections show an error while keeping single-player accessible.

The shared simulation (`shared/`) contains flight, maneuvers, enemy behavior,
combat rules, projectiles, and arena wrapping. Solo and multiplayer use the same
flight dynamics and combat parameters. The authoritative server advances at
60 Hz, consumes sequenced inputs sent at 30 Hz, and sends snapshots at 20 Hz.
Clients predict local flight, replay unacknowledged controls, and interpolate
remote entities through the arena boundaries. Co-op always uses the same seeded
130 collidable asteroids, regardless of graphics quality.

### Local server

Use Node 24 and `pnpm install`. Generate a local ECDSA certificate for transport:

```sh
mkdir -p work/tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout work/tls/key.pem -out work/tls/cert.pem -days 13 \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
pnpm db:generate
```

Set `DATABASE_URL` to Neon's pooled connection and `MIGRATION_DATABASE_URL` to
its direct connection. Keep credentials in an ignored environment file or SSM;
do not commit them. `pnpm db:migrate` applies the checked-in Prisma migration.
Combat continues if persistence is unavailable; result writes use a bounded,
coalescing retry queue outside simulation ticks.

Start the frontend with `NEXT_PUBLIC_MULTIPLAYER_URL=http://127.0.0.1:8187` and
port 3217. Start the server with:

```sh
ALLOWED_ORIGINS=http://127.0.0.1:3217 API_HOST=127.0.0.1 API_PORT=8187 \
QUIC_HOST=127.0.0.1 QUIC_PORT=4447 TRANSPORT_URL=https://127.0.0.1:4447/game \
TEST_MODE=1 TEST_SECRET=local-coop-regression pnpm server:dev
```

The loopback-only test endpoint requires all three of `TEST_MODE=1`, loopback
listener addresses, and the test secret. It cannot operate on the deployed
public listener. The browser regression pins the local certificate in its test
contexts; production uses ordinary trusted TLS without certificate overrides.

```sh
pnpm test:coop
GAME_URL=http://127.0.0.1:3217 COOP_API=http://127.0.0.1:8187 \
  PLAYWRIGHT_HEADED=1 pnpm verify:coop
```

Screenshots and structured reports are written to `outputs/coop-playwright`.
The existing `pnpm verify:browser` covers solo flight, maneuvers, combat and
rendering. `window.__gameTest.ready` and `getState()` are available alongside the
existing QA hooks. Network-disconnect injection is enabled only with `?qa=1`.

### ARM64 deployment

The production backend is designed for an ARM64 `t4g` Spot instance in
`us-west-1`, with no on-demand fallback. The client stays on its existing host.
`infra/multiplayer` provisions the one-instance ASG, encrypted 8 GiB gp3 disk,
stable Elastic IP, TCP/UDP 443, Route 53 record, SSM access, and GitHub OIDC role.
`ops/` supplies systemd services, Caddy HTTPS proxying, ACME DNS certificates,
encrypted S3 certificate backup, renewal, and draining on Spot notices.

1. Run `node scripts/bootstrap-coop-storage.mjs BUCKET` to create private,
   encrypted, versioned storage. Initialize Terraform with that S3 backend.
2. Put the pooled and direct URLs into `/xwing-coop/database-url` and
   `/xwing-coop/migration-database-url` as SSM SecureString values.
3. Supply the bucket, browser origin allowlist, Route 53 zone, ACME email and
   GitHub OIDC provider ARN through Terraform variables. Enable capacity only
   after uploading the release. Recheck Spot prices and availability.
4. Build with `scripts/build-server-artifact.sh`. It uses a Linux ARM64 Docker
   build, including ARM64 Node, native QUIC, and Prisma engines; no compilation
   occurs on the instance. Upload an immutable release key to S3.
5. Apply Terraform. Launch templates select the latest configured release;
   existing instances are updated through the deployment workflow or an explicit
   ASG instance refresh. Downloads pin an S3 object version so replacements
   cannot mix two concurrently published releases.
6. The GitHub workflow is restricted to the configured repository's main branch.
   It uploads the artifact and invokes SSM to drain the previous process, run
   Prisma migrations, and start the new version. It does not publish the frontend.

The default backend URL is `https://xwing-mp.amilajack.com`; another deployment
can set `NEXT_PUBLIC_MULTIPLAYER_URL`. Include every actual frontend origin in
`allowed_origins`; credentials, cookies, accounts and authentication providers
are not used.

A release drains active matches before restart. Spot interruption notices stop
admission, notify clients, and persist interrupted results. Replacement
instances start fresh. Abrupt instance loss can leave the unfinished match's
last checkpoint marked active. Certificates are restored from private encrypted
S3 and renewed through DNS validation. Daily checks do not restart active games
when the certificate is unchanged.

### Capacity and operations

Use `scripts/ssm-coop.mjs COMMAND_FILE` to operate the running tagged instance
without SSH. `ops/capacity.sh` records 30 minutes of process CPU, host memory and
restart samples. Run `scripts/load-coop.mjs` concurrently to maintain four real
browser WebTransport sessions for 30 minutes. Use
`scripts/verify-coop-live.mjs` for trusted TLS and actual two-player combat on
the deployed endpoint. It steers and fires using mouse/keyboard events.

Acceptance: no restarts/OOM, p95 simulation work below 16.7 ms, host memory below
80%, and mean game CPU within the instance's credit baseline (0.1 CPU cores for
a nano, 0.2 for a micro). Metrics are emitted every ten seconds for tick p95,
RSS, connections, input loss, snapshot drops, persistence failures and
interruptions. Journald is bounded to 32 MiB on disk and 16 MiB in memory.

Expected fixed costs include Spot compute, public IPv4, gp3 storage and small S3
usage. Existing Route 53 hosting and frontend costs remain separate. Neon Free
is in Oregon (`aws-us-west-2`). Spot capacity and rates are variable; the
verification report records the selected instance and observed quote.

Multiplayer waves retain their existing fighters, interceptors, and bombers, and
add one squadron of four TIE fighters per human pilot. Joining mid-wave adds that
pilot's squadron immediately. Disconnect reservations retain the squadron;
reconnecting or respawning does not add another. Leaving removes that pilot's
surviving reinforcements. Four pilots can face up to 34 enemies in later waves.
Single-player wave composition remains unchanged.

The initial ARM capacity run was stopped early at the user's request after
871 seconds (88 samples): one process throughout, mean game CPU 0.169 cores,
mean host CPU 0.173 cores, maximum host memory usage 62.3%. This is partial
capacity evidence, not a completed 30-minute acceptance run, and predates the
additional squadrons.

### Versus mode

Choose **Versus** in the multiplayer lobby for a public free-for-all, or create
and share a private versus room. Up to four pilots fight alongside the existing
AI waves and four extra TIE fighters per pilot. Only human kills count toward
the first-to-ten victory; the scoreboard lists AI kills and points separately.

A round waits for two connected pilots. Pilots can join in progress, respawn in
five seconds, and receive two seconds of spawn protection that ends on firing.
Disconnected ships stay vulnerable during the existing 15-second reservation.
After a victory, combat freezes for a ten-second results screen, followed by a
fresh round over the same connections. A rematch waits if fewer than two pilots
are connected. Departed standings are retained for the current round. Admission
is bounded to 64 distinct pilots per versus round, including reservations;
reconnects remain available at this limit.

The single-room server matches Quick Join to the selected mode and returns a
clear occupancy error when another mode is flying. Invites and reconnects use
the room's authoritative mode. Single-player and co-op damage rules are unchanged.

This change uses protocol **2** and adds a Prisma migration for round mode,
winner, human kills, deaths, and AI points. Participant identity is now scoped
to a match, allowing the same pilot in successive rounds. Apply migrations
before starting the new backend and publish the matching frontend in the same
release window; old clients must refresh. This stacked PR does not deploy either
production application.

For local verification, use an isolated PostgreSQL database with both migrations
applied. Never point the test scripts at the production database:

```bash
VERSUS_TEST_DATABASE_URL='postgresql://…' pnpm verify:versus:persistence
GAME_URL=http://127.0.0.1:3217 COOP_API=http://127.0.0.1:8187 \
  PLAYWRIGHT_HEADED=1 VERSUS_TEST_DATABASE_URL='postgresql://…' pnpm verify:versus
```

The browser test uses the existing loopback-only QA endpoint and local certificate
pinning. It verifies actual WebTransport combat, respawn, reconnect, victory,
persisted results, automatic rematches, and private invites at 1440×900, with
screenshots and structured state saved under `outputs/versus-playwright/`.
