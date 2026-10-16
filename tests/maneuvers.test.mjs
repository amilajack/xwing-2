import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  BARREL_ROLL_JINK,
  MANEUVER_DURATION,
  maneuverPose,
} from "../app/game/maneuvers.ts";
import {
  createEngine,
  installBrowserStandIns,
  loadEngine,
  recordingRenderer,
} from "./support/engine-harness.mjs";

/**
 * Star Fox style evasive maneuvers: each must land the ship exactly where the
 * move promises, take or keep the stick as it should, and the barrel roll
 * must turn incoming fire away rather than just dodging it.
 */
const canvas = installBrowserStandIns();
window.location.search = "?qa";
const DogfightEngine = await loadEngine("maneuvers.test.mjs");

const STEP = 1 / 60;
const stepsFor = (kind) => Math.ceil(MANEUVER_DURATION[kind] / STEP) + 1;

function startFlying() {
  const engine = createEngine(DogfightEngine, recordingRenderer(canvas, []));
  engine.begin();
  return { engine, qa: window.__rogueVectorQa };
}

const vector = (array) => new THREE.Vector3().fromArray(array);

function pressKey(code) {
  window.dispatchEvent(Object.assign(new Event("keydown"), { code }));
}

function releaseKey(code) {
  window.dispatchEvent(Object.assign(new Event("keyup"), { code }));
}

test("each maneuver's pose finishes exactly on its final angles", () => {
  assert.deepEqual(maneuverPose("barrelRoll", 1), {
    pitch: 0,
    roll: Math.PI * 2,
    lateral: BARREL_ROLL_JINK,
  });
  assert.deepEqual(maneuverPose("somersault", 1), {
    pitch: Math.PI * 2,
    roll: 0,
    lateral: 0,
  });
  assert.deepEqual(maneuverPose("uturn", 1), {
    pitch: Math.PI,
    roll: Math.PI,
    lateral: 0,
  });
  for (const kind of ["barrelRoll", "somersault", "uturn"]) {
    assert.deepEqual(maneuverPose(kind, 0), { pitch: 0, roll: 0, lateral: 0 });
  }
});

test("the U-turn finishes its half loop before it starts its half roll", () => {
  const atSplit = maneuverPose("uturn", 0.55);
  assert.equal(atSplit.pitch, Math.PI);
  assert.equal(atSplit.roll, 0);
});

test("a somersault loops back onto the starting heading, ignoring the stick", () => {
  const { engine, qa } = startFlying();
  const start = qa.snapshot();
  assert.equal(qa.maneuver("somersault"), true);

  qa.steerForSteps(0.8, -0.8, Math.floor(stepsFor("somersault") / 2));
  const halfway = qa.snapshot();
  assert.equal(halfway.maneuver, "somersault");
  assert.ok(
    vector(halfway.playerForward).dot(vector(start.playerForward)) < -0.95,
    "halfway round the loop the ship should be flying back the other way",
  );

  qa.steerForSteps(0.8, -0.8, Math.ceil(stepsFor("somersault") / 2));
  const end = qa.snapshot();
  assert.equal(end.maneuver, null);
  assert.ok(vector(end.playerForward).dot(vector(start.playerForward)) > 0.999);
  assert.ok(vector(end.playerUp).dot(vector(start.playerUp)) > 0.999);
  assert.ok(
    end.boostRemaining < start.boostRemaining - 2,
    "a somersault costs reservoir",
  );
  engine.dispose();
});

test("a U-turn reverses the heading and finishes upright", () => {
  const { engine, qa } = startFlying();
  const start = qa.snapshot();
  assert.equal(qa.maneuver("uturn"), true);
  qa.flyForSteps(stepsFor("uturn"));
  const end = qa.snapshot();
  assert.equal(end.maneuver, null);
  assert.ok(vector(end.playerForward).dot(vector(start.playerForward)) < -0.999);
  assert.ok(vector(end.playerUp).dot(vector(start.playerUp)) > 0.999);
  engine.dispose();
});

test("a barrel roll jinks sideways and keeps the heading", () => {
  const { engine, qa } = startFlying();
  const start = qa.snapshot();
  assert.equal(qa.maneuver("barrelRoll", 1), true);
  qa.flyForSteps(stepsFor("barrelRoll"));
  const end = qa.snapshot();
  const moved = vector(end.playerPosition).sub(vector(start.playerPosition));
  assert.ok(
    Math.abs(moved.dot(vector(start.playerRight)) - BARREL_ROLL_JINK) < 0.01,
  );
  assert.ok(vector(end.playerForward).dot(vector(start.playerForward)) > 0.9999);
  assert.ok(Math.abs(end.shipUpDotFrameRight) < 0.01, "the roll comes full circle");
  engine.dispose();
});

test("a barrel roll deflects an enemy bolt that would otherwise hit", () => {
  const unprotected = startFlying();
  unprotected.qa.fireAtPlayer(25);
  unprotected.qa.flyForSteps(12);
  assert.ok(unprotected.qa.snapshot().shields < 100, "the bolt should hit");
  unprotected.engine.dispose();

  const { engine, qa } = startFlying();
  qa.maneuver("barrelRoll", -1);
  qa.flyForSteps(3);
  assert.equal(qa.snapshot().deflecting, true);
  qa.fireAtPlayer(25);
  qa.flyForSteps(12);
  const end = qa.snapshot();
  assert.equal(end.deflections, 1);
  assert.equal(end.shields, 100);
  engine.dispose();
});

test("barrel rolls are rate-limited by a cooldown", () => {
  const { engine, qa } = startFlying();
  assert.equal(qa.maneuver("barrelRoll"), true);
  qa.flyForSteps(stepsFor("barrelRoll"));
  assert.equal(qa.maneuver("barrelRoll"), false);
  qa.flyForSteps(30);
  assert.equal(qa.maneuver("barrelRoll"), true);
  engine.dispose();
});

test("the brake slows the ship and burns the afterburner reservoir", () => {
  const { engine, qa } = startFlying();
  const start = qa.snapshot();
  const slowest = qa.brakeForSteps(90);
  const end = qa.snapshot();
  assert.ok(slowest < start.speed * 0.5, `${slowest} vs ${start.speed}`);
  assert.equal(end.braking, true);
  assert.ok(end.boostRemaining < start.boostRemaining - 1.4);
  engine.dispose();
});

test("a loop is refused when the reservoir can't pay for it", () => {
  const { engine, qa } = startFlying();
  qa.boostForSteps(700);
  assert.equal(qa.maneuver("somersault"), false);
  assert.equal(qa.maneuver("uturn"), false);
  assert.equal(qa.snapshot().maneuver, null);
  engine.dispose();
});

test("keyboard input starts each maneuver", () => {
  const { engine, qa } = startFlying();
  let now = 0;
  const frame = () => {
    now += 1000 / 60;
    engine.frame(now, STEP);
  };

  pressKey("KeyE");
  releaseKey("KeyE");
  frame();
  assert.equal(qa.snapshot().maneuver, "barrelRoll");
  for (let step = 0; step < 70; step += 1) frame();

  pressKey("ArrowLeft");
  releaseKey("ArrowLeft");
  frame();
  pressKey("ArrowLeft");
  releaseKey("ArrowLeft");
  frame();
  assert.equal(qa.snapshot().maneuver, "barrelRoll", "double-tapped arrow");
  for (let step = 0; step < 40; step += 1) frame();

  pressKey("KeyW");
  releaseKey("KeyW");
  frame();
  assert.equal(qa.snapshot().maneuver, "somersault");
  for (let step = 0; step < stepsFor("somersault"); step += 1) frame();

  pressKey("KeyS");
  frame();
  assert.equal(qa.snapshot().braking, true);
  pressKey("ShiftLeft");
  frame();
  assert.equal(qa.snapshot().maneuver, "uturn", "brake and boost together");
  releaseKey("KeyS");
  releaseKey("ShiftLeft");
  engine.dispose();
});
