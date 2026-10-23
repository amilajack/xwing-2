import * as THREE from "three";
import {
  BARREL_ROLL_COOLDOWN,
  BRAKE_SPEED_FACTOR,
  BRAKE_TURN_FACTOR,
  MANEUVER_DURATION,
  MANEUVER_METER_COST,
  maneuverPose,
  type ManeuverKind,
  type ManeuverPose,
} from "../app/game/maneuvers";
type ActiveManeuver = {
  kind: ManeuverKind;
  direction: -1 | 1;
  elapsed: number;
  pose: ManeuverPose;
};
type HudSnapshot = {
  input: "KEYBOARD + MOUSE" | "GAMEPAD" | "PHONE / GYRO" | "TOUCH";
};
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const REFERENCE_SPEED_SCALE = 17.5;
const MAX_PITCH_RATE = THREE.MathUtils.degToRad(78);
const MAX_YAW_RATE = THREE.MathUtils.degToRad(92);
const FLIGHT_CONTROL_RESPONSE = 7;

const MAX_BANK_ROLL = THREE.MathUtils.degToRad(55);
const BANK_ROLL_RESPONSE = 5;

const BOOST_MAX_SECONDS = 10;
const BOOST_RECHARGE_PER_SECOND = 0.5;
const BOOST_REARM_SECONDS = BOOST_MAX_SECONDS * 0.25;
const BOOST_SPEED_FACTOR = 2.2;
const BOOST_RESPONSE = 4.5;

/** Renderer-independent flight and maneuver dynamics, shared by solo, server and prediction. */
export class FlightDynamics {
  player = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  };
  playerModel = { rotation: { z: 0 } };
  onFlightSound: (sound: "denied" | "roll" | "maneuver") => void = () => {};
  bankRoll = 0;
  phoneBankRoll = 0;
  mouseXPercent = 0;
  mouseYPercent = 0;
  sideways = false;
  sidewaysRotation = 0;
  sidewaysStartRotation = 0;
  sidewaysTargetRotation = 0;
  sidewaysTween = 1;
  speedMultiplier = 4;
  speed = 70;
  boostRemaining = BOOST_MAX_SECONDS;
  boostActive = false;
  boostLocked = false;
  boostBlend = 0;
  brakeActive = false;
  brakeBlend = 0;
  maneuver: ActiveManeuver | null = null;
  pendingManeuver: {
    kind: ManeuverKind;
    direction: -1 | 1;
  } | null = null;
  maneuverStep: ManeuverPose = {
    pitch: 0,
    roll: 0,
    lateral: 0,
  };
  maneuverRoll = 0;
  barrelRollCooldown = 0;
  angularVelocity = new THREE.Vector3();
  activeInput: HudSnapshot["input"] = "KEYBOARD + MOUSE";
  tempV1 = new THREE.Vector3();
  tempQ1 = new THREE.Quaternion();
  tempEuler = new THREE.Euler();
  // Boost and brake both burn the afterburner reservoir: the brake is the
  // burner fired against the direction of travel. Holding both at once is the
  // U-turn chord, so it fires neither.
  updateThrottle(delta: number, boostHeld: boolean, brakeHeld: boolean) {
    const held = boostHeld !== brakeHeld;
    if (held && !this.boostLocked && this.boostRemaining > 0) {
      this.boostActive = boostHeld;
      this.brakeActive = brakeHeld;
      this.boostRemaining = Math.max(0, this.boostRemaining - delta);
      // Draining to empty locks the burner out until the reservoir has
      // recovered, so the pilot cannot chain two full-length burns.
      if (this.boostRemaining === 0) {
        this.boostActive = false;
        this.brakeActive = false;
        this.boostLocked = true;
      }
    } else {
      this.boostActive = false;
      this.brakeActive = false;
      this.boostRemaining = Math.min(
        BOOST_MAX_SECONDS,
        this.boostRemaining + delta * BOOST_RECHARGE_PER_SECOND,
      );
      if (this.boostLocked && this.boostRemaining >= BOOST_REARM_SECONDS) {
        this.boostLocked = false;
      }
    }

    this.boostBlend = THREE.MathUtils.damp(
      this.boostBlend,
      this.boostActive ? 1 : 0,
      BOOST_RESPONSE,
      delta,
    );
    this.brakeBlend = THREE.MathUtils.damp(
      this.brakeBlend,
      this.brakeActive ? 1 : 0,
      BOOST_RESPONSE,
      delta,
    );
  }

  /**
   * Starts a maneuver if the ship is free to fly one and the reservoir can
   * pay for it. Returns whether it started.
   */
  startManeuver(kind: ManeuverKind, direction: -1 | 1 = 1) {
    if (this.maneuver) return false;
    if (kind === "barrelRoll" && this.barrelRollCooldown > 0) return false;
    const cost = MANEUVER_METER_COST[kind];
    if (cost > 0 && (this.boostLocked || this.boostRemaining < cost)) {
      this.onFlightSound("denied");
      return false;
    }
    this.boostRemaining -= cost;
    if (cost > 0 && this.boostRemaining <= 0) {
      this.boostRemaining = 0;
      this.boostLocked = true;
    }
    if (kind === "barrelRoll") this.barrelRollCooldown = BARREL_ROLL_COOLDOWN;
    this.maneuver = {
      kind,
      direction,
      elapsed: 0,
      pose: maneuverPose(kind, 0),
    };
    this.onFlightSound(kind === "barrelRoll" ? "roll" : "maneuver");
    return true;
  }

  /** True while a somersault or U-turn has taken the stick away. */
  scriptedManeuverActive() {
    return this.maneuver !== null && this.maneuver.kind !== "barrelRoll";
  }

  barrelRolling() {
    return this.maneuver?.kind === "barrelRoll";
  }

  /**
   * Advances the active maneuver and returns how far it moved this step:
   * pitch and roll for the flight frame, and the sideways jink.
   */
  advanceManeuver(delta: number) {
    const step = this.maneuverStep;
    step.pitch = 0;
    step.roll = 0;
    step.lateral = 0;
    if (!this.maneuver) return step;
    const maneuver = this.maneuver;
    maneuver.elapsed += delta;
    const t = Math.min(1, maneuver.elapsed / MANEUVER_DURATION[maneuver.kind]);
    const pose = maneuverPose(maneuver.kind, t);
    step.pitch = pose.pitch - maneuver.pose.pitch;
    step.roll = (pose.roll - maneuver.pose.roll) * maneuver.direction;
    step.lateral = (pose.lateral - maneuver.pose.lateral) * maneuver.direction;
    maneuver.pose = pose;
    if (t >= 1) this.maneuver = null;
    return step;
  }

  advanceFlight(delta: number, input: { boost: boolean; brake?: boolean }) {
    this.speedMultiplier = Math.min(9, this.speedMultiplier + 0.001);
    this.barrelRollCooldown = Math.max(0, this.barrelRollCooldown - delta);
    if (this.pendingManeuver) {
      this.startManeuver(
        this.pendingManeuver.kind,
        this.pendingManeuver.direction,
      );
      this.pendingManeuver = null;
    }
    const scripted = this.scriptedManeuverActive();
    // A loop or U-turn flies at whatever throttle it started with.
    this.updateThrottle(
      delta,
      !scripted && input.boost,
      !scripted && Boolean(input.brake),
    );
    this.speed =
      this.speedMultiplier *
      REFERENCE_SPEED_SCALE *
      (1 + this.boostBlend * (BOOST_SPEED_FACTOR - 1)) *
      THREE.MathUtils.lerp(1, BRAKE_SPEED_FACTOR, this.brakeBlend);
    const turnFactor = THREE.MathUtils.lerp(
      1,
      BRAKE_TURN_FACTOR,
      this.brakeBlend,
    );

    const previousProfileRotation = this.sidewaysRotation;
    if (this.sidewaysTween < 1) {
      this.sidewaysTween = Math.min(1, this.sidewaysTween + delta / 0.8);
      const exponentialOut =
        this.sidewaysTween >= 1 ? 1 : 1 - Math.pow(2, -10 * this.sidewaysTween);
      this.sidewaysRotation = THREE.MathUtils.lerp(
        this.sidewaysStartRotation,
        this.sidewaysTargetRotation,
        exponentialOut,
      );
    }

    // A loop or U-turn takes the stick away, and the turn rates settle to
    // nothing so control comes back smoothly when the maneuver ends.
    const targetPitchRate = scripted
      ? 0
      : -this.mouseYPercent * MAX_PITCH_RATE * turnFactor;
    const targetYawRate = scripted
      ? 0
      : -this.mouseXPercent * MAX_YAW_RATE * turnFactor;
    this.angularVelocity.x = THREE.MathUtils.damp(
      this.angularVelocity.x,
      targetPitchRate,
      FLIGHT_CONTROL_RESPONSE,
      delta,
    );
    this.angularVelocity.y = THREE.MathUtils.damp(
      this.angularVelocity.y,
      targetYawRate,
      FLIGHT_CONTROL_RESPONSE,
      delta,
    );

    // Lay the ship over into the turn. On a phone it copies the phone's roll
    // exactly; that reading is already smoothed, and damping it again would
    // leave the ship trailing the hand. Other inputs bank in proportion to
    // the steering. Rotating the model rather than the flight frame keeps it
    // decorative: holding a turn never bends the climb input into a turn.
    this.bankRoll =
      this.activeInput === "PHONE / GYRO"
        ? this.phoneBankRoll
        : THREE.MathUtils.damp(
            this.bankRoll,
            -this.mouseXPercent * MAX_BANK_ROLL,
            BANK_ROLL_RESPONSE,
            delta,
          );
    const rolling = this.barrelRolling();
    const maneuverStep = this.advanceManeuver(delta);
    // A barrel roll spins the model, not the flight frame, like the bank: the
    // ship keeps flying where it was aimed while it rolls. Rolling right is a
    // negative turn about the roll axis, as the bank is.
    if (rolling && this.maneuver) {
      this.maneuverRoll -= maneuverStep.roll;
    } else {
      this.maneuverRoll = 0;
    }
    this.playerModel.rotation.z = this.bankRoll + this.maneuverRoll;

    this.tempEuler.set(
      this.angularVelocity.x * delta + maneuverStep.pitch,
      this.angularVelocity.y * delta,
      this.sidewaysRotation -
        previousProfileRotation +
        (rolling ? 0 : maneuverStep.roll),
      "XYZ",
    );
    this.tempQ1.setFromEuler(this.tempEuler);
    this.player.quaternion.multiply(this.tempQ1).normalize();

    if (maneuverStep.lateral !== 0) {
      this.player.position.addScaledVector(
        this.tempV1.set(1, 0, 0).applyQuaternion(this.player.quaternion),
        maneuverStep.lateral,
      );
    }

    const playerForward = this.tempV1
      .copy(LOCAL_FORWARD)
      .applyQuaternion(this.player.quaternion);
    this.player.position.addScaledVector(playerForward, this.speed * delta);
  }
}
