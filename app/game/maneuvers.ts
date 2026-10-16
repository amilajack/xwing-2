/**
 * Scripted evasive maneuvers, in the spirit of Star Fox: a barrel roll that
 * jinks sideways and swats incoming bolts away, a somersault that loops back
 * onto the same heading behind a pursuer, and a U-turn (Immelmann) that
 * reverses the heading and ends upright.
 *
 * Each maneuver is a pose curve over normalized time. The engine applies the
 * change in pose between steps, so a maneuver lands on exactly the same
 * orientation whatever the step size.
 */

export type ManeuverKind = "barrelRoll" | "somersault" | "uturn";

export type ManeuverPose = {
  /** Cumulative pitch-up of the flight frame, in radians. */
  pitch: number;
  /** Cumulative roll, in radians, toward the maneuver's direction. */
  roll: number;
  /** Cumulative sideways jink, in world units, toward the direction. */
  lateral: number;
};

export const MANEUVER_DURATION: Record<ManeuverKind, number> = {
  barrelRoll: 0.5,
  somersault: 1.6,
  uturn: 1.4,
};

/** Seconds of afterburner reservoir each maneuver spends to start. */
export const MANEUVER_METER_COST: Record<ManeuverKind, number> = {
  barrelRoll: 0,
  somersault: 3,
  uturn: 3,
};

/** Seconds from the start of one barrel roll until the next can begin. */
export const BARREL_ROLL_COOLDOWN = 0.9;
export const BARREL_ROLL_JINK = 14;
/**
 * While rolling, the spinning wings swat away any enemy bolt that comes
 * within this distance, rather than only bolts that would have hit the hull.
 */
export const BARREL_ROLL_DEFLECT_RADIUS = 8.5;
export const BRAKE_SPEED_FACTOR = 0.45;
export const BRAKE_TURN_FACTOR = 1.35;
/** Two taps of the same arrow within this many seconds roll that way. */
export const DOUBLE_TAP_WINDOW = 0.25;
/** The share of a U-turn spent on the half loop before the half roll. */
const UTURN_PITCH_SHARE = 0.55;

/** Eases in and out, so the move starts and finishes without a jolt. */
function ease(t: number) {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export function maneuverPose(kind: ManeuverKind, t: number): ManeuverPose {
  switch (kind) {
    case "barrelRoll":
      return {
        pitch: 0,
        roll: Math.PI * 2 * ease(t),
        lateral: BARREL_ROLL_JINK * ease(t),
      };
    case "somersault":
      return { pitch: Math.PI * 2 * ease(t), roll: 0, lateral: 0 };
    case "uturn":
      return {
        pitch: Math.PI * ease(t / UTURN_PITCH_SHARE),
        roll:
          Math.PI * ease((t - UTURN_PITCH_SHARE) / (1 - UTURN_PITCH_SHARE)),
        lateral: 0,
      };
  }
}

export function isDoubleTap(
  lastTapTime: number,
  now: number,
  window = DOUBLE_TAP_WINDOW,
) {
  return now - lastTapTime <= window;
}
