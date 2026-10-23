import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { Simulation, offset } from "../shared/simulation";
import { neutralControls } from "../shared/protocol";
import { Rooms, type MatchResult } from "../server/rooms";

function duel() {
  const s = new Simulation(55, "versus");
  const a = s.join("a", "Alpha"),
    b = s.join("b", "Bravo");
  s.step();
  a.protectedUntil = b.protectedUntil = 0;
  return { s, a, b };
}
function stage() {
  const result = duel(),
    { s, a, b } = result;
  a.flight.player.position.set(0, 0, 0);
  b.flight.player.position.set(0, 0, -12);
  s.enemies.forEach((e) => (e.fireAt = Infinity));
  s.enemies.forEach((e) => e.p.set(500, 500, 500));
  s.bolts.push({
    id: 999,
    owner: "a",
    p: new Vector3(0, 0, -5),
    v: new Vector3(0, 0, -1200),
    damage: 250,
    expires: 1000,
  });
  return result;
}

test("versus waits for two connected pilots and retains AI squadrons", () => {
  const s = new Simulation(9, "versus");
  const a = s.join("a", "Alpha");
  s.step();
  assert.equal(s.phase, "waiting");
  assert.equal(s.enemies.length, 0);
  const b = s.join("b", "Bravo");
  b.connected = false;
  s.step();
  assert.equal(s.phase, "waiting");
  b.connected = true;
  s.step();
  assert.equal(s.phase, "active");
  assert.equal(s.enemies.length, 11);
  assert.ok(
    offset(a.flight.player.position, b.flight.player.position).length() >= 180,
  );
  s.join("c", "Charlie");
  assert.equal(s.enemies.length, 15);
});
test("player bolts kill opponents once, exclude shooter, and preserve co-op immunity", () => {
  const { s, a, b } = stage();
  s.step();
  assert.equal(a.hull, 100);
  assert.equal(b.hull, 0);
  assert.equal(a.humanKills, 1);
  assert.equal(b.deaths, 1);
  s.damagePilot(b, 1000, a.id);
  assert.equal(a.humanKills, 1);
  const coop = new Simulation(55);
  const c = coop.join("a", "A"),
    d = coop.join("b", "B");
  c.flight.player.position.set(0, 0, 0);
  d.flight.player.position.set(0, 0, -12);
  coop.bolts.push({
    id: 999,
    owner: "a",
    p: new Vector3(0, 0, -5),
    v: new Vector3(0, 0, -1200),
    damage: 250,
    expires: 1000,
  });
  coop.step();
  assert.equal(d.hull, 100);
});
test("nearest swept target blocks a bolt across arena wrapping", () => {
  const { s, a, b } = duel();
  a.flight.player.position.set(699, 0, 0);
  b.flight.player.position.set(-695, 0, 0);
  const enemy = s.enemies[0];
  enemy.p.set(-689, 0, 0);
  enemy.speed = 0;
  enemy.health = 40;
  s.bolts = [
    {
      id: 999,
      owner: a.id,
      p: new Vector3(699, 0, 0),
      v: new Vector3(1200, 0, 0),
      damage: 250,
      expires: 1000,
    },
  ];
  s.step();
  assert.equal(b.hull, 0);
  assert.equal(enemy.health, 40);
});
test("barrel roll reflects human bolts and transfers kill ownership", () => {
  const { s, a, b } = stage();
  b.flight.barrelRolling = () => true;
  a.flight.player.position.set(0, 0, 20);
  s.step();
  assert.equal(b.hull, 100);
  assert.equal(s.bolts[0].owner, b.id);
  b.flight.barrelRolling = () => false;
  s.bolts[0].p.set(0, 0, 10);
  s.bolts[0].v.set(0, 0, 1200);
  s.step();
  assert.equal(a.hull, 0);
  assert.equal(b.humanKills, 1);
});
test("AI kills and environmental deaths do not advance victory", () => {
  const { s, a, b } = duel();
  s.damageEnemy(s.enemies[0].id, 1000, a.id);
  assert.equal(a.kills, 1);
  assert.equal(a.points, 110);
  assert.equal(a.humanKills, 0);
  s.damagePilot(b, 250);
  assert.equal(b.deaths, 1);
  assert.equal(a.humanKills, 0);
});
test("spawn shield ends on fire; respawn is five seconds with safe placement and fresh shield", () => {
  const { s, a, b } = duel();
  a.protectedUntil = s.tick + 120;
  s.damagePilot(a, 250, b.id);
  assert.equal(a.hull, 100);
  s.setInput(a.id, { ...neutralControls(1), fire: true });
  s.step();
  assert.equal(a.protectedUntil, 0);
  s.damagePilot(a, 250, b.id);
  const respawn = a.respawnAt;
  s.enemies.forEach((e) => (e.fireAt = Infinity));
  s.bolts = [];
  while (s.tick < respawn - 1) s.step();
  assert.equal(a.hull, 0);
  s.step();
  assert.equal(a.hull, 100);
  assert.equal(a.protectedUntil, s.tick + 120);
  assert.ok(
    offset(a.flight.player.position, b.flight.player.position).length() >= 180,
  );
});
test("first to ten freezes results, then rematches without resetting ticks or sequences", () => {
  const { s, a, b } = duel();
  a.humanKills = s.participants.get(a.id)!.humanKills = 9;
  s.setInput(a.id, neutralControls(55));
  s.step();
  s.damagePilot(b, 250, a.id);
  const ended = s.tick,
    position = a.flight.player.position.toArray();
  assert.equal(s.winner, a.id);
  assert.equal(s.phase, "results");
  s.damageEnemy(s.enemies[0].id, 1000, b.id);
  s.damagePilot(a, 250, b.id);
  for (let i = 0; i < 599; i++) s.step();
  assert.deepEqual(a.flight.player.position.toArray(), position);
  assert.equal(a.hull, 100);
  s.step();
  assert.equal(s.round, 2);
  assert.equal(s.tick, ended + 600);
  assert.equal(a.input.seq, 55);
  assert.equal(s.phase, "waiting");
  assert.equal(a.humanKills, 0);
  assert.equal(b.deaths, 0);
  s.step();
  assert.equal(s.phase, "active");
  assert.equal(s.enemies.length, 11);
  assert.equal(s.setInput(a.id, neutralControls(56)), true);
});
test("departures retain standings until next round; waiting rematch requires two connected pilots", () => {
  const { s, a, b } = duel();
  a.humanKills = s.participants.get(a.id)!.humanKills = 9;
  s.damagePilot(b, 250, a.id);
  s.leave(b.id);
  for (let i = 0; i < 600; i++) s.step();
  assert.equal(s.phase, "waiting");
  assert.equal(s.participants.has(b.id), false);
  s.step();
  assert.equal(s.phase, "waiting");
});
test("mode admission, reconnect identity, and distinct round persistence", () => {
  const saved: MatchResult[] = [];
  const r = new Rooms((x) => saved.push(x));
  const request = (extra = {}) =>
    r.admission(
      { action: "quick", callsign: "Pilot", mode: "versus", ...extra },
      "https://test",
    );
  const first = request();
  const t = r.consume(first.ticket, "https://test");
  const generation = r.connect(t);
  assert.throws(() => request({ mode: "coop" }), /occupied/);
  assert.throws(() => request({ mode: "invalid" }), /Unknown match mode/);
  const second = request();
  const t2 = r.consume(second.ticket, "https://test");
  r.connect(t2);
  r.step();
  const sim = t.room.sim,
    a = sim.pilots.get(t.slot.id)!,
    b = sim.pilots.get(t2.slot.id)!;
  a.protectedUntil = b.protectedUntil = 0;
  a.humanKills = sim.participants.get(a.id)!.humanKills = 9;
  r.disconnect(t.room, t.slot, generation);
  const reconnect = request({
    action: "reconnect",
    reconnect: first.reconnect,
  });
  r.connect(r.consume(reconnect.ticket, "https://test"));
  assert.equal(sim.enemies.length, 11);
  assert.equal(a.humanKills, 9);
  sim.damagePilot(b, 250, a.id);
  r.step();
  assert.equal(saved.filter((x) => x.status === "completed").length, 1);
  const result = saved.find((x) => x.status === "completed")!;
  r.checkpoint();
  assert.equal(saved.at(-1)!.status, "completed");
  assert.equal(result.winner, a.id);
  assert.equal(result.participants[0].humanKills, 10);
  for (let i = 0; i < 600; i++) r.step();
  assert.notEqual(t.room.matchId, result.id);
  assert.equal(saved.at(-1)!.status, "active");
  assert.equal(saved.at(-1)!.participants[0].humanKills, 0);
  r.drain();
  assert.equal(saved.at(-1)!.status, "interrupted");
});

test("a simultaneous tenth-kill exchange produces one winner and frozen standings", () => {
  const { s, a, b } = stage();
  a.humanKills = s.participants.get(a.id)!.humanKills = 9;
  b.humanKills = s.participants.get(b.id)!.humanKills = 9;
  s.bolts.push({
    id: 1000,
    owner: b.id,
    p: new Vector3(0, 0, -5),
    v: new Vector3(0, 0, 1200),
    damage: 250,
    expires: 1000,
  });
  s.step();
  assert.equal(s.winner, a.id);
  assert.equal(a.humanKills, 10);
  assert.equal(b.humanKills, 9);
  assert.equal(s.events.filter((e) => e.type === "round_ended").length, 1);
  assert.equal(s.bolts.length, 0);
});

test("versus standings have a bounded admission budget without blocking reconnect", () => {
  const r = new Rooms();
  const first = r.admission(
    { action: "quick", callsign: "Alpha", mode: "versus" },
    "https://test",
  );
  const t = r.consume(first.ticket, "https://test");
  const generation = r.connect(t);
  for (let i = 0; i < 63; i++)
    t.room.sim.participants.set(`old-${i}`, {
      id: `old-${i}`,
      callsign: "Departed Pilot",
      kills: 0,
      humanKills: 0,
      deaths: 0,
      points: 0,
    });
  assert.throws(
    () =>
      r.admission(
        { action: "quick", callsign: "New Pilot", mode: "versus" },
        "https://test",
      ),
    /participant limit/,
  );
  r.disconnect(t.room, t.slot, generation);
  const reconnect = r.admission(
    { action: "reconnect", callsign: "Alpha", reconnect: first.reconnect },
    "https://test",
  );
  r.connect(r.consume(reconnect.ticket, "https://test"));
  assert.equal(t.room.sim.pilots.size, 1);
});

test("spawn placement falls back to safe grid candidates when random samples are obstructed", () => {
  const s = new Simulation(44, "versus");
  const asteroid = s.asteroids.find((a) => Math.abs(a.position[1]) < 500)!;
  const values = [
    (asteroid.position[0] + 700) / 1400,
    (asteroid.position[1] + 500) / 1000,
    (asteroid.position[2] + 700) / 1400,
  ];
  let next = 0;
  (s as unknown as { random: () => number }).random = () => values[next++ % 3];
  const a = s.join("a", "Alpha");
  assert.ok(
    s.asteroids.every(
      (rock) =>
        offset(
          a.flight.player.position,
          new Vector3(...rock.position),
        ).length() >=
        rock.radius + 16,
    ),
  );
});

test("maximum versus world and departed standings fit reliable and datagram budgets", async () => {
  const { reliableMessage, snapshotPackets, PROTOCOL_VERSION } =
    await import("../shared/protocol");
  const s = new Simulation(1, "versus");
  for (let i = 0; i < 4; i++)
    s.join(
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      "Twenty Character Ace",
    );
  s.step();
  s.wave = 20;
  s.enemies = [];
  for (let i = 0; i < 140; i++) s.step();
  assert.equal(s.enemies.length, 34);
  const owner = [...s.pilots.keys()][0];
  for (let i = 4; i < 64; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    s.participants.set(id, {
      id,
      callsign: "Twenty Character Ace",
      kills: 999,
      humanKills: 9,
      deaths: 999,
      points: 999999,
    });
  }
  s.bolts = Array.from({ length: 320 }, (_, i) => ({
    id: i,
    owner,
    p: new Vector3(Math.PI * i, Math.E * i, Math.SQRT2 * i),
    v: new Vector3(Math.PI * 100, Math.E * 100, Math.SQRT2 * 100),
    damage: 28,
    expires: 1000,
  }));
  const state = s.snapshot();
  assert.doesNotThrow(() =>
    reliableMessage({
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      pilot: owner,
      state,
    }),
  );
  const packets = snapshotPackets(s.tick, state);
  assert.ok(packets.length <= 128);
  assert.ok(packets.every((p) => p.length <= 1100));
});
