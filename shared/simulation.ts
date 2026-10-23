import { Quaternion, Vector3 } from "three";
import {
  damageLayers,
  enemyStats,
  enemyPoints,
  enemyHeading,
  enemyTurnRate,
  enemyWeapon,
  waveComposition,
} from "./combat";
import { FlightDynamics } from "./flight";
import { neutralControls, TICK_SECONDS, type Controls } from "./protocol";
import { BARREL_ROLL_DEFLECT_RADIUS } from "../app/game/maneuvers";
export const ARENA_PERIOD = 1400;
export const wrap = (x: number) =>
  ((((x + 700) % ARENA_PERIOD) + ARENA_PERIOD) % ARENA_PERIOD) - 700;
export const offset = (from: Vector3, to: Vector3) =>
  new Vector3(wrap(to.x - from.x), wrap(to.y - from.y), wrap(to.z - from.z));
export const wrapPosition = (v: Vector3) =>
  v.set(wrap(v.x), wrap(v.y), wrap(v.z));
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}
export type Asteroid = {
  position: [number, number, number];
  radius: number;
  rotation: [number, number, number];
  scale: [number, number, number];
};
export function collisionMap(seed: number, count = 130): Asteroid[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => {
    let position: Asteroid["position"];
    do {
      position = [0, 0, 0].map(
        () => (random() - 0.5) * ARENA_PERIOD,
      ) as Asteroid["position"];
    } while (Math.hypot(...position) < 95);
    const radius = 3.5 + Math.pow(random(), 1.8) * 16;
    const rotation = [
      random() * Math.PI,
      random() * Math.PI,
      random() * Math.PI,
    ] as Asteroid["rotation"];
    const scale = [0, 0, 0].map(
      () => radius * (0.72 + random() * 0.48),
    ) as Asteroid["scale"];
    return { position, radius, rotation, scale };
  });
}
const flightNumbers = [
  "bankRoll",
  "speedMultiplier",
  "speed",
  "boostRemaining",
  "boostBlend",
  "brakeBlend",
  "barrelRollCooldown",
  "maneuverRoll",
  "sidewaysRotation",
  "sidewaysStartRotation",
  "sidewaysTargetRotation",
  "sidewaysTween",
] as const;
export type FlightWire = {
  p: number[];
  q: number[];
  angular: number[];
  n: number[];
  boostActive: boolean;
  brakeActive: boolean;
  boostLocked: boolean;
  sideways: boolean;
  maneuver: FlightDynamics["maneuver"];
};
export function flightWire(f: FlightDynamics): FlightWire {
  return {
    p: f.player.position.toArray(),
    q: f.player.quaternion.toArray(),
    angular: f.angularVelocity.toArray(),
    n: flightNumbers.map((k) => f[k]),
    boostActive: f.boostActive,
    brakeActive: f.brakeActive,
    boostLocked: f.boostLocked,
    sideways: f.sideways,
    maneuver: f.maneuver ? structuredClone(f.maneuver) : null,
  };
}
export function restoreFlight(f: FlightDynamics, w: FlightWire) {
  f.player.position.fromArray(w.p);
  f.player.quaternion.fromArray(w.q);
  f.angularVelocity.fromArray(w.angular);
  flightNumbers.forEach((k, i) => {
    f[k] = w.n[i];
  });
  f.boostActive = w.boostActive;
  f.brakeActive = w.brakeActive;
  f.boostLocked = w.boostLocked;
  f.sideways = w.sideways;
  f.maneuver = w.maneuver ? structuredClone(w.maneuver) : null;
}
export function advancePilot(
  f: FlightDynamics,
  input: Controls,
  dt = TICK_SECONDS,
) {
  f.mouseXPercent = input.x;
  f.mouseYPercent = input.y;
  if (f.sideways !== input.sideways) {
    f.sideways = input.sideways;
    f.sidewaysStartRotation = f.sidewaysRotation;
    f.sidewaysTargetRotation = f.sideways
      ? ((input.x < 0 ? -1 : 1) * Math.PI) / 2
      : 0;
    f.sidewaysTween = 0;
  }
  if (input.maneuver)
    f.pendingManeuver = { kind: input.maneuver, direction: input.direction };
  f.advanceFlight(dt, input);
  wrapPosition(f.player.position);
}
export type MatchMode = "coop" | "versus";
export type ParticipantStats = {
  id: string;
  callsign: string;
  kills: number;
  humanKills: number;
  deaths: number;
  points: number;
};
export type RoundPhase = "waiting" | "active" | "results";
export type Pilot = {
  id: string;
  callsign: string;
  flight: FlightDynamics;
  input: Controls;
  ack: number;
  lastInputTick: number;
  kills: number;
  humanKills: number;
  deaths: number;
  points: number;
  protectedUntil: number;
  shields: number;
  hull: number;
  respawnAt: number;
  lastDamage: number;
  collisionUntil: number;
  fireAt: number;
  connected: boolean;
};
export type EnemyKind = "fighter" | "interceptor" | "bomber";
export type Enemy = {
  id: number;
  kind: EnemyKind;
  p: Vector3;
  q: Quaternion;
  health: number;
  speed: number;
  fireAt: number;
  phase: number;
  burst: number;
  squadPilot?: string;
};
export type Bolt = {
  id: number;
  owner: string | null;
  p: Vector3;
  v: Vector3;
  damage: number;
  expires: number;
};
export type CombatEvent = {
  type:
    | "kill"
    | "destroyed"
    | "respawn"
    | "joined"
    | "left"
    | "round_started"
    | "round_ended"
    | "round_reset";
  pilot: string;
  enemy?: number;
  points?: number;
  tick: number;
};
export type WorldSnapshot = {
  mode: MatchMode;
  round: number;
  phase: RoundPhase;
  winner: string | null;
  roundEndsAt: number;
  standings: ParticipantStats[];
  tick: number;
  seed: number;
  wave: number;
  score: number;
  pilots: {
    id: string;
    callsign: string;
    flight: FlightWire;
    ack: number;
    kills: number;
    humanKills: number;
    deaths: number;
    points: number;
    protectedUntil: number;
    shields: number;
    hull: number;
    respawnAt: number;
    connected: boolean;
  }[];
  enemies: {
    id: number;
    kind: EnemyKind;
    p: number[];
    q: number[];
    health: number;
    speed: number;
  }[];
  bolts: {
    id: number;
    owner: string | null;
    p: number[];
    v: number[];
    damage: number;
  }[];
};
export class Simulation {
  round = 1;
  phase: RoundPhase;
  winner: string | null = null;
  roundEndsAt = 0;
  tick = 0;
  wave = 1;
  score = 0;
  waveAt = 0;
  readonly pilots = new Map<string, Pilot>();
  readonly participants = new Map<string, ParticipantStats>();
  enemies: Enemy[] = [];
  bolts: Bolt[] = [];
  events: CombatEvent[] = [];
  readonly asteroids: Asteroid[];
  private asteroidGrid = new Map<string, Asteroid[]>();
  private random: () => number;
  private nextId = 1;
  constructor(
    readonly seed: number,
    readonly mode: MatchMode = "coop",
  ) {
    this.phase = mode === "versus" ? "waiting" : "active";
    this.random = seededRandom(seed);
    this.asteroids = collisionMap(seed);
    for (const a of this.asteroids) {
      const key = this.cellKey(
        ...(a.position.map((x) => Math.floor((x + 700) / (1400 / 12))) as [
          number,
          number,
          number,
        ]),
      );
      const list = this.asteroidGrid.get(key) ?? [];
      list.push(a);
      this.asteroidGrid.set(key, list);
    }
  }
  private cellKey(x: number, y: number, z: number) {
    const cell = (n: number) => ((n % 12) + 12) % 12;
    return `${cell(x)},${cell(y)},${cell(z)}`;
  }
  private nearbyAsteroids(p: Vector3) {
    const cell = p
      .toArray()
      .map((x) => Math.floor((wrap(x) + 700) / (1400 / 12)));
    const result: Asteroid[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const list = this.asteroidGrid.get(
            this.cellKey(cell[0] + x, cell[1] + y, cell[2] + z),
          );
          if (list) result.push(...list);
        }
    return result;
  }
  join(id: string, callsign: string) {
    if (this.pilots.size >= 4 || this.pilots.has(id))
      throw new Error("Room full");
    const f = new FlightDynamics();
    f.player.position.set(this.pilots.size * 18, 0, 0);
    const p: Pilot = {
      id,
      callsign,
      flight: f,
      input: neutralControls(),
      ack: 0,
      lastInputTick: this.tick,
      kills: 0,
      humanKills: 0,
      deaths: 0,
      points: 0,
      protectedUntil: this.mode === "versus" ? this.tick + 120 : 0,
      shields: 100,
      hull: 100,
      respawnAt: 0,
      lastDamage: -1000,
      collisionUntil: 0,
      fireAt: 0,
      connected: true,
    };
    this.pilots.set(id, p);
    this.participants.set(id, {
      id,
      callsign,
      kills: 0,
      humanKills: 0,
      deaths: 0,
      points: 0,
    });
    if (this.mode === "versus") this.placePilot(p);
    this.events.push({ type: "joined", pilot: id, tick: this.tick });
    if (this.phase === "active") {
      if (this.participants.size === 1) this.spawnWave();
      else this.spawnSquadron(id);
    }
    return p;
  }
  leave(id: string) {
    this.pilots.delete(id);
    this.enemies = this.enemies.filter((enemy) => enemy.squadPilot !== id);
    this.events.push({ type: "left", pilot: id, tick: this.tick });
  }
  setInput(id: string, input: Controls) {
    const p = this.pilots.get(id);
    if (
      !p ||
      !p.connected ||
      input.seq <= p.input.seq ||
      input.seq - p.input.seq > 180
    )
      return false;
    p.input = { ...input };
    p.lastInputTick = this.tick;
    return true;
  }
  private spawnWave() {
    const composition = waveComposition(this.wave);
    const kinds: EnemyKind[] = (
      Object.keys(composition) as EnemyKind[]
    ).flatMap((kind) => Array<EnemyKind>(composition[kind]).fill(kind));
    this.enemies = this.spawnEnemies(kinds);
    for (const id of this.pilots.keys()) this.spawnSquadron(id);
  }
  private spawnSquadron(id: string) {
    this.enemies.push(
      ...this.spawnEnemies(Array<EnemyKind>(4).fill("fighter"), id),
    );
  }
  private spawnEnemies(kinds: EnemyKind[], squadPilot?: string): Enemy[] {
    const anchor =
      this.pilots.get(squadPilot ?? "")?.flight.player.position ??
      [...this.pilots.values()][0]?.flight.player.position ??
      new Vector3();
    return kinds.map((kind) => {
      const theta = this.random() * Math.PI * 2,
        phi = Math.acos(2 * this.random() - 1),
        radius = 260 + this.random() * 240;
      let p = new Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi) * 0.65,
        Math.sin(phi) * Math.sin(theta),
      )
        .multiplyScalar(radius)
        .add(anchor);
      for (let attempt = 0; attempt < 12 && this.asteroidAt(p, 18); attempt++)
        p = new Vector3(
          this.random() * 600 - 300,
          this.random() * 600 - 300,
          this.random() * 600 - 300,
        ).add(anchor);
      return {
        id: this.nextId++,
        squadPilot,
        kind,
        p: wrapPosition(p),
        q: new Quaternion().setFromUnitVectors(
          new Vector3(0, 0, -1),
          offset(p, anchor).normalize(),
        ),
        health: enemyStats(kind, this.wave).health,
        speed: enemyStats(kind, this.wave).speed,
        burst: 0,
        fireAt: this.tick + 60 + this.random() * 60,
        phase: this.random() * 6.28,
      };
    });
  }
  private asteroidAt(p: Vector3, padding: number) {
    for (const a of this.nearbyAsteroids(p)) {
      const d = offset(p, new Vector3(...a.position));
      if (d.lengthSq() < (a.radius + padding) ** 2) return { a, d };
    }
    return null;
  }
  private placePilot(p: Pilot) {
    let best = p.flight.player.position.clone(),
      clearance = -1;
    const consider = (candidate: Vector3) => {
      if (this.asteroidAt(candidate, 16)) return false;
      let distance = Infinity;
      for (const other of this.pilots.values())
        if (other !== p && other.hull > 0)
          distance = Math.min(
            distance,
            offset(candidate, other.flight.player.position).length(),
          );
      if (distance > clearance) {
        best = candidate;
        clearance = distance;
      }
      return distance >= 180;
    };
    for (let attempt = 0; attempt < 96; attempt++) {
      if (
        consider(
          new Vector3(
            this.random() * 1400 - 700,
            this.random() * 1000 - 500,
            this.random() * 1400 - 700,
          ),
        )
      ) {
        p.flight.player.position.copy(best);
        return;
      }
    }
    // Fixed, widely spaced fallback candidates keep placement bounded even if random samples are obstructed.
    for (let x = -600; x <= 600; x += 200)
      for (let y = -600; y <= 600; y += 200)
        for (let z = -600; z <= 600; z += 200)
          if (consider(new Vector3(x, y, z))) {
            p.flight.player.position.copy(best);
            return;
          }
    p.flight.player.position.copy(best);
  }
  private resetPilots() {
    for (const p of this.pilots.values()) {
      p.flight = new FlightDynamics();
      this.placePilot(p);
      p.hull = p.shields = 100;
      p.respawnAt = 0;
      p.protectedUntil = this.tick + 120;
      p.fireAt = this.tick;
      p.lastDamage = this.tick;
      p.collisionUntil = this.tick;
      p.input = neutralControls(p.input.seq);
    }
  }
  private nextRound() {
    this.round++;
    this.phase = "waiting";
    this.winner = null;
    this.roundEndsAt = 0;
    this.wave = 1;
    this.waveAt = 0;
    this.score = 0;
    this.bolts = [];
    this.enemies = [];
    this.participants.clear();
    for (const p of this.pilots.values()) {
      p.kills = p.humanKills = p.deaths = p.points = 0;
      this.participants.set(p.id, {
        id: p.id,
        callsign: p.callsign,
        kills: 0,
        humanKills: 0,
        deaths: 0,
        points: 0,
      });
    }
    this.resetPilots();
    this.events.push({ type: "round_reset", pilot: "", tick: this.tick });
  }
  damagePilot(p: Pilot, amount: number, owner: string | null = null) {
    if (p.hull <= 0 || amount <= 0 || !Number.isFinite(amount)) return;
    if (
      this.mode === "versus" &&
      (this.phase !== "active" || this.tick < p.protectedUntil)
    )
      return;
    p.lastDamage = this.tick;
    const damage = damageLayers(p.shields, p.hull, amount);
    p.shields = damage.shields;
    p.hull = damage.hull;
    if (p.hull === 0) {
      p.respawnAt = this.tick + 300;
      p.deaths++;
      const victim = this.participants.get(p.id);
      if (victim) victim.deaths++;
      this.events.push({ type: "destroyed", pilot: p.id, tick: this.tick });
      if (this.mode === "versus" && owner && owner !== p.id) {
        const attacker = this.participants.get(owner);
        if (attacker) {
          attacker.humanKills++;
          const live = this.pilots.get(owner);
          if (live) live.humanKills = attacker.humanKills;
          if (attacker.humanKills >= 10) {
            this.winner = owner;
            this.phase = "results";
            this.roundEndsAt = this.tick + 600;
            this.events.push({
              type: "round_ended",
              pilot: owner,
              tick: this.tick,
            });
          }
        }
      }
    }
  }
  damageEnemy(id: number, amount: number, owner: string) {
    const e = this.enemies.find((e) => e.id === id);
    if (
      !e ||
      amount <= 0 ||
      (this.mode === "versus" && this.phase !== "active")
    )
      return;
    e.health -= amount;
    if (e.health > 0) return;
    const points = enemyPoints(e.kind, this.wave);
    this.enemies = this.enemies.filter((x) => x !== e);
    this.score += points;
    const participant = this.participants.get(owner);
    if (participant) {
      participant.kills++;
      participant.points += points;
    }
    const p = this.pilots.get(owner);
    if (p) {
      p.kills++;
      p.points += points;
    }
    this.events.push({
      type: "kill",
      pilot: owner,
      enemy: id,
      points,
      tick: this.tick,
    });
  }
  private shoot(owner: string | null, p: Vector3, v: Vector3, damage: number) {
    if (this.bolts.length < 320)
      this.bolts.push({
        id: this.nextId++,
        owner,
        p: p.clone(),
        v,
        damage,
        expires: this.tick + 135,
      });
  }
  step() {
    if (!this.pilots.size) return;
    this.tick++;
    if (this.mode === "versus") {
      if (this.phase === "results") {
        if (this.tick >= this.roundEndsAt) this.nextRound();
        return;
      }
      if (this.phase === "waiting") {
        for (const p of this.pilots.values()) p.ack = p.input.seq;
        if ([...this.pilots.values()].filter((p) => p.connected).length < 2)
          return;
        this.phase = "active";
        this.resetPilots();
        this.spawnWave();
        this.events.push({ type: "round_started", pilot: "", tick: this.tick });
      }
    }
    const dt = TICK_SECONDS;
    for (const p of this.pilots.values()) {
      if (p.hull <= 0) {
        if (this.tick >= p.respawnAt) {
          p.flight = new FlightDynamics();
          p.flight.player.position.x =
            [...this.pilots.keys()].indexOf(p.id) * 18;
          if (this.mode === "versus") {
            this.placePilot(p);
            p.protectedUntil = this.tick + 120;
          }
          p.shields = p.hull = 100;
          p.respawnAt = 0;
          this.events.push({ type: "respawn", pilot: p.id, tick: this.tick });
        } else continue;
      }
      const input =
        p.connected && this.tick - p.lastInputTick <= 15
          ? p.input
          : neutralControls(p.input.seq);
      if (input.fire) p.protectedUntil = 0;
      advancePilot(p.flight, input);
      p.input.maneuver = null;
      p.ack = input.seq;
      if (this.tick - p.lastDamage > 252)
        p.shields = Math.min(100, p.shields + dt * 7.5);
      const hit = this.asteroidAt(p.flight.player.position, 2.7);
      if (hit) {
        p.flight.player.position.addScaledVector(
          hit.d.lengthSq() ? hit.d.normalize() : new Vector3(0, 1, 0),
          -(
            hit.a.radius +
            3.2 -
            offset(
              p.flight.player.position,
              new Vector3(...hit.a.position),
            ).length()
          ),
        );
        wrapPosition(p.flight.player.position);
        if (this.tick >= p.collisionUntil) {
          this.damagePilot(p, Math.min(36, 12 + p.flight.speed * 0.12));
          p.collisionUntil = this.tick + 51;
        }
      }
      if (input.fire && this.tick >= p.fireAt) {
        const forward = new Vector3(0, 0, -1).applyQuaternion(
          p.flight.player.quaternion,
        );
        const speed = 285 + p.flight.speed * 2;
        let direction = forward;
        const candidates: { p: Vector3; q: Quaternion; speed: number }[] = [
          ...this.enemies,
          ...(this.mode === "versus"
            ? [...this.pilots.values()]
                .filter((other) => other !== p && other.hull > 0)
                .map((other) => ({
                  p: other.flight.player.position,
                  q: other.flight.player.quaternion,
                  speed: other.flight.speed,
                }))
            : []),
        ];
        const target = candidates
          .map((e) => ({ e, d: offset(p.flight.player.position, e.p) }))
          .filter(
            ({ d }) =>
              d.clone().normalize().dot(forward) > Math.cos(Math.PI / 60),
          )
          .sort((a, b) => a.d.lengthSq() - b.d.lengthSq())[0];
        if (target) {
          const lead = target.d.addScaledVector(
            new Vector3(0, 0, -1).applyQuaternion(target.e.q),
            (target.e.speed * target.d.length()) / speed,
          );
          if (lead.clone().normalize().dot(forward) > Math.cos(Math.PI / 60))
            direction = lead.normalize();
        }
        this.shoot(
          p.id,
          p.flight.player.position.clone().addScaledVector(forward, 5),
          direction.multiplyScalar(speed),
          28,
        );
        p.fireAt = this.tick + 7;
      }
    }
    const alive = [...this.pilots.values()].filter((p) => p.hull > 0);
    for (const e of this.enemies) {
      const target = alive
        .map((p) => ({ p, d: offset(e.p, p.flight.player.position) }))
        .sort((a, b) => a.d.lengthSq() - b.d.lengthSq())[0];
      if (!target) continue;
      const distance = target.d.length();
      target.d.normalize();
      const obstacle =
        this.tick % 3 === e.id % 3 ? this.asteroidAt(e.p, 28) : null;
      const desired = enemyHeading(
        e.kind,
        e.phase,
        this.tick * dt,
        target.d,
        distance,
        obstacle?.d.normalize().negate() ?? null,
        new Vector3(),
      );
      e.q.slerp(
        new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), desired),
        Math.min(1, dt * enemyTurnRate(e.kind)),
      );
      const forward = new Vector3(0, 0, -1).applyQuaternion(e.q);
      wrapPosition(e.p.addScaledVector(forward, e.speed * dt));
      const weapon = enemyWeapon(e.kind, this.wave, e.burst);
      if (
        this.tick >= e.fireAt &&
        distance < weapon.range &&
        forward.dot(target.d) > weapon.aim
      ) {
        for (let shot = 0; shot < weapon.shots; shot++)
          this.shoot(
            null,
            e.p
              .clone()
              .addScaledVector(forward, e.kind === "bomber" ? 4.8 : 2.3),
            forward.clone().multiplyScalar(weapon.speed),
            weapon.damage,
          );
        e.burst = weapon.burst;
        e.fireAt = this.tick + Math.ceil(weapon.cooldown * 60);
      }
    }

    const keep: Bolt[] = [];
    for (const b of this.bolts) {
      if (b.expires <= this.tick) continue;
      const start = b.p.clone();
      const end = b.p.clone().addScaledVector(b.v, dt);
      const intersection = (p: Vector3, radius: number) => {
        const direction = end.clone().sub(start),
          center = offset(start, p);
        const length = direction.length();
        if (!length) return center.lengthSq() <= radius * radius ? 0 : Infinity;
        direction.divideScalar(length);
        const projection = center.dot(direction);
        const discriminant =
          radius * radius - (center.lengthSq() - projection * projection);
        if (discriminant < 0) return Infinity;
        const exit = projection + Math.sqrt(discriminant);
        if (exit < 0) return Infinity;
        const enter = Math.max(0, projection - Math.sqrt(discriminant));
        return enter <= length ? enter : Infinity;
      };
      let nearest = Infinity;
      let target:
        | { kind: "asteroid" }
        | { kind: "enemy"; enemy: Enemy }
        | { kind: "pilot"; pilot: Pilot; deflect: boolean }
        | null = null;
      for (const a of this.nearbyAsteroids(start)) {
        const distance = intersection(new Vector3(...a.position), a.radius);
        if (distance < nearest) {
          nearest = distance;
          target = { kind: "asteroid" };
        }
      }
      if (b.owner !== null)
        for (const e of this.enemies) {
          const distance = intersection(e.p, e.kind === "bomber" ? 7 : 4);
          if (distance < nearest) {
            nearest = distance;
            target = { kind: "enemy", enemy: e };
          }
        }
      if (b.owner === null || this.mode === "versus")
        for (const p of alive) {
          if (p.hull <= 0 || p.id === b.owner) continue;
          const deflect = p.flight.barrelRolling();
          const distance = intersection(
            p.flight.player.position,
            deflect ? BARREL_ROLL_DEFLECT_RADIUS : 3.4,
          );
          if (distance < nearest) {
            nearest = distance;
            target = { kind: "pilot", pilot: p, deflect };
          }
        }
      const consumed = target !== null;
      if (target?.kind === "enemy")
        this.damageEnemy(target.enemy.id, b.damage, b.owner!);
      if (target?.kind === "pilot") {
        if (target.deflect) {
          b.owner = target.pilot.id;
          b.p.copy(start).addScaledVector(b.v.clone().normalize(), nearest);
          b.v.negate();
          b.expires = this.tick + 144;
          keep.push(b);
        } else this.damagePilot(target.pilot, b.damage, b.owner);
      }
      if (this.phase === "results") {
        this.bolts = [];
        return;
      }
      if (!consumed) {
        b.p.copy(wrapPosition(end));
        keep.push(b);
      }
    }
    this.bolts = keep;
    if (!this.enemies.length) {
      if (!this.waveAt) this.waveAt = this.tick + 132;
      else if (this.tick >= this.waveAt) {
        this.wave++;
        this.waveAt = 0;
        this.spawnWave();
      }
    }
  }
  snapshot(): WorldSnapshot {
    return {
      mode: this.mode,
      round: this.round,
      phase: this.phase,
      winner: this.winner,
      roundEndsAt: this.roundEndsAt,
      standings: [...this.participants.values()].map((p) => ({ ...p })),
      tick: this.tick,
      seed: this.seed,
      wave: this.wave,
      score: this.score,
      pilots: [...this.pilots.values()].map((p) => ({
        id: p.id,
        callsign: p.callsign,
        flight: flightWire(p.flight),
        ack: p.ack,
        kills: p.kills,
        humanKills: p.humanKills,
        deaths: p.deaths,
        points: p.points,
        protectedUntil: p.protectedUntil,
        shields: p.shields,
        hull: p.hull,
        respawnAt: p.respawnAt,
        connected: p.connected,
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        kind: e.kind,
        p: e.p.toArray(),
        q: e.q.toArray(),
        health: e.health,
        speed: e.speed,
      })),
      bolts: this.bolts.map((b) => ({
        id: b.id,
        owner: b.owner,
        p: b.p.toArray(),
        v: b.v.toArray(),
        damage: b.damage,
      })),
    };
  }
}
