import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.GAME_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});

try {
  await page.goto(`${baseUrl}/?qa=1`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Launch fighter" })
    .evaluate((button) => button.click());
  await page.locator(".hud").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(window.__rogueVectorQa));

  const tilted = await page.evaluate(() => {
    window.__rogueVectorQa.simulateGyro(45, 0);
    for (let sample = 0; sample < 8; sample += 1) {
      window.__rogueVectorQa.simulateGyro(20, 12);
    }
    return window.__rogueVectorQa.snapshot();
  });
  assert.notEqual(tilted.gyro.y, 0, "tilt did not produce pitch input");
  assert.equal(tilted.gyro.baseline, true, "tilt baseline was not established");

  const neutral = await page.evaluate(() => {
    for (let sample = 0; sample < 16; sample += 1) {
      window.__rogueVectorQa.simulateGyro(45, 0);
    }
    return window.__rogueVectorQa.snapshot();
  });
  assert.ok(
    Math.abs(neutral.gyro.y) < Math.abs(tilted.gyro.y),
    "pitch did not recover at neutral",
  );

  // End-to-end guard for the cross-axis coupling the tilt mapping exists to
  // prevent: pure lean must not reach the yaw channel through the real
  // listener. `tests/device-tilt.test.mjs` proves the mapping; this proves it
  // is the mapping the game is wired to.
  const leanOnly = await page.evaluate(() => {
    const qa = window.__rogueVectorQa;
    // A hold with real bank in it - the case the old beta/gamma subtraction
    // got wrong. Settle at the baseline, then lean back without re-banking.
    // Both samples are the same 20-degree bank, 12 degrees apart in lean.
    for (let sample = 0; sample < 24; sample += 1) qa.simulateGyro(46.042, -22.176);
    const settled = qa.snapshot().gyro;
    for (let sample = 0; sample < 24; sample += 1) qa.simulateGyro(56.068, -32.751);
    const leaned = qa.snapshot().gyro;
    return { pitchDelta: leaned.y - settled.y, yawDelta: leaned.x - settled.x };
  });
  assert.ok(
    Math.abs(leanOnly.pitchDelta) > 0.1,
    `lean produced no pitch (${leanOnly.pitchDelta})`,
  );
  assert.ok(
    Math.abs(leanOnly.yawDelta) < 0.05,
    `lean leaked ${leanOnly.yawDelta} into yaw`,
  );

  // ── Phone bank matches the phone ────────────────────────────────────
  // On a phone the ship should lay over by exactly the angle the phone is
  // rolled - not a scaled-up version of it. Real orientation readings are
  // built from known poses and pushed through the real listener.
  const phoneBank = await page.evaluate(() => {
    const qa = window.__rogueVectorQa;
    const radians = Math.PI / 180;
    const screenAngle = ((window.screen?.orientation?.angle ?? 0) % 360 + 360) % 360;
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const normalize = (v) => { const length = Math.hypot(...v); return v.map((value) => value / length); };
    // The browser's beta/gamma for a phone tipped back `lean` degrees and
    // rolled `bank` degrees in its own plane (positive drops the left edge).
    const reading = (lean, bank) => {
      const upright = [0, Math.sin(lean * radians), Math.cos(lean * radians)];
      const outOfScreen = cross([1, 0, 0], upright);
      const right = normalize([1, 0, 0].map((value, axis) => value * Math.cos(bank * radians) + upright[axis] * Math.sin(bank * radians)));
      const up = normalize(cross(outOfScreen, right));
      const a = screenAngle * radians;
      const deviceRight = right.map((value, axis) => Math.cos(a) * value + Math.sin(a) * up[axis]);
      const deviceUp = right.map((value, axis) => -Math.sin(a) * value + Math.cos(a) * up[axis]);
      const beta = Math.asin(Math.max(-1, Math.min(1, deviceUp[2])));
      const gamma = Math.atan2(-deviceRight[2], outOfScreen[2]);
      return [beta / radians, gamma / radians];
    };
    const hold = (lean, bank) => {
      for (let sample = 0; sample < 90; sample += 1) qa.simulateGyro(...reading(lean, bank));
      qa.boostForSteps(1);
      return qa.snapshot().bankRoll / radians;
    };
    // Zero the phone the way a player does, so the poses below are measured
    // from a known neutral rather than whatever earlier checks left behind.
    const calibrate = [...document.querySelectorAll(".touch-btn")].find((button) =>
      button.textContent.includes("CALIB TILT"),
    );
    calibrate.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    hold(35, 0);
    const results = {};
    for (const bank of [5, 12, -30]) results[bank] = hold(35, bank);
    results.level = hold(35, 0);
    return {
      results,
      rollButtons: document.querySelectorAll(".touch-btn-roll").length,
    };
  });
  for (const bank of [5, 12, -30]) {
    assert.ok(
      Math.abs(phoneBank.results[bank] - bank) < 0.5,
      `phone rolled ${bank} degrees but the ship banked ${phoneBank.results[bank].toFixed(2)}`,
    );
  }
  assert.ok(
    Math.abs(phoneBank.results.level) < 0.5,
    `ship stayed banked ${phoneBank.results.level.toFixed(2)} degrees after the phone levelled`,
  );
  assert.equal(phoneBank.rollButtons, 0, "the mobile 90-degree roll button should be gone");

  // ── Bank-into-the-turn regression ───────────────────────────────────
  // The ship should lay over the same way the phone does, by the same
  // proportion, and level out when the phone does - without the bank ever
  // reaching the flight frame, which is what would bend a climb into a turn.
  const bank = await page.evaluate(() => {
    const qa = window.__rogueVectorQa;
    const settle = (steerX, steps = 90) => {
      qa.steerForSteps(steerX, 0, steps);
      const snapshot = qa.snapshot();
      return {
        roll: snapshot.bankRoll,
        lean: snapshot.shipUpDotFrameRight,
      };
    };
    const level = settle(0);
    const right = settle(1);
    const left = settle(-1);
    const halfLeft = settle(-0.5);
    const levelled = settle(0, 180);

    // Pure pitch, at the flight-frame level. Measured against the ship's own
    // right axis rather than a world heading: the ship carries whatever
    // orientation the earlier checks left it in, and pitching a ship that is
    // already rolled changes its compass heading for entirely correct
    // reasons. What must stay zero is rotation out of its own pitch plane.
    qa.steerForSteps(0, 0, 90);
    const beforePitch = qa.snapshot();
    qa.steerForSteps(0, 1, 25);
    const afterPitch = qa.snapshot();
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const pitchYawLeak = Math.abs(
      dot(afterPitch.playerForward, beforePitch.playerRight),
    );
    const pitchTravel = Math.abs(
      dot(afterPitch.playerForward, beforePitch.playerUp),
    );

    return {
      level,
      right,
      left,
      halfLeft,
      levelled,
      pitchYawLeak,
      pitchTravel,
    };
  });

  const MAX_BANK_ROLL = (55 * Math.PI) / 180;
  assert.ok(
    Math.abs(bank.level.roll) < 0.02,
    `ship was not level with no steering (${bank.level.roll})`,
  );
  // Steering right drops the right wing, which tips the ship's up vector to
  // its right; steering left does the mirror image.
  assert.ok(
    bank.right.roll < -0.5 * MAX_BANK_ROLL && bank.right.lean > 0.3,
    `steering right did not drop the right wing (${JSON.stringify(bank.right)})`,
  );
  assert.ok(
    bank.left.roll > 0.5 * MAX_BANK_ROLL && bank.left.lean < -0.3,
    `steering left did not drop the left wing (${JSON.stringify(bank.left)})`,
  );
  assert.ok(
    Math.abs(bank.left.roll) - Math.abs(bank.right.roll) < 0.02,
    "the ship banks further one way than the other",
  );
  // Half the steering, half the bank - the point of matching intensity.
  const proportion = bank.halfLeft.roll / bank.left.roll;
  assert.ok(
    Math.abs(proportion - 0.5) < 0.05,
    `half steering gave ${(proportion * 100).toFixed(0)}% of the bank, not 50%`,
  );
  assert.ok(
    Math.abs(bank.levelled.roll) < 0.02,
    `ship did not level out when steering returned to centre (${bank.levelled.roll})`,
  );
  // The bank is decorative: it must not steer the ship by itself.
  assert.ok(
    bank.pitchTravel > 0.3,
    `the pitch leg did not actually pitch (${bank.pitchTravel})`,
  );
  assert.ok(
    bank.pitchYawLeak < 0.02,
    `pure pitch rotated ${bank.pitchYawLeak.toFixed(4)} out of the ship's pitch plane`,
  );

  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Paused" }).waitFor();
  await page.getByRole("button", { name: "Resume" }).click();
  const resumed = await page.evaluate(() => window.__rogueVectorQa.snapshot());
  assert.equal(resumed.gyro.baseline, false, "resume kept stale gyro state");
  assert.deepEqual(pageErrors, [], "the gyro path emitted page errors");

  /**
   * On a phone the touch buttons take the bottom
   * corners, so the readouts that sit there on a
   * desktop have to live elsewhere.
   *
   * No two visible HUD regions may overlap, or
   * a thumb button hides what it is next to.
   */
  const hudOverlaps = await page.evaluate(() => {
    const overlaps = [];
    const regions = [...document.querySelectorAll(
      ".touch-top-bar, .touch-left-cluster, .touch-right-cluster, .hud-top, .camera-mode, .status-stack, .radar, .radar-label",
    )]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => ({ name: element.className.split(" ")[0], box: element.getBoundingClientRect() }));

    for (let i = 0; i < regions.length; i += 1) {
      for (let j = i + 1; j < regions.length; j += 1) {
        const a = regions[i].box;
        const b = regions[j].box;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

        if (width > 0.5 && height > 0.5) {
          overlaps.push(`${regions[i].name} and ${regions[j].name} overlap by ${Math.round(width)}x${Math.round(height)}px`);
        }
      }
    }
    return { overlaps, count: regions.length };
  });

  assert.ok(hudOverlaps.count >= 6, `expected the phone HUD regions, found ${hudOverlaps.count}`);
  assert.deepEqual(hudOverlaps.overlaps, [], "phone HUD regions overlap");

  // ── Browser-chrome layout regression ────────────────────────────────
  // Two separate claims, checked separately.
  //
  // First: the viewport effect republishes what the browser reports. On iOS
  // Safari the tab bar covers part of a `viewport-fit=cover` page, so the
  // visual viewport is both shorter than the layout viewport and offset down
  // inside it, and a height alone would leave the shell hanging off the
  // visible area.
  const published = await page.evaluate(() => {
    const read = (name) =>
      Number.parseFloat(
        document.documentElement.style.getPropertyValue(name),
      );
    const visual = window.visualViewport;
    return {
      width: [read("--viewport-width"), visual?.width ?? window.innerWidth],
      height: [read("--viewport-height"), visual?.height ?? window.innerHeight],
      offsetTop: [read("--viewport-offset-top"), visual?.offsetTop ?? 0],
      offsetLeft: [read("--viewport-offset-left"), visual?.offsetLeft ?? 0],
    };
  });
  for (const [name, [published_, reported]] of Object.entries(published)) {
    assert.ok(
      Math.abs(published_ - reported) <= 0.5,
      `--viewport-${name} published ${published_}, browser reports ${reported}`,
    );
  }

  // Second: the layout consumes that region correctly. Standing in the
  // geometry a tab bar produces, every control must stay inside the safe
  // region and the canvas must still cover the whole visible area.
  const CHROME = { top: 48, bottom: 60 };
  const INSET = { top: 0, right: 44, bottom: 21, left: 44 };
  const visibleHeight = await page.evaluate(
    ({ chrome, inset }) => {
      const height = window.innerHeight - chrome.top - chrome.bottom;
      const style = document.documentElement.style;
      style.setProperty("--viewport-offset-top", `${chrome.top}px`);
      style.setProperty("--viewport-offset-left", "0px");
      style.setProperty("--viewport-width", `${window.innerWidth}px`);
      style.setProperty("--viewport-height", `${height}px`);
      for (const [side, value] of Object.entries(inset)) {
        style.setProperty(`--safe-${side}`, `${value}px`);
      }
      return height;
    },
    { chrome: CHROME, inset: INSET },
  );
  // The render loop defers style recalc for the shell within a task, so the
  // geometry is read on a later turn rather than in the call that set it.
  await page.waitForTimeout(150);

  const layout = await page.evaluate((inset) => {
    const style = document.documentElement.style;
    const shell = document.querySelector(".game-shell").getBoundingClientRect();
    const safe = {
      top: shell.top + inset.top,
      right: shell.right - inset.right,
      bottom: shell.bottom - inset.bottom,
      left: shell.left + inset.left,
    };
    const overflow = {};
    for (const selector of [
      ".touch-top-bar",
      ".touch-left-cluster",
      ".touch-right-cluster",
      ".hud-top",
    ]) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      overflow[selector] = Math.max(
        safe.top - rect.top,
        rect.bottom - safe.bottom,
        safe.left - rect.left,
        rect.right - safe.right,
      );
    }
    const canvas = document.querySelector(".game-canvas").getBoundingClientRect();
    return {
      overflow,
      // Re-read rather than trust: the app owns these and would have every
      // right to republish them, which would invalidate the measurement.
      stillApplied: {
        offsetTop: style.getPropertyValue("--viewport-offset-top"),
        height: style.getPropertyValue("--viewport-height"),
      },
      shell: { top: shell.top, bottom: shell.bottom },
      canvasGap: Math.max(
        Math.abs(canvas.top - shell.top),
        Math.abs(canvas.bottom - shell.bottom),
        Math.abs(canvas.left - shell.left),
        Math.abs(canvas.right - shell.right),
      ),
    };
  }, INSET);
  layout.visible = { top: CHROME.top, bottom: CHROME.top + visibleHeight };

  assert.equal(
    layout.stillApplied.offsetTop,
    `${CHROME.top}px`,
    "the app republished the viewport offset mid-measurement",
  );
  assert.equal(
    layout.stillApplied.height,
    `${visibleHeight}px`,
    "the app republished the viewport height mid-measurement",
  );
  assert.ok(
    Math.abs(layout.shell.top - layout.visible.top) <= 0.5 &&
      Math.abs(layout.shell.bottom - layout.visible.bottom) <= 0.5,
    `shell ${JSON.stringify(layout.shell)} does not cover the visible region ${JSON.stringify(layout.visible)}`,
  );
  for (const [selector, overflowPixels] of Object.entries(layout.overflow)) {
    assert.ok(
      overflowPixels <= 0.5,
      `${selector} overflows the safe region by ${overflowPixels.toFixed(1)}px under browser chrome`,
    );
  }
  assert.ok(
    layout.canvasGap <= 0.5,
    `canvas leaves a ${layout.canvasGap.toFixed(1)}px gap inside the shell`,
  );

  console.log("gyro regression passed");
} catch (error) {
  console.error(JSON.stringify({ error: String(error), pageErrors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
