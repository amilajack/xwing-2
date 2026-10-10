# Rogue Vector

A single-player Three.js/WebGPU space dogfight. Fly an X-wing against TIE
fighters, TIE interceptors, and stealth bombers through a dense asteroid field
with keyboard, mouse, touch, or phone-tilt controls. Browsers without WebGPU
fall back to WebGL2 automatically.

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

Development builds mount three's renderer inspector, which reports frame, CPU,
and GPU timings on either backend. Append `?qa=1&forceWebGL=1` to the URL to
run the WebGL2 fallback on a machine that supports WebGPU.

The browser verification launches headed Chrome through Playwright so Ultra
uses the Mac GPU instead of headless Chromium's software SwiftShader renderer.
It checks changing idle and combat frames, the WebGPU backend, controls, camera
switching, all graphics tiers, HTTP/console errors, a visual fleet lineup, and
the WebGL2 fallback. Evidence is written under `outputs/playwright/`.

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
