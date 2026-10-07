/**
 * Screen-space tilt extracted from a `deviceorientation` reading.
 *
 * `beta`/`gamma` are ZXY Euler angles, so they are NOT two independent tilt
 * axes: `gamma` is measured about an axis that `beta` has already rotated.
 * Subtracting each from a baseline therefore leaks one control axis into the
 * other whenever the phone is held with any bank at all - leaning the phone
 * back to pitch up also steers, and the leak grows with both the bank and the
 * lean of the hold.
 *
 * Deriving both angles from the gravity direction instead removes the coupling
 * by construction: `pitch` depends only on how far the screen is tipped toward
 * horizontal, and `roll` only on how far it is rotated within its own plane.
 * Neither can move when the other does. `alpha` cancels out (a spin about the
 * gravity axis cannot change gravity's direction in the device frame), so a
 * compass-less reading is still exact.
 */

export interface DeviceTilt {
  /** Degrees of nose-up command: positive as the screen is raised upright. */
  pitch: number;
  /** Degrees of turn command: positive as the screen's right edge drops. */
  roll: number;
}

const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;

export function deviceTiltFromOrientation(
  beta: number,
  gamma: number,
  screenAngleDegrees: number,
): DeviceTilt {
  const betaRadians = beta * DEGREES_TO_RADIANS;
  const gammaRadians = gamma * DEGREES_TO_RADIANS;
  const screenAngle = screenAngleDegrees * DEGREES_TO_RADIANS;

  // World "up" expressed in device axes; the alpha term cancels out.
  const cosBeta = Math.cos(betaRadians);
  const deviceRight = -Math.sin(gammaRadians) * cosBeta;
  const deviceUp = Math.sin(betaRadians);
  const outOfScreen = Math.cos(gammaRadians) * cosBeta;

  // Rotate the device axes into the axes the player actually sees.
  const cosScreen = Math.cos(screenAngle);
  const sinScreen = Math.sin(screenAngle);
  const screenRight = cosScreen * deviceRight - sinScreen * deviceUp;
  const screenUp = sinScreen * deviceRight + cosScreen * deviceUp;

  return {
    pitch:
      -Math.atan2(outOfScreen, Math.hypot(screenRight, screenUp)) *
      RADIANS_TO_DEGREES,
    roll: -Math.atan2(screenRight, screenUp) * RADIANS_TO_DEGREES,
  };
}
