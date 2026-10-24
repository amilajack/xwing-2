import assert from "node:assert/strict";
import { chromium } from "playwright";
import { X509Certificate, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = process.env.GAME_URL ?? "http://127.0.0.1:3217",
  api = process.env.COOP_API ?? "http://127.0.0.1:8187";
const hash = [
  ...createHash("sha256")
    .update(new X509Certificate(await readFile("work/tls/cert.pem")).raw)
    .digest(),
];
const out = "outputs/coop-lobby";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADED !== "1",
  channel: process.env.PLAYWRIGHT_HEADED === "1" ? "chrome" : undefined,
});
const errors = [];
const admission = (body) =>
  fetch(`${api}/admission`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(base).origin,
    },
    body: JSON.stringify(body),
  });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
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
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${base}/?qa=1`);
  await page.waitForFunction(() => window.__gameTest?.ready);
  await page.getByLabel("Callsign", { exact: true }).fill("Private One");
  await page.getByLabel("Squad name", { exact: true }).fill("Wraith Squadron");
  await page.screenshot({ path: `${out}/before-create.png` });
  await page
    .getByRole("button", { name: "Create private room", exact: true })
    .click();
  await page.waitForFunction(
    () => window.__gameTest.getState().multiplayer?.status === "connected",
  );
  const view = await page.evaluate(
    () => window.__gameTest.getState().multiplayer,
  );
  assert.equal(view.squad, "Wraith Squadron");
  assert.ok(view.invite.length >= 40);
  await page.getByRole("button", { name: "Copy invite", exact: true }).click();
  await page
    .getByRole("button", { name: "Invite copied", exact: true })
    .waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(new URL(copied).searchParams.get("room"), view.invite);
  assert.equal(
    (await admission({ action: "quick", callsign: "Intruder" })).status,
    409,
  );
  assert.equal(
    (await admission({ action: "invite", invite: "bad", callsign: "Intruder" }))
      .status,
    404,
  );
  const otherContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await otherContext.addInitScript((hash) => {
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
  const other = await otherContext.newPage();
  other.setDefaultTimeout(180000);
  await other.goto(copied + "&qa=1");
  await other.waitForFunction(() => window.__gameTest?.ready);
  await other.getByLabel("Callsign", { exact: true }).fill("Private Two");
  await other
    .getByRole("button", { name: "Join invited squad", exact: true })
    .click();
  await other.waitForFunction(
    () => window.__gameTest.getState().multiplayer?.status === "connected",
  );
  await page.waitForFunction(
    () => window.__gameTest.getState().multiplayer.state.pilots.length === 2,
  );
  await page.screenshot({ path: `${out}/after-invite.png` });
  const third = await admission({
    action: "invite",
    invite: view.invite,
    callsign: "Reserved Three",
  });
  const fourth = await admission({
    action: "invite",
    invite: view.invite,
    callsign: "Reserved Four",
  });
  assert.equal(third.status, 200);
  assert.equal(fourth.status, 200);
  assert.equal(
    (
      await admission({
        action: "invite",
        invite: view.invite,
        callsign: "Fifth",
      })
    ).status,
    409,
  );
  await other.getByRole("button", { name: "Leave squad", exact: true }).click();
  await page.getByRole("button", { name: "Leave squad", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(window, "WebTransport", {
      value: undefined,
      configurable: true,
    });
  });
  await page.getByRole("button", { name: "Quick Join", exact: true }).click();
  await page.locator(".coop-lobby [role=alert]").waitFor();
  await page.waitForFunction(() =>
    /Chrome|Edge|WebTransport/.test(
      document.querySelector(".coop-lobby [role=alert]")?.textContent ?? "",
    ),
  );
  await page
    .getByRole("button", { name: "Launch fighter", exact: true })
    .click();
  await page.waitForFunction(
    () => window.__gameTest.getState().status === "playing",
  );
  await page.screenshot({ path: `${out}/unsupported-solo-fallback.png` });
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        privateRoom: view.squad,
        inviteCopied: true,
        privateIsolation: true,
        reservedCapacity: true,
        unsupportedSoloFallback: true,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Private lobby, invite copy/admission, full reservations, and unsupported-browser solo fallback passed",
  );
} finally {
  await browser.close();
}
