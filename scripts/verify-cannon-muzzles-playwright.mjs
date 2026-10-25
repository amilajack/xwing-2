import { chromium } from "playwright";

/**
 * Banks the ship with the real mouse and fires each cannon, checking that
 * the bolt and flash start at the cannon tip as drawn. Headed, it freezes
 * the game on every shot long enough to see where the bolt leaves from.
 */
const baseUrl = process.env.GAME_URL ?? "http://localhost:3000";
const headed = process.env.PLAYWRIGHT_HEADED === "1";
const WITHIN_UNITS = 0.01;
const SECONDS_PER_FROZEN_SHOT = headed ? 1.5 : 0;
const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=gl-egl",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.setDefaultTimeout(180_000);

const pageErrors = [];

page.on("pageerror", (error) => pageErrors.push(error.message));

const misses = [];

try {
  await page.goto(`${baseUrl}/?qa=1`);
  await page
    .getByRole("button", { name: "Launch fighter" })
    .click({ noWaitAfter: true });

  await page.locator(".hud").waitFor({ state: "visible" });
  await page.mouse.move(1350, 450);
  await page.waitForTimeout(800);
  for (let shot = 0; shot < 4; shot += 1) {
    const report = await page.evaluate(() => {
      const fired = window.__rogueVectorQa.fireCannon();

      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP" }));

      return fired;
    });

    await page.waitForTimeout(SECONDS_PER_FROZEN_SHOT * 1000);
    await page.keyboard.press("p");
    for (const part of ["bolt", "flash"]) {
      const distance = Math.hypot(
        ...report[part].map((value, axis) => value - report.cannonTip[axis]),
      );

      if (distance >= WITHIN_UNITS) {
        misses.push(
          `shot ${shot + 1}: the ${part} starts ${distance.toFixed(2)} units ` +
            `from its cannon tip at roll ${report.modelRoll.toFixed(2)} rad`,
        );
      }
    }
  }
} finally {
  await browser.close();
}

if (pageErrors.length > 0) misses.push(...pageErrors);

console.log(misses.length > 0 ? misses.join("\n") : "Every shot left its cannon tip.");

process.exitCode = misses.length > 0 ? 1 : 0;
