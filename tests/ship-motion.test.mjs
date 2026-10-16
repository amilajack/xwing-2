import assert from "node:assert/strict";
import test from "node:test";
import {
  createEngine,
  installBrowserStandIns,
  loadEngine,
  recordingRenderer,
} from "./support/engine-harness.mjs";

/**
 * Runs the real game engine in Node, one display refresh at a time, with a
 * renderer that records where the player's ship sits relative to the camera
 * in each image it would draw. Steady, straight flight must hold the ship
 * still on screen at any refresh rate - physics runs at a fixed rate that
 * most displays don't share, and that mismatch is what made the ship shudder.
 */
const canvas = installBrowserStandIns();
const DogfightEngine = await loadEngine("ship-motion.test.mjs");

/**
 * Flies straight with no input and
 * returns the image shown on each refresh.
 */
function flyStraight(refreshHz, seconds) {
  const images = [];
  const engine = createEngine(
    DogfightEngine,
    recordingRenderer(canvas, images),
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
