import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  SETTINGS,
  createEngine,
  installBrowserStandIns,
  loadEngine,
} from "./support/engine-harness.mjs";

const canvas = installBrowserStandIns();
const DogfightEngine = await loadEngine("asteroid-wrap.test.mjs");

/**
 * The arena wraps: flying past one face teleports the ship to the opposite
 * one. The asteroid field has to repeat with the same period, or every wrap
 * swaps the scenery and asteroids pop into the middle of the screen.
 */
const PERIOD = 1400;
const FADE_START = 900;

const wrap = (value) => value - PERIOD * Math.round(value / PERIOD);
// Every copy of one asteroid shares a key, even copies either side of an edge.
const fieldKey = (position) =>
  [position.x, position.y, position.z]
    .map((v) => ((Math.round(v) % PERIOD) + PERIOD) % PERIOD)
    .join(",");

/** Whether `keys` holds `position`, allowing for float32 instance rounding. */
function hasCopy(keys, position) {
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        if (keys.has(fieldKey({ x: position.x + x, y: position.y + y, z: position.z + z }))) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Records the asteroid copies each drawn image actually contains. */
function asteroidRenderer(images) {
  const matrix = new THREE.Matrix4();
  const methods = {
    domElement: canvas(),
    info: { autoReset: true, render: { calls: 0, triangles: 0 }, memory: {} },
    shadowMap: {},
    getPixelRatio: () => 1,
    getSize: (size) => size.set(1440, 900),
    render(scene, camera) {
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      const mesh = scene.children.find(
        (child) => child.isInstancedMesh && child.geometry === methods.asteroidGeometry,
      );
      const drawn = [];
      for (let index = 0; index < (mesh?.count ?? 0); index += 1) {
        mesh.getMatrixAt(index, matrix);
        const position = new THREE.Vector3().setFromMatrixPosition(matrix);
        drawn.push({
          position,
          key: fieldKey(position),
          distance: position.distanceTo(camera.position),
          screen: position.clone().project(camera),
          inFront: position.clone().applyMatrix4(camera.matrixWorldInverse).z < 0,
        });
      }
      images.push({ drawn, camera: camera.clone() });
    },
  };
  return new Proxy(methods, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => ((target[key] = value), true),
  });
}

const onScreen = (copy, margin) =>
  copy.inFront && Math.abs(copy.screen.x) < margin && Math.abs(copy.screen.y) < margin;

function flyThroughWraps(seconds) {
  const images = [];
  const renderer = asteroidRenderer(images);
  const engine = createEngine(DogfightEngine, renderer, { ...SETTINGS, targetFps: 60, asteroidCount: 560 });
  renderer.asteroidGeometry = engine.asteroidMesh.geometry;
  engine.begin();

  let wraps = 0;
  let last = engine.player.position.clone();
  for (let refresh = 1; refresh <= seconds * 60; refresh += 1) {
    const time = refresh / 60;
    engine.mouseXPercent = Math.sin(time * 0.5) * 0.9;
    engine.mouseYPercent = Math.sin(time * 0.37) * 0.5;
    engine.frame(refresh * (1000 / 60), 1 / 60);
    if (engine.player.position.distanceTo(last) > 300) wraps += 1;
    last = engine.player.position.clone();
  }
  return { engine, images, wraps };
}

const flight = flyThroughWraps(120);

test("the flight crosses the arena edge", () => {
  assert.ok(flight.wraps >= 5, `only ${flight.wraps} wraps in two minutes`);
});

test("no nearby asteroid ever pops into the middle of the screen", () => {
  const pops = [];
  for (let index = 1; index < flight.images.length; index += 1) {
    const before = new Set(
      flight.images[index - 1].drawn
        .filter((copy) => onScreen(copy, 1.15))
        .map((copy) => copy.key),
    );
    for (const copy of flight.images[index].drawn) {
      if (
        copy.distance < FADE_START &&
        onScreen(copy, 0.8) &&
        !hasCopy(before, copy.position)
      ) {
        pops.push({ image: index, distance: Math.round(copy.distance) });
      }
    }
  }
  assert.equal(
    pops.length,
    0,
    `${pops.length} asteroids appeared mid-screen, e.g. ${JSON.stringify(pops.slice(0, 3))}`,
  );
});

test("every asteroid in view and in range is drawn", () => {
  const { engine, images } = flight;
  const frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  let missing = 0;
  for (const { drawn, camera } of images.filter((_, index) => index % 30 === 0)) {
    const keys = new Set(drawn.map((copy) => copy.key));
    frustum.setFromProjectionMatrix(
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    for (const asteroid of engine.asteroids) {
      sphere.center.set(
        camera.position.x + wrap(asteroid.position.x - camera.position.x),
        camera.position.y + wrap(asteroid.position.y - camera.position.y),
        camera.position.z + wrap(asteroid.position.z - camera.position.z),
      );
      sphere.radius = asteroid.radius;
      if (sphere.center.distanceTo(camera.position) > FADE_START) continue;
      if (!frustum.intersectsSphere(sphere)) continue;
      if (!hasCopy(keys, sphere.center)) missing += 1;
    }
  }
  assert.equal(missing, 0, `${missing} visible asteroids were not drawn`);
});

test("an asteroid just across the arena edge still blocks the ship", () => {
  const engine = createEngine(DogfightEngine, asteroidRenderer([]));
  engine.begin();
  const asteroid = engine.asteroids
    .slice(0, SETTINGS.asteroidCount)
    .reduce((a, b) => (b.position.x < a.position.x ? b : a));
  // The copy of the westmost asteroid that sits past the arena's east face.
  const copy = asteroid.position.clone().add(new THREE.Vector3(PERIOD, 0, 0));
  engine.player.position.copy(copy).add(new THREE.Vector3(0, asteroid.radius * 0.5, 0));
  const hullBefore = engine.shields + engine.hull;

  engine.checkPlayerAsteroidCollision();

  assert.ok(
    engine.player.position.distanceTo(copy) >= asteroid.radius + 2.7,
    "the ship was left inside the asteroid",
  );
  assert.ok(engine.shields + engine.hull < hullBefore, "the collision did no damage");
});
