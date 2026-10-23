import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
const base = process.env.GAME_URL ?? "http://127.0.0.1:3217";
const api = process.env.COOP_API ?? "http://127.0.0.1:8187";
const out = "outputs/versus-playwright";
await mkdir(out, { recursive: true });
const errors = [],
  pages = [],
  report = {};
const hash = [
  ...createHash("sha256")
    .update(new X509Certificate(await readFile("work/tls/cert.pem")).raw)
    .digest(),
];
const browser = await chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADED !== "1",
  channel: process.env.PLAYWRIGHT_HEADED === "1" ? "chrome" : undefined,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const state = (p) => p.evaluate(() => window.__gameTest.getState().multiplayer);
const waitConnected = (p) =>
  p.waitForFunction(
    () => window.__gameTest?.getState().multiplayer?.status === "connected",
    null,
    { timeout: 25000 },
  );
async function pilot(name, action = "quick", invite) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript((hash) => {
    const Native = window.WebTransport;
    window.WebTransport = class extends Native {
      constructor(url, options) {
        super(url, {
          ...options,
          serverCertificateHashes: [
            { algorithm: "sha-256", value: new Uint8Array(hash).buffer },
          ],
        });
      }
    };
  }, hash);
  const page = await context.newPage();
  pages.push(page);
  page.setDefaultTimeout(30000);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/?qa=1${invite ? `&room=${invite}` : ""}`);
  await page.waitForFunction(() => window.__gameTest?.ready);
  await page.getByLabel("Callsign", { exact: true }).fill(name);
  if (!invite) await page.getByLabel("Match mode").selectOption("versus");
  await page.screenshot({ path: `${out}/${name}-before.png` });
  await page
    .getByRole("button", {
      name: invite
        ? "Join invited squad"
        : action === "private"
          ? "Create private room"
          : "Quick Join",
      exact: true,
    })
    .click();
  await waitConnected(page);
  console.log(`${name}: connected`);
  return page;
}
async function control(action) {
  const response = await fetch(`${api}/__test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer local-coop-regression",
    },
    body: JSON.stringify({ action }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function leave(page) {
  await page.getByRole("button", { name: "Leave squad", exact: true }).click();
}
try {
  const a = await pilot("Versus Alpha");
  report.waiting = await state(a);
  assert.equal(report.waiting.state.phase, "waiting");
  await a.screenshot({ path: `${out}/waiting.png` });
  const wrongMode = await fetch(`${api}/admission`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "quick",
      callsign: "Coop Pilot",
      mode: "coop",
    }),
  });
  assert.equal(wrongMode.status, 409);
  const b = await pilot("Versus Bravo");
  await a.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.phase === "active",
  );
  const initial = await state(a),
    aId = initial.pilot,
    bId = (await state(b)).pilot;
  assert.equal(initial.state.enemies.length, 11);
  await a.mouse.move(1000, 400);
  await a.keyboard.down("ArrowRight");
  await a.waitForTimeout(350);
  await a.keyboard.up("ArrowRight");
  await a.mouse.move(720, 450);
  await b.mouse.move(720, 450);
  await b.waitForFunction(
    ({ id, before }) =>
      window.__gameTest
        .getState()
        .multiplayer.state.pilots.find((p) => p.id === id)
        .flight.p.some((v, i) => Math.abs(v - before[i]) > 5),
    {
      id: aId,
      before: initial.state.pilots.find((p) => p.id === aId).flight.p,
    },
  );
  await a.screenshot({ path: `${out}/after-movement.png` });
  await control("versus-combat");
  await a.waitForTimeout(150);
  await a.keyboard.down("ControlLeft");
  await a.waitForTimeout(50);
  await a.keyboard.up("ControlLeft");
  await b.waitForFunction((id) => {
    const p = window.__gameTest
      .getState()
      .multiplayer.state.pilots.find((p) => p.id === id);
    return p.hull > 0 && p.hull < 84;
  }, bId);
  report.playerDamage = await state(b);
  await b.screenshot({ path: `${out}/opponent-damaged.png` });
  await a.keyboard.down("ControlLeft");
  await b.waitForFunction(
    (id) =>
      window.__gameTest
        .getState()
        .multiplayer.state.pilots.find((p) => p.id === id).hull === 0,
    bId,
  );
  await a.keyboard.up("ControlLeft");
  await a.waitForFunction(
    (id) =>
      window.__gameTest
        .getState()
        .multiplayer.state.pilots.find((p) => p.id === id).humanKills === 1,
    aId,
  );
  report.firstKill = await state(a);
  assert.equal(
    report.firstKill.state.pilots.find((p) => p.id === aId).kills,
    0,
  );
  await b.screenshot({ path: `${out}/respawning.png` });
  await b.waitForFunction(
    (id) =>
      window.__gameTest
        .getState()
        .multiplayer.state.pilots.find((p) => p.id === id).hull > 0,
    bId,
    { timeout: 8000 },
  );
  report.respawn = await state(b);
  assert.ok(
    report.respawn.state.pilots.find((p) => p.id === bId).protectedUntil >
      report.respawn.state.tick,
  );
  await b.screenshot({ path: `${out}/respawned-shield.png` });
  await a.evaluate(() => window.__gameTest.disconnect());
  await a.waitForTimeout(1000);
  await waitConnected(a);
  report.reconnect = await state(a);
  assert.equal(report.reconnect.pilot, aId);
  assert.equal(
    report.reconnect.state.pilots.find((p) => p.id === aId).humanKills,
    1,
  );
  assert.equal(report.reconnect.state.enemies.length, 11);
  await control("versus-final");
  await a.waitForTimeout(150);
  await a.keyboard.down("ControlLeft");
  await a.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.phase === "results",
  );
  await a.keyboard.up("ControlLeft");
  report.victory = await state(a);
  assert.equal(report.victory.state.winner, aId);
  assert.equal(
    report.victory.state.pilots.find((p) => p.id === aId).humanKills,
    10,
  );
  await b.getByText(/Versus Alpha wins!/).waitFor();
  await a.screenshot({ path: `${out}/victory.png` });
  if (process.env.VERSUS_TEST_DATABASE_URL) {
    const db = new PrismaClient({
      datasourceUrl: process.env.VERSUS_TEST_DATABASE_URL,
    });
    try {
      let match;
      for (let i = 0; i < 30; i++) {
        match = await db.match.findFirst({
          where: { winner: aId, mode: "versus", status: "completed" },
          include: { participants: true },
        });
        if (match) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(match);
      assert.equal(match.participants.find((p) => p.id === aId).humanKills, 10);
      report.persistedVictory = {
        id: match.id,
        status: match.status,
        winner: match.winner,
      };
    } finally {
      await db.$disconnect();
    }
  }
  await a.waitForFunction(
    (round) => {
      const s = window.__gameTest.getState().multiplayer.state;
      return s.round === round + 1 && s.phase === "active";
    },
    report.victory.state.round,
    { timeout: 14000 },
  );
  report.rematch = await state(a);
  assert.ok(report.rematch.state.tick > report.victory.state.tick);
  assert.ok(
    report.rematch.state.pilots.every(
      (p) => p.humanKills === 0 && p.kills === 0 && p.deaths === 0,
    ),
  );
  assert.equal(report.rematch.state.enemies.length, 11);
  await a.screenshot({ path: `${out}/rematch.png` });
  await a.keyboard.down("ArrowLeft");
  await a.waitForTimeout(300);
  await a.keyboard.up("ArrowLeft");
  assert.equal((await state(a)).status, "connected");
  await leave(a);
  await leave(b);
  for (
    let i = 0;
    i < 40 && (await (await fetch(`${api}/health`)).json()).pilots !== 0;
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  const host = await pilot("Private Host", "private");
  const invite = (await state(host)).invite;
  assert.ok(invite);
  await host.getByRole("button", { name: "Copy invite", exact: true }).click();
  const link = await host.evaluate(() => navigator.clipboard.readText());
  assert.equal(new URL(link).searchParams.get("room"), invite);
  const guest = await pilot("Private Guest", "invite", invite);
  await guest.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.phase === "active",
  );
  assert.equal((await state(guest)).state.mode, "versus");
  report.privateInvite = true;
  await guest.screenshot({ path: `${out}/private-versus.png` });
  await leave(host);
  await leave(guest);
  report.consoleErrors = errors;
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    "Versus browser regression passed: real QUIC player damage, kill, respawn, reconnect, victory, persisted result, rematch and private invite.",
  );
} catch (error) {
  await writeFile(
    `${out}/failure.json`,
    JSON.stringify(
      {
        error: String(error),
        errors,
        report,
        states: await Promise.all(pages.map((p) => state(p).catch(() => null))),
      },
      null,
      2,
    ),
  );
  for (let i = 0; i < pages.length; i++)
    await pages[i]
      .screenshot({ path: `${out}/failure-${i}.png` })
      .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
