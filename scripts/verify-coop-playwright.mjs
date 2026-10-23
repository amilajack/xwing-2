import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.GAME_URL ?? "http://localhost:3100";
const api = process.env.COOP_API ?? "http://localhost:8081";
const out = "outputs/coop-playwright";
await mkdir(out, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADED !== "1",
  channel: process.env.PLAYWRIGHT_HEADED === "1" ? "chrome" : undefined,
  args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
const contexts = [];
const pages = [];
const state = (page) => page.evaluate(() => window.__gameTest.getState());
const waitConnected = (page) =>
  page.waitForFunction(
    () => window.__gameTest?.getState().multiplayer?.status === "connected",
    null,
    { timeout: 25000 },
  );
async function createPilot(name) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  contexts.push(context);
  if (!process.env.COOP_DEPLOYED) {
    const cert = new X509Certificate(await readFile("work/tls/cert.pem"));
    const hash = [...createHash("sha256").update(cert.raw).digest()];
    await context.addInitScript((hash) => {
      const Native = window.WebTransport;
      if (Native)
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
  }
  const page = await context.newPage();
  pages.push(page);
  page.setDefaultTimeout(180000);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/?qa=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__gameTest?.ready);
  await page.getByLabel("Callsign", { exact: true }).fill(name);
  await page.screenshot({ path: `${out}/${name}-before.png` });
  console.log(`${name}: menu ready, joining`);
  await page.getByRole("button", { name: "Quick Join", exact: true }).click();
  await waitConnected(page);
  return page;
}
async function control(action) {
  const r = await fetch(`${api}/__test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer local-coop-regression",
    },
    body: JSON.stringify({ action }),
  });
  assert.ok(r.ok);
  return r.json();
}
const report = {};
try {
  const a = await createPilot("Alpha");
  const b = await createPilot("Bravo");
  await a.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.pilots.length === 2,
  );
  let first = await state(a);
  assert.equal(
    first.multiplayer.state.seed,
    (await state(b)).multiplayer.state.seed,
  );
  report.initial = first.multiplayer;
  assert.equal(first.multiplayer.state.enemies.length, 11);
  const c = await createPilot("Charlie");
  const d = await createPilot("Delta");
  await a.waitForFunction(() => {
    const s = window.__gameTest.getState();
    return (
      s.multiplayer.state.enemies.length === 19 &&
      s.activeEnemies.fighter === 19
    );
  });
  report.fourPilotSquadrons = await state(a);
  await a.screenshot({ path: `${out}/four-pilot-squadrons.png` });
  await c.getByRole("button", { name: "Leave squad", exact: true }).click();
  await d.getByRole("button", { name: "Leave squad", exact: true }).click();
  await a.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.pilots.length === 2,
  );

  await a.mouse.move(1000, 350);
  await a.keyboard.down("ArrowRight");
  await a.waitForTimeout(500);
  await a.keyboard.up("ArrowRight");
  await a.mouse.move(720, 450);
  const alphaId = first.multiplayer.pilot;
  await b.waitForFunction(
    ({ id, p }) => {
      const f = window.__gameTest
        .getState()
        .multiplayer.state.pilots.find((x) => x.id === id).flight;
      return f.p.some((x, i) => Math.abs(x - p[i]) > 5);
    },
    {
      id: alphaId,
      p: first.multiplayer.state.pilots.find((x) => x.id === alphaId).flight.p,
    },
  );
  report.remoteMovement = await state(b);
  await a.screenshot({ path: `${out}/Alpha-after-movement.png` });
  await b.screenshot({ path: `${out}/Bravo-teammate.png` });
  if (!process.env.COOP_DEPLOYED) {
    await a.mouse.move(720, 450);
    await b.mouse.move(720, 450);
    await control("combat");
    await a.waitForTimeout(100);
    await a.keyboard.down("ControlLeft");
    await a.waitForTimeout(50);
    await a.keyboard.up("ControlLeft");
    await a.waitForFunction(
      () => {
        const s = window.__gameTest.getState().multiplayer.state;
        return s.enemies.length === 1 && s.enemies[0].health < 84;
      },
      null,
      { timeout: 5000 },
    );
    const damaged = (await state(a)).multiplayer.state;
    assert.ok(damaged.enemies[0].health > 0);
    report.sharedDamage = damaged;
    await b.keyboard.down("ControlLeft");
    await b.waitForFunction(
      () => window.__gameTest.getState().multiplayer.state.score > 0,
      null,
      { timeout: 5000 },
    );
    await b.keyboard.up("ControlLeft");
    await a.waitForFunction(
      () => window.__gameTest.getState().multiplayer.state.score > 0,
    );
    const scored = (await state(a)).multiplayer.state;
    assert.equal(scored.score, 110);
    assert.equal(
      scored.pilots.reduce((n, p) => n + p.kills, 0),
      1,
    );
    assert.equal(scored.pilots.find((p) => p.callsign === "Bravo").kills, 1);
    report.authoritativeKill = scored;
    await a.screenshot({ path: `${out}/Alpha-after-combat.png` });
    await b.screenshot({ path: `${out}/Bravo-after-combat.png` });
    await a.evaluate(() => {
      window.__respawnConnectionStates = [];
      window.__respawnMonitor = setInterval(
        () =>
          window.__respawnConnectionStates.push(
            window.__gameTest.getState().multiplayer.status,
          ),
        50,
      );
    });
    await control("destroy");
    await a.waitForFunction(
      () =>
        window.__gameTest
          .getState()
          .multiplayer.state.pilots.find((p) => p.callsign === "Alpha").hull ===
        0,
    );
    await a.screenshot({ path: `${out}/Alpha-respawning.png` });
    await a.waitForFunction(
      () =>
        window.__gameTest
          .getState()
          .multiplayer.state.pilots.find((p) => p.callsign === "Alpha").hull ===
        100,
      null,
      { timeout: 7000 },
    );
    report.respawn = await state(a);
    const connectionStates = await a.evaluate(() => {
      clearInterval(window.__respawnMonitor);
      return window.__respawnConnectionStates;
    });
    assert.ok(
      connectionStates.length >= 50,
      "observe the full respawn countdown",
    );
    assert.ok(
      connectionStates.every((status) => status === "connected"),
      "respawn must not trigger reconnection",
    );
    report.respawnConnectionStable = true;
  }
  const beforePause = (await state(a)).multiplayer.state.tick;
  await a.keyboard.press("Escape");
  await a.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await a.waitForTimeout(200);
  assert.ok((await state(a)).multiplayer.state.tick > beforePause);
  await a.getByRole("button", { name: "Resume", exact: true }).click();
  await a.evaluate(() => window.__gameTest.disconnect());
  await a.waitForTimeout(250);
  await waitConnected(a);
  const reconnected = await state(a);
  assert.equal(reconnected.multiplayer.pilot, alphaId);
  report.reconnect = reconnected;
  await a.screenshot({ path: `${out}/Alpha-reconnected.png` });
  await a.getByRole("button", { name: "Leave squad", exact: true }).click();
  await b.getByRole("button", { name: "Leave squad", exact: true }).click();
  assert.deepEqual(errors, []);
  report.consoleErrors = errors;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    "Co-op browser regression passed: real WebTransport, shared combat, movement, respawn, local pause and reconnect.",
  );
} catch (error) {
  report.consoleErrors = errors;
  await writeFile(
    `${out}/failure.json`,
    JSON.stringify(
      {
        error: String(error),
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
