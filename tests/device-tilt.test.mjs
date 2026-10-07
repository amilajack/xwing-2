import assert from "node:assert/strict";
import test from "node:test";

import { deviceTiltFromOrientation } from "../app/game/deviceTilt.ts";

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Reference model of a phone in the player's hands, built independently of the
 * code under test so the test can fail when that code is wrong.
 *
 * A hold is two physically independent gestures:
 *   lean - how far the screen is tipped back from upright toward horizontal,
 *   bank - how far the phone is rotated within its own plane.
 * Each is a control axis. The test's whole job is to assert that they stay
 * independent after the round trip through the `deviceorientation` angles the
 * browser actually reports.
 */
function orientationEventFor({ screenAngle, lean, bank }) {
  const leanRadians = lean * DEGREES_TO_RADIANS;
  const bankRadians = bank * DEGREES_TO_RADIANS;
  const screenRadians = screenAngle * DEGREES_TO_RADIANS;

  // Screen axes in world coordinates (x east, y north, z up); the viewer is at -y.
  const upright = [0, Math.sin(leanRadians), Math.cos(leanRadians)];
  const outOfScreen = cross([1, 0, 0], upright);
  const screenRight = normalize(
    [1, 0, 0].map(
      (value, axis) =>
        value * Math.cos(bankRadians) + upright[axis] * Math.sin(bankRadians),
    ),
  );
  const screenUp = normalize(cross(outOfScreen, screenRight));

  // Device axes are the screen axes rotated by the screen's own rotation.
  const deviceRight = screenRight.map(
    (value, axis) =>
      Math.cos(screenRadians) * value + Math.sin(screenRadians) * screenUp[axis],
  );
  const deviceUp = screenRight.map(
    (value, axis) =>
      -Math.sin(screenRadians) * value + Math.cos(screenRadians) * screenUp[axis],
  );

  // Recover the ZXY Euler angles the browser reports for that pose.
  const beta = Math.asin(clamp(deviceUp[2], -1, 1));
  const gamma =
    Math.abs(Math.cos(beta)) > 1e-9
      ? Math.atan2(-deviceRight[2], outOfScreen[2])
      : Math.atan2(deviceRight[1], deviceRight[0]);

  return { beta: beta / DEGREES_TO_RADIANS, gamma: gamma / DEGREES_TO_RADIANS };
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function tiltFor(hold) {
  const { beta, gamma } = orientationEventFor(hold);
  return deviceTiltFromOrientation(beta, gamma, hold.screenAngle);
}

/** Every hold a player can plausibly adopt, in every screen orientation. */
function* holds() {
  for (const screenAngle of [0, 90, 180, 270]) {
    for (let lean = 5; lean <= 80; lean += 5) {
      for (let bank = -40; bank <= 40; bank += 5) {
        yield { screenAngle, lean, bank };
      }
    }
  }
}

// The tolerance is a hair above float noise, not a slack budget: the mapping is
// exact, so any real coupling blows through this by whole degrees.
const TOLERANCE_DEGREES = 1e-6;

test("leaning the phone commands pitch and nothing else", () => {
  for (const hold of holds()) {
    const before = tiltFor(hold);
    const after = tiltFor({ ...hold, lean: hold.lean + 10 });
    const where = JSON.stringify(hold);

    assert.ok(
      before.pitch - after.pitch > 9.9,
      `leaning back 10 degrees produced ${(before.pitch - after.pitch).toFixed(3)} degrees of pitch at ${where}`,
    );
    assert.ok(
      Math.abs(after.roll - before.roll) < TOLERANCE_DEGREES,
      `leaning leaked ${(after.roll - before.roll).toFixed(3)} degrees into roll at ${where}`,
    );
  }
});

test("banking the phone commands roll and nothing else", () => {
  for (const hold of holds()) {
    const before = tiltFor(hold);
    const after = tiltFor({ ...hold, bank: hold.bank + 10 });
    const where = JSON.stringify(hold);

    assert.ok(
      before.roll - after.roll > 9.9,
      `banking 10 degrees produced ${(before.roll - after.roll).toFixed(3)} degrees of roll at ${where}`,
    );
    assert.ok(
      Math.abs(after.pitch - before.pitch) < TOLERANCE_DEGREES,
      `banking leaked ${(after.pitch - before.pitch).toFixed(3)} degrees into pitch at ${where}`,
    );
  }
});

test("a hold reads the same whichever way the screen is rotated", () => {
  // Rotating the phone must not change what the same gesture commands; a
  // per-orientation sign table is exactly where that guarantee gets lost.
  for (let lean = 5; lean <= 80; lean += 5) {
    for (let bank = -40; bank <= 40; bank += 5) {
      const portrait = tiltFor({ screenAngle: 0, lean, bank });
      for (const screenAngle of [90, 180, 270]) {
        const rotated = tiltFor({ screenAngle, lean, bank });
        assert.ok(
          Math.abs(rotated.pitch - portrait.pitch) < TOLERANCE_DEGREES &&
            Math.abs(rotated.roll - portrait.roll) < TOLERANCE_DEGREES,
          `screen angle ${screenAngle} reads ${JSON.stringify(rotated)} where portrait reads ${JSON.stringify(portrait)} at lean ${lean} bank ${bank}`,
        );
      }
    }
  }
});

test("pulling the screen upright is nose up, dropping the right edge turns right", () => {
  // Pins the sign of both axes so a refactor cannot silently invert a control.
  const level = tiltFor({ screenAngle: 90, lean: 40, bank: 0 });
  const pulledUpright = tiltFor({ screenAngle: 90, lean: 25, bank: 0 });
  const rightEdgeDropped = tiltFor({ screenAngle: 90, lean: 40, bank: -15 });

  assert.ok(pulledUpright.pitch > level.pitch, "pulling upright must pitch up");
  assert.ok(rightEdgeDropped.roll > level.roll, "dropping the right edge must turn right");
});
