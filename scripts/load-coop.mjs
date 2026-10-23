import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { X509Certificate, createHash } from "node:crypto";
const base = process.env.GAME_URL ?? "http://127.0.0.1:3217";
const endpoint = process.env.COOP_API ?? "https://xwing-mp.amilajack.com";
const seconds = Number(process.env.LOAD_SECONDS ?? 1800);
const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const pages = [];
await mkdir("outputs/capacity", { recursive: true });
try {
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    pages.push(page);
    await page.route("**/__coop_load", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Co-op capacity client</title>",
      }),
    );
    if (process.env.LOCAL_TLS) {
      const hash = [
        ...createHash("sha256")
          .update(new X509Certificate(await readFile("work/tls/cert.pem")).raw)
          .digest(),
      ];
      await page.addInitScript((hash) => {
        const Native = window.WebTransport;
        if (Native)
          window.WebTransport = class extends Native {
            constructor(url, opts) {
              super(url, {
                ...opts,
                serverCertificateHashes: [
                  { algorithm: "sha-256", value: new Uint8Array(hash).buffer },
                ],
              });
            }
          };
      }, hash);
    }
    await page.goto(`${base}/__coop_load`);
    await page.evaluate(
      async ({ endpoint, i }) => {
        const res = await fetch(`${endpoint}/admission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "quick",
            callsign: `Load ${i + 1}`,
            squad: "Capacity Test",
          }),
        });
        const a = await res.json();
        if (!res.ok) throw Error(a.error);
        const wt = new WebTransport(a.transport);
        await wt.ready;
        const bidi = await wt.createBidirectionalStream();
        const writer = bidi.writable.getWriter();
        const enc = new TextEncoder();
        await writer.write(
          enc.encode(
            JSON.stringify({ type: "join", protocol: 2, ticket: a.ticket }) +
              "\n",
          ),
        );
        const reader = bidi.readable.getReader();
        await reader.read();
        void (async () => {
          while (!(await reader.read()).done) {
            /* Drain reliable events. */
          }
        })();
        const d = wt.datagrams.readable.getReader();
        const stats = (window.loadStats = {
          connected: true,
          packets: 0,
          bytes: 0,
          inputs: 0,
          errors: [],
          started: Date.now(),
          maxGapMs: 0,
          lastPacket: Date.now(),
          firstTick: null,
          firstTickAt: 0,
          lastTick: 0,
          lastTickAt: 0,
        });
        void (async () => {
          while (true) {
            const { value, done } = await d.read();
            if (done) break;
            const now = Date.now();
            stats.maxGapMs = Math.max(stats.maxGapMs, now - stats.lastPacket);
            stats.lastPacket = now;
            stats.packets++;
            stats.bytes += value.length;
            if (value.length >= 12) {
              const tick = new DataView(
                value.buffer,
                value.byteOffset,
                value.byteLength,
              ).getUint32(4);
              if (stats.firstTick === null) {
                stats.firstTick = tick;
                stats.firstTickAt = now;
              }
              if (tick > stats.lastTick) {
                stats.lastTick = tick;
                stats.lastTickAt = now;
              }
            }
          }
        })().catch((e) => stats.errors.push(String(e)));
        const dw = wt.datagrams.writable.getWriter();
        let seq = 0,
          busy = false;
        const timer = setInterval(() => {
          if (busy) return;
          busy = true;
          seq++;
          const t = seq / 30;
          const input = {
            seq,
            x: Math.sin(t * 0.31 + i) * 0.5,
            y: Math.cos(t * 0.23 + i) * 0.3,
            fire: true,
            boost: Math.floor(t) % 20 < 5,
            brake: false,
            sideways: false,
            maneuver: seq % 300 === 0 ? "barrelRoll" : null,
            direction: i % 2 ? -1 : 1,
          };
          void dw
            .write(enc.encode(JSON.stringify({ protocol: 2, input })))
            .then(() => stats.inputs++)
            .catch((e) => stats.errors.push(String(e)))
            .finally(() => (busy = false));
        }, 1000 / 30);
        void wt.closed.then(
          () => (stats.connected = false),
          () => (stats.connected = false),
        );
        window.stopLoad = async () => {
          clearInterval(timer);
          await writer.write(enc.encode('{"type":"leave"}\n'));
          wt.close();
        };
      },
      { endpoint, i },
    );
    console.log(`Connected capacity pilot ${i + 1}/4`);
  }
  const full = await fetch(`${endpoint}/admission`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(base).origin,
    },
    body: JSON.stringify({ action: "quick", callsign: "Fifth Pilot" }),
  });
  assert.equal(
    full.status,
    409,
    "fifth pilot must receive a full-squad response",
  );
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    await new Promise((r) =>
      setTimeout(r, Math.min(30000, seconds * 1000 - (Date.now() - start))),
    );
    const stats = await Promise.all(
      pages.map((p) => p.evaluate(() => window.loadStats)),
    );
    await writeFile(
      "outputs/capacity/clients.json",
      JSON.stringify({ seconds: (Date.now() - start) / 1000, stats }, null, 2),
    );
    for (const s of stats) {
      assert.equal(s.connected, true);
      assert.equal(s.errors.length, 0);
    }
    console.log(
      `Capacity clients healthy: ${Math.round((Date.now() - start) / 1000)}/${seconds}s`,
    );
  }
  const final = await Promise.all(
    pages.map((p) => p.evaluate(() => window.loadStats)),
  );
  for (const stats of final) {
    const hz =
      (stats.lastTick - stats.firstTick) /
      ((stats.lastTickAt - stats.firstTickAt) / 1000);
    assert.ok(
      hz >= 58.5,
      `authoritative simulation fell behind: ${hz.toFixed(2)} Hz`,
    );
  }
  for (const p of pages) await p.evaluate(() => window.stopLoad());
  console.log("Four-pilot capacity transport test passed");
} finally {
  await browser.close();
}
