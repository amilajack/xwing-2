import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Quaternion, Vector3 } from "three";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.GAME_URL ?? "http://127.0.0.1:3217";
const endpoint = process.env.COOP_API ?? "https://xwing-mp.amilajack.com";
const out = "outputs/coop-live";
await mkdir(out, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADED !== "1",
  channel: process.env.PLAYWRIGHT_HEADED === "1" ? "chrome" : undefined,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const pages = [];
const state = (p) => p.evaluate(() => window.__gameTest.getState().multiplayer);
const wrap = (x) => ((((x + 700) % 1400) + 1400) % 1400) - 700;
try {
  for (const name of ["Live Alpha", "Live Bravo"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.route("**/admission", async (route) => {
      const response = await route.fetch({ url: `${endpoint}/admission` });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(180000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`${base}/?qa=1`);
    await page.waitForFunction(() => window.__gameTest?.ready);
    await page.getByLabel("Callsign", { exact: true }).fill(name);
    await page.screenshot({ path: `${out}/${pages.length}-before.png` });
    await page.getByRole("button", { name: "Quick Join", exact: true }).click();
    await page.waitForFunction(
      () => window.__gameTest.getState().multiplayer?.status === "connected",
      null,
      { timeout: 20000 },
    );
    console.log(`${name} connected through trusted TLS and QUIC`);
  }
  const start = Date.now();
  let last = await state(pages[0]);
  const initialScore = last.state.score;
  let targetId = last.state.enemies[0]?.id;
  const records = [];
  while (Date.now() - start < 90000) {
    const views = await Promise.all(pages.map(state));
    last = views[0];
    assert.ok(views.every((v) => v.status === "connected"));
    if (last.state.score > initialScore) {
      records.push({ type: "kill", state: last.state });
      break;
    }
    if (!last.state.enemies.some((e) => e.id === targetId))
      targetId = last.state.enemies[0]?.id;
    for (let i = 0; i < pages.length; i++) {
      const view = views[i],
        p = view.state.pilots.find((p) => p.id === view.pilot),
        e = view.state.enemies.find((e) => e.id === targetId);
      if (!e || p.hull <= 0) {
        await pages[i].keyboard.up("ControlLeft");
        continue;
      }
      const point = new Vector3().fromArray(e.p);
      const origin = new Vector3().fromArray(p.flight.p);
      const distance = new Vector3(
        wrap(point.x - origin.x),
        wrap(point.y - origin.y),
        wrap(point.z - origin.z),
      ).length();
      point.addScaledVector(
        new Vector3(0, 0, -1).applyQuaternion(new Quaternion().fromArray(e.q)),
        (e.speed * distance) / (285 + p.flight.n[2] * 2),
      );
      const local = new Vector3(
        wrap(point.x - origin.x),
        wrap(point.y - origin.y),
        wrap(point.z - origin.z),
      ).applyQuaternion(new Quaternion().fromArray(p.flight.q).invert());
      const clamp = (x) => Math.max(-1, Math.min(1, x));
      const x = clamp(Math.atan2(local.x, -local.z) * 1.35),
        y = clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)) * 1.6);
      await pages[i].mouse.move(720 + (x * 1440) / 2.3, 450 + (y * 900) / 2.3);
      await pages[i].keyboard.down("ControlLeft");
      records.push({
        type: "aim",
        pilot: p.id,
        enemy: e.id,
        health: e.health,
        tick: view.state.tick,
        ack: p.ack,
      });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  for (const p of pages) await p.keyboard.up("ControlLeft");
  assert.ok(
    last.state.score > initialScore,
    "pilots did not destroy an enemy within the live combat window",
  );
  assert.ok(last.state.pilots.reduce((n, p) => n + p.kills, 0) >= 1);
  assert.deepEqual(errors, []);
  for (let i = 0; i < pages.length; i++)
    await pages[i].screenshot({ path: `${out}/${i + 1}-after-combat.png` });
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      { endpoint, errors, initialScore, final: last, records },
      null,
      2,
    ),
  );
  console.log(
    `Live combat passed: score ${initialScore} → ${last.state.score}, ${last.state.pilots.reduce((n, p) => n + p.kills, 0)} authoritative kill(s)`,
  );
} finally {
  for (const p of pages)
    await p
      .getByRole("button", { name: "Leave squad", exact: true })
      .click()
      .catch(() => {});
  await browser.close();
}
