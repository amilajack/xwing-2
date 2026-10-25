import assert from "node:assert/strict";
import test from "node:test";
import {
  createEngine,
  installBrowserStandIns,
  loadEngine,
  recordingRenderer,
} from "./support/engine-harness.mjs";

/**
 * The model banks and barrel-rolls
 * inside the flight frame, so a bolt
 * and its muzzle flash must start
 * from the cannon tip as drawn,
 * roll included.
 */
const canvas = installBrowserStandIns();

window.location.search = "?qa=1";

const DogfightEngine = await loadEngine("cannon-muzzles.test.mjs");
const WITHIN_UNITS = 0.01;

/**
 * Fires every cannon once after
 * `pose` and returns each shot's report.
 */
function fireAllCannons(pose) {
  const engine = createEngine(DogfightEngine, recordingRenderer(canvas, []));
  engine.begin();
  pose(window.__rogueVectorQa);
  const shots = Array.from({ length: 4 }, () =>
    window.__rogueVectorQa.fireCannon(),
  );
  engine.dispose();
  return shots;
}

function assertShotsLeaveTheCannons(shots, expectRoll) {
  for (const shot of shots) {
    if (expectRoll) assert.notEqual(shot.modelRoll, 0, "the model never rolled");
    for (const part of ["bolt", "flash"]) {
      const distance = Math.hypot(
        ...shot[part].map((value, axis) => value - shot.cannonTip[axis]),
      );

      assert.ok(
        distance < WITHIN_UNITS,
        `the ${part} starts ${distance.toFixed(2)} units from its cannon tip ` +
          `at roll ${shot.modelRoll.toFixed(2)} rad`,
      );
    }
  }
}

test("level flight fires from the cannon tips", () => {
  assertShotsLeaveTheCannons(
    fireAllCannons(() => {}),
    false,
  );
});

test("a banked ship fires from its cannon tips", () => {
  assertShotsLeaveTheCannons(
    fireAllCannons((qa) => qa.steerForSteps(1, 0, 90)),
    true,
  );
});

test("a barrel-rolling ship fires from its cannon tips", () => {
  assertShotsLeaveTheCannons(
    fireAllCannons((qa) => {
      assert.ok(qa.maneuver("barrelRoll", 1), "the barrel roll did not start");
      qa.flyForSteps(15);
    }),
    true,
  );
});
