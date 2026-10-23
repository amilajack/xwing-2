import { Vector3 } from "three";
export type EnemyKind = "fighter" | "interceptor" | "bomber";
export function enemyStats(kind: EnemyKind, wave: number) {
  return {
    health:
      kind === "bomber"
        ? 132 + wave * 4
        : kind === "fighter"
          ? 40 + wave * 1.5
          : 28 + wave,
    speed:
      (kind === "fighter"
        ? 67 + Math.min(wave, 8) * 1.4
        : kind === "interceptor"
          ? 94 + Math.min(wave, 8) * 1.7
          : 49 + Math.min(wave, 8)) * 0.65,
  };
}
export const enemyPoints = (kind: EnemyKind, wave: number) =>
  ({ fighter: 110, interceptor: 175, bomber: 340 })[kind] * wave;
export const enemyTurnRate = (kind: EnemyKind) =>
  (kind === "interceptor" ? 1.75 : kind === "fighter" ? 1.18 : 0.72) * 0.75;
export function waveComposition(wave: number) {
  return {
    fighter: Math.min(2 + Math.ceil(wave * 0.75), 8),
    interceptor: wave >= 2 ? Math.min(1 + Math.floor(wave / 2), 6) : 0,
    bomber: wave >= 3 ? Math.min(Math.floor(wave / 3), 4) : 0,
  };
}
export function damageLayers(shields: number, hull: number, amount: number) {
  const absorbed = Math.min(shields, amount);
  return {
    shields: shields - absorbed,
    hull: Math.max(0, hull - amount + absorbed),
  };
}
/** Shared pursuit, interceptor weave and bomber flanking; avoidance is a vector away from a nearby asteroid. */
export function enemyHeading(
  kind: EnemyKind,
  phase: number,
  elapsed: number,
  toward: Vector3,
  distance: number,
  avoidance: Vector3 | null,
  out: Vector3,
) {
  out.copy(toward);
  const weave =
    (kind === "interceptor" ? 0.52 : kind === "fighter" ? 0.25 : 0.12) * 0.75;
  out.x += Math.sin(elapsed * 1.7 + phase) * weave;
  out.y += Math.cos(elapsed * 1.25 + phase) * weave * 0.6;
  if (kind === "bomber" && distance < 190)
    out.addScaledVector(
      new Vector3(Math.sin(phase), Math.cos(phase), 0).normalize(),
      0.8,
    );
  if (avoidance) out.addScaledVector(avoidance, 1.65);
  return out.normalize();
}
export function enemyWeapon(
  kind: EnemyKind,
  wave: number,
  previousBurst: number,
) {
  const burst = kind === "interceptor" ? (previousBurst + 1) % 3 : 0;
  return {
    speed: kind === "interceptor" ? 238 : kind === "bomber" ? 176 : 205,
    damage: kind === "bomber" ? 28 : kind === "interceptor" ? 11 : 14,
    burst,
    shots: kind === "bomber" ? 2 : 1,
    cooldown:
      kind === "bomber"
        ? Math.max(1.55, 2.7 - wave * 0.05)
        : kind === "interceptor"
          ? burst === 0
            ? Math.max(0.78, 1.28 - wave * 0.03)
            : 0.18
          : Math.max(0.58, 1.05 - wave * 0.025),
    aim: kind === "interceptor" ? 0.955 : kind === "bomber" ? 0.975 : 0.965,
    range: kind === "bomber" ? 520 : 430,
  };
}
