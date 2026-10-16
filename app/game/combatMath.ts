import type { Vector3 } from "three";

/**
 * Whether the path a bolt swept during one step, `start` to `end`, passes
 * within `radius` of `center`.
 *
 * Bolts cover several ship-lengths per physics step, so testing only where a
 * bolt ends up lets it jump clean over a fighter. Testing the closest point
 * of the whole swept segment instead cannot miss.
 */
export function segmentHitsSphere(
  start: Vector3,
  end: Vector3,
  center: Vector3,
  radius: number,
) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentZ = end.z - start.z;
  const toCenterX = center.x - start.x;
  const toCenterY = center.y - start.y;
  const toCenterZ = center.z - start.z;
  const lengthSq = segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ;
  const along =
    lengthSq > 0
      ? Math.min(
          1,
          Math.max(
            0,
            (toCenterX * segmentX + toCenterY * segmentY + toCenterZ * segmentZ) /
              lengthSq,
          ),
        )
      : 0;
  const offsetX = toCenterX - segmentX * along;
  const offsetY = toCenterY - segmentY * along;
  const offsetZ = toCenterZ - segmentZ * along;
  return offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ <= radius * radius;
}

/**
 * Where a bolt fired now from `shooter` at `boltSpeed` meets a target moving
 * at constant `targetVelocity`, written into `out`.
 *
 * Refines the flight time a few times instead of solving the intercept
 * quadratic: each pass aims at where the target will be after the previous
 * estimate, which converges quickly while the bolt is much faster than the
 * target, and still gives a sensible point when it is not.
 */
export function leadTargetPoint(
  shooter: Vector3,
  targetPosition: Vector3,
  targetVelocity: Vector3,
  boltSpeed: number,
  out: Vector3,
  iterations = 3,
) {
  out.copy(targetPosition);
  for (let pass = 0; pass < iterations; pass += 1) {
    const flightTime = out.distanceTo(shooter) / Math.max(1, boltSpeed);
    out.copy(targetPosition).addScaledVector(targetVelocity, flightTime);
  }
  return out;
}
