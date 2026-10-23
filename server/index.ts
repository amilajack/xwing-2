import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Http3Server } from "@fails-components/webtransport";
import { Rooms, AdmissionError, type Room, type Slot } from "./rooms";
import { Persistence } from "./persistence";
import {
  decode,
  MAX_DATAGRAM,
  MessageFramer,
  PROTOCOL_VERSION,
  reliableMessage,
  snapshotPackets,
  validControls,
} from "../shared/protocol";

const origins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
);
const cert = readFileSync(process.env.TLS_CERT ?? "work/tls/cert.pem", "utf8");
const key = readFileSync(process.env.TLS_KEY ?? "work/tls/key.pem", "utf8");
const persistence = new Persistence();
const rooms = new Rooms(persistence.enqueue);
const quic = new Http3Server({
  host: process.env.QUIC_HOST ?? "0.0.0.0",
  port: Number(process.env.QUIC_PORT ?? 4433),
  cert,
  privKey: key,
  secret: randomBytes(32).toString("hex"),
  defaultDatagramsReadableMode: "bytes",
  maxConnections: 12,
});
quic.setRequestCallback(
  async ({ header }: { header: Record<string, string> }) => ({
    status:
      origins.has(header.origin) &&
      header[":path"] === "/game" &&
      !rooms.draining
        ? 200
        : 403,
    path: "/game",
  }),
);
const sessions = quic.sessionStream("/game").getReader();
type Session = Awaited<ReturnType<typeof sessions.read>>["value"];
type Peer = {
  session: NonNullable<Session>;
  room: Room;
  slot: Slot;
  generation: number;
  send: (message: unknown) => void;
  datagrams: WritableStreamDefaultWriter<Uint8Array>;
  sending: boolean;
  lastInput: number;
  lost: number;
  received: number;
};
const peers = new Set<Peer>();
let pending = 0;
let interruptions = 0;
let snapshotDrops = 0;

async function accept(session: NonNullable<Session>) {
  if (++pending > 8) {
    pending--;
    session.close();
    return;
  }
  let peer: Peer | undefined;
  let explicitLeave = false;
  let joined = false;
  const timeout = setTimeout(
    () => session.close({ closeCode: 1, reason: "Join timed out" }),
    5000,
  );
  try {
    const incoming = session.incomingBidirectionalStreams.getReader();
    const result = await incoming.read();
    if (!result.value) throw new Error("No join stream");
    const stream = result.value;
    const writer = stream.writable.getWriter();
    // No unbounded stream creation or reliable output queues.
    void incoming
      .read()
      .then(() => {
        session.close({
          closeCode: 1,
          reason: "Only one control stream allowed",
        });
      })
      .catch(() => {});
    void session.incomingUnidirectionalStreams
      .getReader()
      .read()
      .then((result) => {
        if (!result.done)
          session.close({
            closeCode: 1,
            reason: "Unidirectional streams not allowed",
          });
      })
      .catch(() => {});
    let queued = 0;
    let chain = Promise.resolve();
    const send = (message: unknown) => {
      if (++queued > 64) {
        session.close({ closeCode: 1, reason: "Slow reliable consumer" });
        return;
      }
      const bytes = reliableMessage(message);
      chain = chain
        .then(() => writer.write(bytes))
        .then(() => {
          queued--;
        })
        .catch(() => {
          session.close();
        });
    };
    const reader = stream.readable.getReader();
    const framer = new MessageFramer();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const raw of framer.push(value)) {
        const message = raw as {
          type?: string;
          protocol?: number;
          ticket?: string;
        };
        if (!joined) {
          if (message.type !== "join" || message.protocol !== PROTOCOL_VERSION)
            throw new Error("Protocol mismatch");
          const origin = (
            session as unknown as { header: Record<string, string> }
          ).header.origin;
          const ticket = rooms.consume(message.ticket, origin);
          const generation = rooms.connect(ticket);
          peer = {
            session,
            room: ticket.room,
            slot: ticket.slot,
            generation,
            send,
            datagrams: (
              session.datagrams as unknown as {
                writable: WritableStream<Uint8Array>;
              }
            ).writable.getWriter(),
            sending: false,
            lastInput: 0,
            lost: 0,
            received: 0,
          };
          peers.add(peer);
          joined = true;
          clearTimeout(timeout);
          send({
            type: "welcome",
            protocol: PROTOCOL_VERSION,
            pilot: peer.slot.id,
            squad: peer.room.squad,
            invite: peer.room.invite,
            state: peer.room.sim.snapshot(),
          });
          void readInputs(peer);
          rooms.checkpoint();
        } else if (message.type === "leave") {
          explicitLeave = true;
          session.close();
          return;
        } else throw new Error("Unexpected lifecycle message");
      }
    }
  } catch {
    session.close({ closeCode: 1, reason: "Invalid session" });
  } finally {
    clearTimeout(timeout);
    pending--;
    if (peer) {
      peers.delete(peer);
      rooms.disconnect(peer.room, peer.slot, peer.generation, explicitLeave);
    }
  }
}
async function readInputs(peer: Peer) {
  const reader = peer.session.datagrams.readable.getReader();
  let bucket = 0;
  let second = Date.now();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (Date.now() - second >= 1000) {
        second = Date.now();
        bucket = 0;
      }
      if (++bucket > 90 || value.byteLength > MAX_DATAGRAM)
        throw new Error("Input rate exceeded");
      const message = decode(value, MAX_DATAGRAM) as {
        protocol?: number;
        input?: unknown;
      };
      if (
        message.protocol !== PROTOCOL_VERSION ||
        !validControls(message.input)
      )
        throw new Error("Invalid input");
      if (peer.room.sim.setInput(peer.slot.id, message.input)) {
        peer.lost += Math.max(0, message.input.seq - peer.lastInput - 1);
        peer.lastInput = message.input.seq;
        peer.received++;
      }
    }
  } catch {
    peer.session.close({ closeCode: 1, reason: "Invalid datagram" });
  }
}
void (async () => {
  while (true) {
    const { value, done } = await sessions.read();
    if (done) break;
    if (value) void accept(value);
  }
})().catch((error) => {
  console.error("session_listener_failed", String(error));
  void drain();
});
quic.startServer();
await quic.ready;
const apiHandler: import("node:http").RequestListener = async (req, res) => {
  const origin = req.headers.origin ?? "";
  if (origins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  const reply = (status: number, body: unknown) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health" && req.method === "GET")
    return reply(rooms.draining ? 503 : 200, {
      ready: !rooms.draining,
      protocol: PROTOCOL_VERSION,
      pilots: peers.size,
    });
  if (
    process.env.TEST_MODE === "1" &&
    process.env.API_HOST === "127.0.0.1" &&
    process.env.QUIC_HOST === "127.0.0.1" &&
    process.env.TEST_SECRET &&
    req.headers.authorization === `Bearer ${process.env.TEST_SECRET}` &&
    req.url === "/__test" &&
    req.method === "POST"
  ) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) return reply(413, {});
    }
    const action = JSON.parse(body).action;
    const sim = rooms.room?.sim;
    if (!sim) return reply(404, {});
    if (action === "combat") {
      const e = sim.enemies[0];
      sim.enemies = e ? [e] : [];
      sim.bolts = [];
      let i = 0;
      for (const p of sim.pilots.values()) {
        p.flight.player.position.set(i++ * 2, 0, 0);
        p.flight.player.quaternion.identity();
        p.flight.mouseXPercent = p.flight.mouseYPercent = 0;
        p.flight.angularVelocity.set(0, 0, 0);
        p.shields = p.hull = 100;
      }
      if (e) {
        e.p.set(0, 0, -160);
        e.health = 84;
        e.speed = 0;
        e.fireAt = Infinity;
      }
    } else if (action === "destroy") {
      const p = [...sim.pilots.values()][0];
      if (p) sim.damagePilot(p, 200);
    }
    return reply(200, sim.snapshot());
  }
  if (!origins.has(origin))
    return reply(403, { error: "Browser origin not allowed" });
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url !== "/admission" || req.method !== "POST")
    return reply(404, { error: "Unknown endpoint" });
  try {
    const ip =
      process.env.TRUST_PROXY === "1"
        ? String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress)
            .split(",")
            .at(-1)!
            .trim()
        : req.socket.remoteAddress;
    rooms.rateLimit(ip ?? "unknown");
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new AdmissionError(415, "Expected JSON");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 2048)
        throw new AdmissionError(413, "Request too large");
    }
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AdmissionError(400, "Invalid request");
    reply(200, {
      ...rooms.admission(value, origin),
      transport: process.env.TRANSPORT_URL ?? "https://localhost:4433/game",
    });
  } catch (error) {
    reply(error instanceof AdmissionError ? error.status : 400, {
      error:
        error instanceof AdmissionError ? error.message : "Invalid request",
    });
  }
};
const api =
  process.env.API_TLS === "1"
    ? httpsServer({ cert, key }, apiHandler)
    : httpServer(apiHandler);
api.requestTimeout = 5000;
api.headersTimeout = 5000;
api.maxConnections = 32;
api.listen(
  Number(process.env.API_PORT ?? 8080),
  process.env.API_HOST ?? "127.0.0.1",
);
let nextTick = performance.now();
let tickTimes: number[] = [];
let tickCount = 0;
const timer = setInterval(() => {
  const now = performance.now();
  let steps = 0;
  while (now >= nextTick && steps++ < 5) {
    const start = performance.now();
    rooms.room?.sim.step();
    tickTimes.push(performance.now() - start);
    tickCount++;
    nextTick += 1000 / 60;
    if (tickCount % 3 === 0 && rooms.room) {
      const room = rooms.room;
      const snapshot = room.sim.snapshot();
      const batches = new Map<number, Uint8Array[]>();
      for (const peer of peers) {
        if (peer.room !== room || peer.sending) {
          snapshotDrops++;
          continue;
        }
        const size = Math.min(
          MAX_DATAGRAM,
          peer.session.datagrams.maxDatagramSize,
        );
        let packets = batches.get(size);
        if (!packets) {
          packets = snapshotPackets(snapshot.tick, snapshot, size);
          batches.set(size, packets);
        }
        peer.sending = true;
        void (async () => {
          for (const packet of packets) await peer.datagrams.write(packet);
        })()
          .catch(() => peer.session.close())
          .finally(() => {
            peer.sending = false;
          });
      }
    }
    if (rooms.room) {
      const events = rooms.room.sim.events.splice(0);
      if (events.length)
        for (const peer of peers) peer.send({ type: "events", events });
    }
  }
  if (steps >= 5) nextTick = now + 1000 / 60;
}, 4);
const maintenance = setInterval(() => rooms.sweep(), 1000);
const metrics = setInterval(() => {
  rooms.checkpoint();
  tickTimes.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      type: "metrics",
      tickP95Ms: tickTimes[Math.floor(tickTimes.length * 0.95)] ?? 0,
      rss: process.memoryUsage().rss,
      connections: peers.size,
      inputsLost: [...peers].reduce((n, p) => n + p.lost, 0),
      inputsReceived: [...peers].reduce((n, p) => n + p.received, 0),
      snapshotDrops,
      persistenceFailures: persistence.failures,
      persistenceDropped: persistence.dropped,
      interruptions,
    }),
  );
  tickTimes = [];
}, 10000);
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  interruptions++;
  rooms.drain();
  for (const p of peers)
    p.send({
      type: "draining",
      reason:
        "Spot instance restarting. This match has ended; reconnect shortly for a new sortie.",
    });
  await persistence.flush(10000);
  for (const p of peers)
    p.session.close({ closeCode: 2, reason: "Server restarting" });
  clearInterval(timer);
  clearInterval(maintenance);
  clearInterval(metrics);
  clearInterval(spot);
  api.close();
  quic.stopServer();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => {
  void drain();
});
process.on("SIGINT", () => {
  void drain();
});
const spot = setInterval(() => {
  if (process.env.EC2_METADATA !== "1") return;
  void (async () => {
    const token = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.text());
    const r = await fetch(
      "http://169.254.169.254/latest/meta-data/spot/instance-action",
      {
        headers: { "X-aws-ec2-metadata-token": token },
        signal: AbortSignal.timeout(1000),
      },
    );
    if (r.ok) {
      console.log(JSON.stringify({ type: "spot_interruption" }));
      await drain();
    }
  })().catch(() => {});
}, 5000);
console.log(
  JSON.stringify({
    type: "ready",
    quic: quic.address(),
    apiPort: process.env.API_PORT ?? 8080,
  }),
);
