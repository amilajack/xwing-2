import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";

/**
 * Runs the real game engine in Node, one display refresh at a time, with a
 * renderer that records where the player's ship sits relative to the camera
 * in each image it would draw. Steady, straight flight must hold the ship
 * still on screen at any refresh rate - physics runs at a fixed rate that
 * most displays don't share, and that mismatch is what made the ship shudder.
 */
const require = createRequire(import.meta.url);
const gameDirectory = resolve(fileURLToPath(import.meta.url), "../../app/game");
const { transformSync } = require("next/dist/build/swc/index.js");

async function loadEngine() {
  const sourcePath = resolve(gameDirectory, "StarfighterGame.tsx");
  const { code } = await transformSync(readFileSync(sourcePath, "utf8"), {
    filename: sourcePath,
    jsc: {
      parser: { syntax: "typescript", tsx: true },
      transform: { react: { runtime: "automatic" } },
      target: "es2022",
    },
    module: { type: "es6" },
  });

  /**
   * Written under node_modules so
   * the engine's own imports resolve.
   */
  const outputDirectory = resolve(
    "node_modules/.cache",
    basename(fileURLToPath(import.meta.url)),
  );

  const outputPath = resolve(outputDirectory, "StarfighterGame.mjs");

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    outputPath,
    code.replaceAll(/from "\.\/([^"]+)"/g, (_, module) =>
      `from ${JSON.stringify(pathToFileURL(resolve(gameDirectory, `${module}.ts`)).href)}`,
    ) + "\nexport { DogfightEngine };\n",
  );

  return (await import(pathToFileURL(outputPath).href)).DogfightEngine;
}

function installBrowserStandIns() {
  const ignore = () => {};
  const context2d = new Proxy(
    {},
    {
      get: (_, key) =>
        key.startsWith?.("create") ? () => ({ addColorStop: ignore }) : ignore,
    },
  );

  const canvas = () => ({
    width: 480,
    height: 300,
    style: {},
    getContext: () => context2d,
    addEventListener: ignore,
    removeEventListener: ignore,
    getBoundingClientRect: () => ({ width: 480, height: 300, left: 0, top: 0 }),
  });

  globalThis.window = Object.assign(new EventTarget(), {
    location: { search: "" },
    innerWidth: 480,
    innerHeight: 300,
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem: ignore },
  });

  globalThis.document = Object.assign(new EventTarget(), {
    createElement: canvas,
    hidden: false,
  });

  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };

  return canvas;
}

const canvas = installBrowserStandIns();
const DogfightEngine = await loadEngine();
function recordingRenderer(images) {
  const methods = {
    domElement: canvas(),
    info: { autoReset: true, render: { calls: 0, triangles: 0 }, memory: {} },
    shadowMap: {},
    getPixelRatio: () => 1,
    getSize: (size) => size.set(480, 300),
    render(scene, camera) {
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      const ship = scene
        .getObjectByName("player-flight-frame")
        .getObjectByProperty("isMesh", true);
      images.push({
        shipFromCamera: ship
          .getWorldPosition(new THREE.Vector3())
          .applyMatrix4(camera.matrixWorldInverse),
        cameraPosition: camera.position.clone(),
      });
    },
  };

  // Every other WebGLRenderer call (settings, disposal) does nothing here.
  return new Proxy(methods, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => ((target[key] = value), true),
  });
}

function shipModels() {
  return Object.fromEntries(
    ["player", "fighter", "interceptor", "bomber"].map((role) => [
      role,
      new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry())),
    ]),
  );
}

const SETTINGS = {
  quality: "ultra",
  renderScale: 1,
  maxDpr: 1,
  targetFps: 120,
  autoResolution: false,
  shadows: false,
  effects: 1,
  asteroidCount: 130,
  starCount: 1400,
  sensitivity: 1,
  muted: true,
};

/**
 * Flies straight with no input and
 * returns the image shown on each refresh.
 */
function flyStraight(refreshHz, seconds) {
  const images = [];
  const engine = new DogfightEngine(
    recordingRenderer(images),
    new THREE.Scene(),
    new THREE.PerspectiveCamera(),
    SETTINGS,
    {
      high: shipModels(),
      low: shipModels(),
      asteroid: new THREE.Mesh(new THREE.BoxGeometry()),
    },
    new Proxy({}, { get: () => () => {} }),
  );
  engine.begin();

  const shown = [];

  for (let refresh = 1; refresh <= refreshHz * seconds; refresh += 1) {
    engine.frame((refresh * 1000) / refreshHz, 1 / refreshHz);
    shown.push(images.at(-1));
  }

  engine.dispose();

  return shown;
}

const refreshRates = [240, 144, 120, 75, 60];
for (const refreshRate of refreshRates) {
  test(`the ship holds still on screen in straight flight at ${
    refreshRate
  } Hz`, () => {
    /**
     * The first second lets the chase camera settle in behind the ship.
     */
    const shown = flyStraight(refreshRate, 2).slice(refreshRate);
    const travelPerRefresh =
      shown.at(-1).cameraPosition.distanceTo(shown[0].cameraPosition) /
      (shown.length - 1);

    const largestShift = Math.max(
      ...shown
        .slice(1)
        .map((image, index) =>
          image.shipFromCamera.distanceTo(shown[index].shipFromCamera),
        ),
    );

    assert.ok(
      largestShift < travelPerRefresh * 0.02,
      `ship shifted ${
        largestShift.toFixed(3)
      } units on screen in one refresh, ` +
        `while flying ${travelPerRefresh.toFixed(3)} per refresh`,
    );
  });
}
