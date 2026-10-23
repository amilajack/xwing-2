import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { X509Certificate, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.GAME_URL ?? "http://127.0.0.1:3217";
const api = "http://127.0.0.1:8188",
  transport = "https://127.0.0.1:4448/game";
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    DATABASE_URL: "",
    MIGRATION_DATABASE_URL: "",
    ALLOWED_ORIGINS: origin,
    API_HOST: "127.0.0.1",
    API_PORT: "8188",
    QUIC_HOST: "127.0.0.1",
    QUIC_PORT: "4448",
    TRANSPORT_URL: transport,
    TEST_MODE: "1",
    TEST_SECRET: "protocol-regression",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (c) => (logs = (logs + c).slice(-20000)));
server.stderr.on("data", (c) => (logs = (logs + c).slice(-20000)));
const browser = await chromium.launch({ headless: false, channel: "chrome" });
await mkdir("outputs/coop-protocol", { recursive: true });
const hash = [
  ...createHash("sha256")
    .update(new X509Certificate(await readFile("work/tls/cert.pem")).raw)
    .digest(),
];
const request = async (body) => {
  const r = await fetch(`${api}/admission`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
};
const inspect = () =>
  fetch(`${api}/__test`, {
    method: "POST",
    headers: {
      Authorization: "Bearer protocol-regression",
      "Content-Type": "application/json",
    },
    body: '{"action":"inspect"}',
  }).then((r) => r.json());
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.route("**/__protocol", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Protocol regression</title>",
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/__protocol`);
  const connect = async (id, ticket, protocol = 1) =>
    page.evaluate(
      async ({ id, ticket, protocol, transport, hash }) => {
        const wt = new WebTransport(transport, {
          serverCertificateHashes: [
            { algorithm: "sha-256", value: new Uint8Array(hash).buffer },
          ],
        });
        await wt.ready;
        const stream = await wt.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        const closed = { done: false, reason: "" };
        void wt.closed.then(
          (v) => {
            closed.done = true;
            closed.reason = v.reason;
          },
          () => (closed.done = true),
        );
        window.sessions ??= {};
        window.sessions[id] = {
          wt,
          writer,
          reader,
          closed,
          datagrams: wt.datagrams.writable.getWriter(),
        };
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({ type: "join", protocol, ticket }) + "\n",
          ),
        );
      },
      { id, ticket, protocol, transport, hash },
    );
  const closed = (id) =>
    page.waitForFunction((id) => window.sessions[id].closed.done, id, {
      timeout: 15000,
    });
  await connect("invalid", "not-a-ticket");
  await closed("invalid");
  const a = await request({ action: "quick", callsign: "Secure Pilot" });
  assert.equal(a.status, 200);
  await connect("valid", a.ticket);
  const welcome = await page.evaluate(async () =>
    new TextDecoder().decode((await window.sessions.valid.reader.read()).value),
  );
  assert.match(welcome, /welcome/);
  await connect("replay-ticket", a.ticket);
  await closed("replay-ticket");
  await connect("version", "bad", 999);
  await closed("version");
  const input = {
    seq: 1,
    x: 0,
    y: 0,
    fire: false,
    boost: false,
    brake: false,
    sideways: false,
    maneuver: null,
    direction: 1,
  };
  for (const v of [input, { ...input, x: 1 }, { ...input, seq: 1000, x: 1 }])
    await page.evaluate(
      (v) =>
        window.sessions.valid.datagrams.write(
          new TextEncoder().encode(JSON.stringify({ protocol: 1, input: v })),
        ),
      v,
    );
  await new Promise((r) => setTimeout(r, 300));
  const before = await inspect();
  assert.equal(before.pilots[0].ack, 1);
  assert.deepEqual(before.pilots[0].flight.q, [0, 0, 0, 1]);
  await page.evaluate(() =>
    window.sessions.valid.datagrams
      .write(
        new TextEncoder().encode(
          '{"protocol":1,"input":{"seq":2,"x":"invalid"}}',
        ),
      )
      .catch(() => {}),
  );
  await closed("valid");
  const disconnected = await inspect();
  assert.equal(disconnected.pilots[0].connected, false);
  const reconnect = await request({
    action: "reconnect",
    callsign: "Secure Pilot",
    reconnect: a.reconnect,
  });
  await connect("reconnect", reconnect.ticket);
  await page.evaluate(() => window.sessions.reconnect.reader.read());
  const messages = page.evaluate(async () => {
    let result = "";
    while (true) {
      try {
        const r = await window.sessions.reconnect.reader.read();
        if (r.done) break;
        result += new TextDecoder().decode(r.value);
      } catch {
        break;
      }
    }
    return result;
  });
  const restored = await inspect();
  assert.equal(restored.pilots[0].id, before.pilots[0].id);
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const lifecycle = await messages;
  assert.match(lifecycle, /draining/);
  await exited;
  const forbidden = await fetch(`${api}/health`).then(
    () => false,
    () => true,
  );
  assert.equal(forbidden, true);
  await writeFile(
    "outputs/coop-protocol/report.json",
    JSON.stringify(
      {
        invalidTicket: true,
        singleUseTicket: true,
        wrongProtocol: true,
        replayedInputsIgnored: true,
        malformedInputClosed: true,
        reconnectIdentityPreserved:
          restored.pilots[0].id === before.pilots[0].id,
        drainDelivered: true,
        databaseUnavailableCombatContinued: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Real QUIC protocol regression passed: ticket/input rejection, reconnect, database outage and server draining",
  );
} finally {
  server.kill("SIGTERM");
  await browser.close();
  await writeFile("outputs/coop-protocol/server.log", logs);
}
