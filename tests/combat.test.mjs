import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { leadTargetPoint, segmentHitsSphere } from "../app/game/combatMath.ts";

const v = (x, y, z) => new THREE.Vector3(x, y, z);

test("a bolt that jumps over a fighter in one step still hits it", () => {
  // A boosted bolt covers ~16 units per 60 Hz step, several fighter widths.
  const start = v(0, 0, 0);
  const end = v(0, 0, -16);
  const fighter = v(0, 1, -8);
  assert.ok(start.distanceTo(fighter) > 4.2 && end.distanceTo(fighter) > 4.2);
  assert.ok(segmentHitsSphere(start, end, fighter, 4.2));
});

test("a bolt that passes wide of a fighter misses", () => {
  assert.ok(!segmentHitsSphere(v(0, 0, 0), v(0, 0, -16), v(6, 0, -8), 4.2));
});

test("only the swept segment counts, not the line beyond it", () => {
  // The fighter sits on the bolt's line, but past where this step ends.
  assert.ok(!segmentHitsSphere(v(0, 0, 0), v(0, 0, -16), v(0, 0, -30), 4.2));
  assert.ok(segmentHitsSphere(v(0, 0, 0), v(0, 0, 0), v(0, 0, -3), 4.2));
});

test("the lead point is where a bolt actually meets a moving target", () => {
  const shooter = v(0, 0, 0);
  const target = v(0, 0, -300);
  const velocity = v(60, 0, 0);
  const boltSpeed = 500;
  const lead = leadTargetPoint(shooter, target, velocity, boltSpeed, v(0, 0, 0));

  const flightTime = lead.distanceTo(shooter) / boltSpeed;
  const targetThen = target.clone().addScaledVector(velocity, flightTime);
  assert.ok(
    lead.distanceTo(targetThen) < 0.5,
    `lead point misses by ${lead.distanceTo(targetThen).toFixed(2)} units`,
  );
  assert.ok(lead.x > 30, "the lead point sits ahead of the target's motion");
});

test("a stationary target needs no lead", () => {
  const target = v(10, 5, -200);
  const lead = leadTargetPoint(v(0, 0, 0), target, v(0, 0, 0), 500, v(0, 0, 0));
  assert.ok(lead.distanceTo(target) < 1e-9);
});
