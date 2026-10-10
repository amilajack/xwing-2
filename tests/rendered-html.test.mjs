import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import next from "next";

const projectRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const app = next({ dev: false, dir: projectRoot.pathname });
  await app.prepare();
  const handle = app.getRequestHandler();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handle(req, res));
    server.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch(`http://localhost:${port}${path}`, {
          headers: { accept: "text/html" },
        });
        server.close();
        resolve(res);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test("server-renders the Rogue Vector loading shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Rogue Vector/);
  assert.match(html, /Loading glTF flight assets/);
  assert.match(html, /Preparing hangar/);
  assert.match(html, /<canvas/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("can be added to the iPhone Home Screen and launched without Safari's bars", async () => {
  const html = await (await render()).text();
  const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
  const iconHref = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
  assert.ok(manifestHref, "the page must link a web app manifest");
  assert.ok(iconHref, "iOS uses apple-touch-icon for the Home Screen icon");
  // black-translucent lets the game draw under the status bar once installed.
  assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);

  const manifest = await (await render(manifestHref)).json();
  // iOS Safari honours "standalone" and ignores "fullscreen".
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name, "the Home Screen needs a name to show");

  const icon = await render(iconHref);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /^image\/png\b/);
});

test("keeps performance-critical systems explicit and bounded", async () => {
  const [source, importer, page, site, globalCss, packageJson] =
    await Promise.all([
      readFile(
        new URL("../app/game/StarfighterGame.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../scripts/fetch-sketchfab-assets.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/site.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);

  assert.match(source, /from "three\/webgpu"/);
  assert.match(source, /new THREE\.WebGPURenderer/);
  assert.match(source, /forceWebGL/);
  assert.match(source, /new GLTFLoader\(\)/);
  assert.match(source, /\/models\/xwing-high\.glb/);
  assert.match(source, /\/models\/tie-fighter-high\.glb/);
  assert.match(source, /\/models\/tie-interceptor-high\.glb/);
  assert.match(source, /\/models\/stealth-bomber-high\.glb/);
  assert.match(source, /\/models\/asteroid-high\.glb/);
  assert.match(source, /const DEFAULT_SETTINGS = QUALITY_PRESETS\.ultra/);
  assert.match(source, /process\.env\.NODE_ENV === "development"/);
  assert.match(source, /three\/examples\/jsm\/inspector\/Inspector\.js/);
  assert.match(source, /<Canvas/);
  assert.match(source, /settings\.quality === "low" \? "low" : "high"/);
  assert.match(source, /const MAX_ENEMIES = 20/);
  assert.match(source, /const MAX_PROJECTILES = 320/);
  assert.match(source, /const MAX_EXPLOSIONS = 32/);
  assert.match(source, /new THREE\.InstancedMesh/);
  assert.match(source, /THREE\.DynamicDrawUsage/);
  assert.match(source, /FIXED_STEP/);
  assert.match(source, /0\.003 \* deltaMilliseconds/);
  assert.match(source, /0\.0025 \* deltaMilliseconds/);
  assert.match(source, /MAX_PITCH_RATE/);
  assert.match(source, /MAX_YAW_RATE/);
  assert.match(source, /this\.player\.quaternion\.multiply/);
  assert.match(source, /this\.player\.position\.addScaledVector/);
  assert.match(source, /wrapFlightArena/);
  assert.match(source, /window\.addEventListener\("resize", this\.resize/);
  assert.match(source, /window\.visualViewport\?\.addEventListener/);
  assert.match(source, /delta \/ 0\.8/);
  assert.match(source, /this\.speedMultiplier = Math\.min\(9/);
  assert.match(source, /updateAdaptiveResolution/);
  assert.match(source, /rebuildAsteroidGrid/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /dispose\(\)/);
  assert.match(page, /StarfighterGame/);
  assert.match(site, /Rogue Vector/);
  // The shell follows the visual viewport, so browser chrome cannot cover it.
  assert.match(globalCss, /top: var\(--viewport-offset-top/);
  assert.match(globalCss, /height: var\(--viewport-height/);
  assert.match(packageJson, /"three":/);
  assert.match(packageJson, /"@react-three\/fiber":/);
  assert.doesNotMatch(packageJson, /"r3f-perf":/);
  assert.match(packageJson, /"assets:sketchfab":/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|drizzle/);
  for (const uid of [
    "a185c8bb6e9d43e4b597b856b176d768",
    "722a39247ee84ed892bdc01e22bfbc36",
    "47222ad5bcff43fe868b65a06009e870",
    "9f7e360e2c074db1b9ccabd5dc4b8302",
    "adde1ecf129e4509be8af61b84bafa85",
  ]) {
    assert.match(importer, new RegExp(uid));
  }
  assert.match(importer, /metadata\.license\?\.slug !== "by"/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../db", import.meta.url)));
  await assert.rejects(access(new URL("../examples/d1", import.meta.url)));
  await assert.rejects(access(new URL("public/_sites-preview", projectRoot)));
});

test("ships and asteroids are valid bounded glTF 2.0 binary assets", async () => {
  const modelNames = [
    "xwing-high",
    "xwing-low",
    "tie-fighter-high",
    "tie-fighter-low",
    "tie-interceptor-high",
    "tie-interceptor-low",
    "stealth-bomber-high",
    "stealth-bomber-low",
    "asteroid-high",
  ];
  const sizes = new Map();
  let totalSize = 0;

  for (const name of modelNames) {
    const url = new URL(`../public/models/${name}.glb`, import.meta.url);
    const [header, details] = await Promise.all([
      readFile(url).then((buffer) => buffer.subarray(0, 12)),
      stat(url),
    ]);
    assert.equal(header.subarray(0, 4).toString("ascii"), "glTF");
    assert.equal(header.readUInt32LE(4), 2);
    assert.ok(details.size > 8_000, `${name} should contain real geometry`);
    assert.ok(
      details.size < 120_000_000,
      `${name} should remain bounded for local loading`,
    );
    sizes.set(name, details.size);
    totalSize += details.size;
  }

  for (const role of [
    "xwing",
    "tie-fighter",
    "tie-interceptor",
    "stealth-bomber",
  ]) {
    assert.ok(
      sizes.get(`${role}-high`) > sizes.get(`${role}-low`),
      `${role} high-detail asset should exceed its Lowest-preset variant`,
    );
  }
  assert.ok(totalSize < 300_000_000, "the complete local model set is bounded");

  const attribution = JSON.parse(
    await readFile(
      new URL("../public/models/sketchfab-attribution.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(attribution.length, 5);
  assert.deepEqual(
    attribution.map(({ uid }) => uid).sort(),
    [
      "a185c8bb6e9d43e4b597b856b176d768",
      "722a39247ee84ed892bdc01e22bfbc36",
      "47222ad5bcff43fe868b65a06009e870",
      "9f7e360e2c074db1b9ccabd5dc4b8302",
      "adde1ecf129e4509be8af61b84bafa85",
    ].sort(),
  );
  assert.ok(
    attribution.every(({ license }) => license === "CC Attribution"),
    "every installed Sketchfab asset must retain its reviewed CC BY license",
  );
});
