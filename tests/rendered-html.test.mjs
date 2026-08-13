import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
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

test("keeps performance-critical systems explicit and bounded", async () => {
  const [source, importer, page, layout, globalCss, packageJson] =
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
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);

  assert.match(source, /getContext\("webgl2"/);
  assert.match(source, /new GLTFLoader\(\)/);
  assert.match(source, /\/models\/xwing-high\.glb/);
  assert.match(source, /\/models\/tie-fighter-high\.glb/);
  assert.match(source, /\/models\/tie-interceptor-high\.glb/);
  assert.match(source, /\/models\/stealth-bomber-high\.glb/);
  assert.match(source, /\/models\/asteroid-high\.glb/);
  assert.match(source, /const DEFAULT_SETTINGS = QUALITY_PRESETS\.ultra/);
  assert.match(source, /process\.env\.NODE_ENV === "development"/);
  assert.match(source, /import\("r3f-perf"\)/);
  assert.match(source, /development-r3f-perf/);
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
  assert.match(layout, /Rogue Vector/);
  assert.match(globalCss, /width: 100dvw/);
  assert.match(globalCss, /height: 100dvh/);
  assert.match(packageJson, /"three":/);
  assert.match(packageJson, /"@react-three\/fiber":/);
  assert.match(packageJson, /"r3f-perf":/);
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
