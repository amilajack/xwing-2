import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import {
  Simulation,
  collisionMap,
  flightWire,
  restoreFlight,
  advancePilot,
  offset,
} from "../shared/simulation";
import { FlightDynamics } from "../shared/flight";
import {
  neutralControls,
  PROTOCOL_VERSION,
  validControls,
  snapshotPackets,
  SnapshotAssembler,
  MessageFramer,
  reliableMessage,
} from "../shared/protocol";
import { Rooms } from "../server/rooms";
import { Persistence } from "../server/persistence";

test("seeded collision map is fixed and independent of graphics", () => {
  assert.deepEqual(collisionMap(9917), collisionMap(9917));
  assert.equal(collisionMap(2).length, 130);
  assert.notDeepEqual(collisionMap(2), collisionMap(3));
});
test("two pilots damage one enemy; exactly one destruction, award and participant kill", () => {
  const s = new Simulation(1);
  s.join("a", "Alpha");
  s.join("b", "Bravo");
  const e = s.enemies[0];
  e.health = 40;
  s.damageEnemy(e.id, 28, "a");
  assert.equal(e.health, 12);
  s.damageEnemy(e.id, 28, "b");
  s.damageEnemy(e.id, 28, "a");
  assert.equal(s.score, 110);
  assert.equal(s.pilots.get("a")!.kills, 0);
  assert.equal(s.pilots.get("b")!.kills, 1);
  assert.equal(s.events.filter((e) => e.type === "kill").length, 1);
});
test("server bolts share enemy health and cannot damage teammates", () => {
  const s = new Simulation(1);
  const a = s.join("a", "Alpha"),
    b = s.join("b", "Bravo");
  s.enemies = [];
  a.flight.player.position.set(0, 0, 0);
  b.flight.player.position.set(0, 0, -20);
  s.bolts.push({
    id: 1,
    owner: "a",
    p: new Vector3(0, 0, -10),
    v: new Vector3(0, 0, -600),
    damage: 28,
    expires: 100,
  });
  s.step();
  assert.equal(b.shields, 100);
  assert.equal(s.bolts.length, 1);
});
test("destroyed pilot respawns after exactly 300 server steps", () => {
  const s = new Simulation(1);
  const p = s.join("a", "Alpha");
  s.damagePilot(p, 200);
  assert.equal(p.respawnAt, 300);
  for (let i = 0; i < 299; i++) s.step();
  assert.equal(p.hull, 0);
  s.step();
  assert.equal(p.hull, 100);
  assert.equal(p.shields, 100);
});
test("prediction restores all flight state and replays deterministic controls", () => {
  const a = new FlightDynamics();
  const b = new FlightDynamics();
  const input = { ...neutralControls(1), x: 0.4, boost: true };
  for (let i = 0; i < 50; i++) advancePilot(a, input);
  restoreFlight(b, flightWire(a));
  for (let i = 0; i < 100; i++) {
    advancePilot(a, input);
    advancePilot(b, input);
  }
  assert.deepEqual(flightWire(a), flightWire(b));
  assert.ok(
    offset(new Vector3(699, 0, 0), new Vector3(-699, 0, 0)).equals(
      new Vector3(2, 0, 0),
    ),
  );
});
test("inputs reject malformed/replayed/oversized sequences and time out to neutral", () => {
  for (const raw of [
    null,
    {},
    { ...neutralControls(1), x: NaN },
    { ...neutralControls(1), x: 2 },
    { ...neutralControls(1), seq: -1 },
    { ...neutralControls(1), fire: 1 },
  ])
    assert.equal(validControls(raw), false);
  const s = new Simulation(1);
  s.join("a", "A");
  assert.ok(s.setInput("a", { ...neutralControls(1), fire: true }));
  assert.equal(s.setInput("a", neutralControls(1)), false);
  assert.equal(s.setInput("a", neutralControls(1000)), false);
  for (let i = 0; i < 30; i++) s.step();
  assert.equal(s.pilots.get("a")!.ack, 1);
});
test("snapshot batches survive reorder/duplicates and discard lost/stale batches", () => {
  const state = { text: "星".repeat(2500) };
  const packets = snapshotPackets(1, state);
  const a = new SnapshotAssembler();
  let result;
  for (const p of packets.toReversed()) {
    result = a.accept(p, 0) ?? result;
  }
  assert.deepEqual(result, state);
  assert.equal(a.accept(packets[0], 1), null);
  const b = new SnapshotAssembler();
  b.accept(packets[0], 0);
  for (const p of packets.slice(1)) assert.equal(b.accept(p, 300), null);
  let newest;
  for (const p of snapshotPackets(2, state))
    newest = b.accept(p, 301) ?? newest;
  assert.deepEqual(newest, state);
});
test("reliable framing bounds fragmented messages", () => {
  const f = new MessageFramer();
  const bytes = reliableMessage({ type: "join", text: "星" });
  assert.deepEqual(f.push(bytes.slice(0, 8)), []);
  assert.deepEqual(f.push(bytes.slice(8)), [{ type: "join", text: "星" }]);
  assert.throws(() => f.push(new Uint8Array(200000)));
});
function setup() {
  let now = 0;
  const saved: unknown[] = [];
  const r = new Rooms(
    (x) => saved.push(x),
    () => now,
  );
  return {
    r,
    saved,
    advance: (ms: number) => {
      now += ms;
      r.sweep();
    },
  };
}
function admit(r: Rooms, action = "quick", extra = {}) {
  return r.admission(
    { action, callsign: "Pilot", ...extra },
    "https://game.test",
  );
}
test("tickets are origin-bound, single use and expire", () => {
  const { r, advance } = setup();
  const a = admit(r);
  assert.throws(() => r.consume(a.ticket, "https://evil.test"));
  const t = r.consume(a.ticket, "https://game.test");
  r.connect(t);
  assert.throws(() => r.consume(a.ticket, "https://game.test"));
  const b = admit(r);
  advance(10001);
  assert.throws(() => r.consume(b.ticket, "https://game.test"));
});
test("private invite rooms stay isolated and capacity includes all reservations", () => {
  const { r } = setup();
  const a = admit(r, "private");
  assert.throws(() => admit(r), /Server full/);
  assert.throws(() => admit(r, "invite", { invite: "bad" }));
  for (let i = 0; i < 3; i++) admit(r, "invite", { invite: a.invite });
  assert.throws(() => admit(r, "invite", { invite: a.invite }), /Squad full/);
});
test("disconnect retains vulnerable pilot and slot for 15s; reconnect restores identity", () => {
  const { r, advance, saved } = setup();
  const a = admit(r);
  const t = r.consume(a.ticket, "https://game.test");
  const generation = r.connect(t);
  r.disconnect(t.room, t.slot, generation);
  assert.equal(t.room.sim.pilots.get(t.slot.id)!.connected, false);
  advance(14999);
  const b = admit(r, "reconnect", { reconnect: a.reconnect });
  const t2 = r.consume(b.ticket, "https://game.test");
  r.connect(t2);
  assert.equal(t.slot.id, t2.slot.id);
  assert.equal(t.room.sim.pilots.size, 1);
  assert.equal(t.room.sim.enemies.length, 7);
  r.disconnect(t2.room, t2.slot, t2.slot.generation);
  advance(15001);
  assert.equal(r.room, null);
  assert.ok(saved.length >= 2);
});
test("Spot drain closes admission and persists interrupted result", () => {
  const { r, saved } = setup();
  admit(r);
  r.drain();
  assert.equal(r.room, null);
  assert.throws(() => admit(r), /restarting/);
  assert.equal((saved.at(-1) as { status: string }).status, "interrupted");
});
test("database outages never block simulation and the queue is bounded", async () => {
  const p = new Persistence(null);
  const { r } = setup();
  const a = admit(r);
  const sim = r.room!.sim;
  sim.join("a", "A");
  for (let i = 0; i < 100; i++)
    p.enqueue({
      id: String(i),
      mode: "coop",
      winner: null,
      seed: 1,
      squad: "S",
      private: false,
      status: "completed",
      startedAt: new Date(),
      endedAt: new Date(),
      score: 0,
      wave: 1,
      participants: [],
    });
  for (let i = 0; i < 600; i++) sim.step();
  assert.equal(sim.tick, 600);
  await p.flush(10);
  assert.ok(p.failures > 0);
  assert.ok(p.dropped > 0);
  assert.ok(a.ticket);
});

test("a saturated four-pilot world fits the initial reliable frame and datagram budget", () => {
  const s = new Simulation(1);
  for (let i = 0; i < 4; i++)
    s.join(
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      "Pilot Long Callsign",
    );
  s.wave = 20;
  s.enemies = [];
  for (let i = 0; i < 140; i++) s.step();
  assert.equal(s.enemies.length, 34);
  const owner = [...s.pilots.keys()][0];
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
  const packets = snapshotPackets(1, state);
  assert.ok(packets.length <= 128);
  assert.ok(packets.every((p) => p.length <= 1100));
});

test("each human adds four fighters to existing waves, including mid-wave joins", () => {
  const s = new Simulation(34);
  for (let i = 1; i <= 4; i++) {
    s.join(String(i), `Pilot ${i}`);
    assert.equal(s.enemies.length, 3 + i * 4);
    assert.equal(s.enemies.filter((e) => e.squadPilot === String(i)).length, 4);
  }
  s.leave("2");
  assert.equal(s.enemies.length, 15);
  for (let i = 0; i < 8; i++) {
    s.join(`new-${i}`, "Replacement");
    assert.equal(s.enemies.length, 19);
    s.leave(`new-${i}`);
    assert.equal(s.enemies.length, 15);
  }
  s.wave = 20;
  s.enemies = [];
  for (let i = 0; i < 140; i++) s.step();
  assert.equal(s.enemies.filter((e) => e.kind === "fighter").length, 20);
  assert.equal(s.enemies.filter((e) => e.kind === "interceptor").length, 6);
  assert.equal(s.enemies.filter((e) => e.kind === "bomber").length, 4);
});
