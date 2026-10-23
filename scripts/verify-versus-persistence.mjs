import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { Persistence } from "../server/persistence";
import { Rooms } from "../server/rooms";
const url = process.env.VERSUS_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "Set VERSUS_TEST_DATABASE_URL to an isolated migrated test database.",
  );
const client = new PrismaClient({ datasourceUrl: url });
const persistence = new Persistence(client);
const room = new Rooms(persistence.enqueue);
const ids = [];
try {
  for (const callsign of ["Alpha", "Bravo"]) {
    const a = room.admission(
      { action: "quick", callsign, mode: "versus" },
      "https://test",
    );
    room.connect(room.consume(a.ticket, "https://test"));
  }
  room.step();
  const first = room.room.matchId;
  ids.push(first);
  const [a, b] = [...room.room.sim.pilots.values()];
  a.humanKills = room.room.sim.participants.get(a.id).humanKills = 9;
  b.protectedUntil = 0;
  room.room.sim.damagePilot(b, 250, a.id);
  room.step();
  await persistence.flush();
  const result = await client.match.findUniqueOrThrow({
    where: { id: first },
    include: { participants: true },
  });
  assert.equal(result.mode, "versus");
  assert.equal(result.status, "completed");
  assert.equal(result.winner, a.id);
  assert.equal(result.participants.find((p) => p.id === a.id).humanKills, 10);
  for (let i = 0; i < 600; i++) room.step();
  const second = room.room.matchId;
  ids.push(second);
  assert.notEqual(first, second);
  room.checkpoint();
  await persistence.flush();
  const next = await client.match.findUniqueOrThrow({
    where: { id: second },
    include: { participants: true },
  });
  assert.equal(next.participants.length, 2);
  assert.equal(next.participants.find((p) => p.id === a.id).humanKills, 0);
  assert.equal(
    (await client.match.findUniqueOrThrow({ where: { id: first } })).status,
    "completed",
  );
  room.drain();
  await persistence.flush();
  assert.equal(
    (await client.match.findUniqueOrThrow({ where: { id: second } })).status,
    "interrupted",
  );
  assert.equal(persistence.failures, 0);
  console.log(
    "PostgreSQL persistence passed: completed victory, independent rematch, repeated pilot IDs, interrupted result.",
  );
} finally {
  await persistence.flush();
  await client.match.deleteMany({ where: { id: { in: ids } } });
  await client.$disconnect();
}
