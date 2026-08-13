# Rogue Vector

A desktop-only single-player Three.js/WebGL2 space dogfight. Fly an X-wing
against TIE fighters, TIE interceptors, and stealth bombers through a dense
asteroid field.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Ultra is the default
graphics preset. The game intentionally requires a modern desktop browser with
WebGL2 and does not support mobile input.

Useful checks:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run verify:browser
```

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
SKETCHFAB_API_TOKEN=your_token npm run assets:sketchfab
```

The importer verifies each model's creator, downloadable status, and CC BY
license before replacing anything. It converts the source to GLB, applies
lossless draw-call and vertex-cache optimizations, validates it, and derives
lowest-preset ship LODs. Full source geometry and 2K quality-92 textures are
preserved for every other preset; Lowest alone uses simplified geometry and 1K
textures.
