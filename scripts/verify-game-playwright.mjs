import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.GAME_URL ?? "http://localhost:3000";
const outputDirectory = resolve("outputs", "playwright");
const headed = process.env.PLAYWRIGHT_HEADED === "1";
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: !headed,
  channel: headed ? "chrome" : undefined,
  args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const gameCanvas = page.locator(".game-canvas canvas").first();
page.setDefaultTimeout(180_000);

const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const requestFailures = [];
const badResponses = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
  if (message.type() === "warning") consoleWarnings.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) => {
  requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function readFramebufferStats() {
  return gameCanvas.evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    if (!gl) return null;
    return new Promise((resolveStats) => {
      requestAnimationFrame(() => {
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const sampleWidth = Math.min(512, width);
        const sampleHeight = Math.min(320, height);
        const pixels = new Uint8Array(sampleWidth * sampleHeight * 4);
        gl.readPixels(
          Math.floor((width - sampleWidth) / 2),
          Math.floor((height - sampleHeight) / 2),
          sampleWidth,
          sampleHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let coloredSamples = 0;
        let luminance = 0;
        let sampled = 0;
        const stride = Math.max(4, Math.floor(pixels.length / 45_000 / 4) * 4);
        for (let index = 0; index < pixels.length; index += stride) {
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          if (red + green + blue > 16) coloredSamples += 1;
          luminance += red + green + blue;
          sampled += 1;
        }
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        resolveStats({
          width,
          height,
          sampleWidth,
          sampleHeight,
          sampled,
          coloredSamples,
          meanRgb: luminance / Math.max(1, sampled * 3),
          version: gl.getParameter(gl.VERSION),
          shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          renderer: debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        });
      });
    });
  });
}

let report;
try {
  await page.goto(`${baseUrl}/?qa=1`, { waitUntil: "domcontentloaded" });
  const launch = page.getByRole("button", { name: "Launch fighter" });
  await launch.waitFor({ state: "visible" });
  assert.equal(
    await page.getByText("Asset link interrupted").count(),
    0,
    "the game entered its asset-error state",
  );

  await page.screenshot({
    path: resolve(outputDirectory, "01-menu.png"),
    fullPage: true,
  });
  const menuFrameA = await gameCanvas.screenshot();
  await page.waitForTimeout(650);
  const menuFrameB = await gameCanvas.screenshot();
  assert.notEqual(hash(menuFrameA), hash(menuFrameB), "idle canvas did not animate");

  const responsiveViewportChecks = [];
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 900, height: 900 },
    { width: 1600, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(
      ({ width, height }) => {
        const canvas = document.querySelector(".game-canvas canvas");
        const gl = canvas?.getContext("webgl2");
        const qaViewport = window.__rogueVectorQa?.snapshot().viewport;
        if (!canvas || !gl || !qaViewport) return false;
        const bounds = canvas.getBoundingClientRect();
        return (
          Math.round(bounds.left) === 0 &&
          Math.round(bounds.top) === 0 &&
          Math.round(bounds.width) === width &&
          Math.round(bounds.height) === height &&
          gl.drawingBufferWidth === width &&
          gl.drawingBufferHeight === height &&
          Math.abs(qaViewport.cameraAspect - width / height) < 0.0001
        );
      },
      viewport,
    );
    responsiveViewportChecks.push(
      await gameCanvas.evaluate((canvas) => {
        const gl = canvas.getContext("webgl2");
        const bounds = canvas.getBoundingClientRect();
        return {
          viewport: [window.innerWidth, window.innerHeight],
          bounds: [
            Math.round(bounds.left),
            Math.round(bounds.top),
            Math.round(bounds.width),
            Math.round(bounds.height),
          ],
          drawingBuffer: [
            gl?.drawingBufferWidth ?? 0,
            gl?.drawingBufferHeight ?? 0,
          ],
          cameraAspect:
            window.__rogueVectorQa?.snapshot().viewport.cameraAspect ?? 0,
        };
      }),
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".game-canvas canvas");
    const gl = canvas?.getContext("webgl2");
    return (
      canvas?.clientWidth === 1440 &&
      canvas.clientHeight === 900 &&
      gl?.drawingBufferWidth === 1440 &&
      gl.drawingBufferHeight === 900
    );
  });

  await page.getByRole("button", { name: "Graphics" }).click();
  const quality = page.getByLabel("Quality preset");
  const defaultQuality = await quality.inputValue();
  assert.equal(defaultQuality, "ultra", "Ultra is not the default preset");
  await page.screenshot({
    path: resolve(outputDirectory, "02-ultra-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Controls" }).click();
  await page.getByText("Right click / Ctrl").waitFor();
  await page.getByText("Left click / Space").waitFor();
  await page.getByRole("button", { name: "Return" }).click();

  await launch.click();
  await page.locator(".hud").waitFor({ state: "visible" });
  const developmentPerf = page.locator(".development-r3f-perf");
  await developmentPerf.waitFor({ state: "visible" });
  await page.waitForTimeout(900);
  const developmentPerfText = await developmentPerf.innerText();
  assert.match(
    developmentPerfText,
    /GPU[\s\S]*CPU[\s\S]*FPS/,
    "r3f-perf did not render its GPU, CPU, and FPS labels",
  );
  const perfCanvas = developmentPerf.locator("canvas");
  const perfFrameA = await perfCanvas.screenshot();
  await page.waitForTimeout(650);
  const perfFrameB = await perfCanvas.screenshot();
  assert.notEqual(
    hash(perfFrameA),
    hash(perfFrameB),
    "r3f-perf did not update its live performance graph",
  );
  await page.screenshot({
    path: resolve(outputDirectory, "03-combat-stable.png"),
    fullPage: true,
  });

  const initialFlightSnapshot = await page.evaluate(() =>
    window.__rogueVectorQa?.snapshot(),
  );
  await page.evaluate(() => {
    window.__rogueVectorQa?.steerForSteps(1, 0, 120);
  });
  await page.waitForTimeout(250);
  const fullTurnSnapshot = await page.evaluate(() =>
    window.__rogueVectorQa?.snapshot(),
  );
  assert.equal(initialFlightSnapshot?.playerForward?.length, 3);
  assert.equal(fullTurnSnapshot?.playerForward?.length, 3);
  const fullTurnDot = initialFlightSnapshot.playerForward.reduce(
    (sum, component, index) =>
      sum + component * fullTurnSnapshot.playerForward[index],
    0,
  );
  assert.ok(
    fullTurnDot < -0.75,
    `fixed-step yaw did not turn beyond 135 degrees (dot ${fullTurnDot})`,
  );

  await page.mouse.move(1100, 280);
  await page.keyboard.down("Control");
  await page.waitForTimeout(500);
  await page.keyboard.up("Control");
  await page.keyboard.press("Space");
  const controlSnapshot = await page.evaluate(() =>
    window.__rogueVectorQa?.snapshot(),
  );
  assert.ok(
    (controlSnapshot?.activeProjectiles ?? 0) > 0,
    "the fire control did not create projectiles",
  );
  assert.ok((controlSnapshot?.speed ?? 0) > 70, "the reference speed ramp did not advance");
  assert.equal(
    controlSnapshot?.sideways,
    true,
    "the reference 90-degree profile control did not toggle",
  );
  assert.ok(
    Math.abs(controlSnapshot?.playerForward?.[1] ?? 0) > 0.05,
    "pitch input did not change the ship's world-space flight direction",
  );
  await page.keyboard.press("p");
  await page.locator(".perf-panel").waitFor({ state: "visible" });
  await page.waitForTimeout(1200);

  const flightFrameA = await gameCanvas.screenshot();
  const framebufferA = await readFramebufferStats();
  await page.mouse.move(340, 650);
  await page.waitForTimeout(900);
  const flightFrameB = await gameCanvas.screenshot();
  const framebufferB = await readFramebufferStats();
  assert.notEqual(
    hash(flightFrameA),
    hash(flightFrameB),
    "combat canvas did not advance between frames",
  );
  assert.ok(flightFrameA.length > 20_000, "first combat canvas capture is blank");
  assert.ok(flightFrameB.length > 20_000, "second combat canvas capture is blank");
  assert.match(
    framebufferA?.version ?? "",
    /^WebGL 2\.0/,
    "the combat canvas is not using WebGL2",
  );

  await page.screenshot({
    path: resolve(outputDirectory, "04-combat-maneuver.png"),
    fullPage: true,
  });
  const diagnostics = await page.locator(".perf-panel").innerText();
  const hudBeforeCamera = await page.locator(".camera-mode").innerText();
  await page.keyboard.press("c");
  await page.waitForFunction(
    () => document.querySelector(".camera-mode")?.textContent?.includes("COCKPIT"),
  );
  const hudAfterCamera = await page.locator(".camera-mode").innerText();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Paused" }).waitFor();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.locator(".hud").waitFor({ state: "visible" });

  await page.goto(`${baseUrl}/?qa=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__rogueVectorQa?.stageFleet === "function");
  const qualityTransitions = [];
  for (const preset of ["low", "medium", "high", "ultra"]) {
    await page.getByRole("button", { name: "Graphics" }).click();
    await page.getByLabel("Quality preset").selectOption(preset);
    await page.getByRole("button", { name: "Apply configuration" }).click();
    await page.getByRole("button", { name: "Graphics" }).waitFor();
    qualityTransitions.push(
      await page.evaluate(() => window.__rogueVectorQa?.snapshot()),
    );
  }
  assert.deepEqual(
    qualityTransitions.map(({ quality, detail }) => ({ quality, detail })),
    [
      { quality: "low", detail: "low" },
      { quality: "medium", detail: "high" },
      { quality: "high", detail: "high" },
      { quality: "ultra", detail: "high" },
    ],
    "graphics presets selected an incorrect model-detail tier",
  );
  await page.evaluate(() => {
    window.__rogueVectorQa?.stageFleet();
  });
  await page.getByRole("heading", { name: "Paused" }).waitFor();
  const fleetSnapshot = await page.evaluate(() => {
    document
      .querySelectorAll(".overlay, .hud")
      .forEach((element) => ((element).style.display = "none"));
    document.querySelector(".game-canvas")?.classList.remove("is-paused");
    return window.__rogueVectorQa?.snapshot();
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: resolve(outputDirectory, "05-fleet-inspection.png"),
    fullPage: true,
  });
  assert.deepEqual(
    fleetSnapshot?.activeEnemies,
    { fighter: 1, interceptor: 1, bomber: 1 },
    "fleet inspection did not stage every enemy model",
  );

  report = {
    url: page.url(),
    title: await page.title(),
    defaultQuality,
    developmentPerfText,
    developmentPerfFrameChanged: hash(perfFrameA) !== hash(perfFrameB),
    responsiveViewportChecks,
    idleFrameChanged: hash(menuFrameA) !== hash(menuFrameB),
    combatFrameChanged: hash(flightFrameA) !== hash(flightFrameB),
    framebufferA,
    framebufferB,
    diagnostics,
    initialFlightSnapshot,
    fullTurnSnapshot,
    fullTurnDot,
    controlSnapshot,
    hudBeforeCamera,
    hudAfterCamera,
    qualityTransitions,
    fleetSnapshot,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    requestFailures,
    badResponses,
  };

  assert.deepEqual(pageErrors, [], "uncaught page errors were emitted");
  assert.deepEqual(requestFailures, [], "network requests failed");
  assert.deepEqual(badResponses, [], "HTTP error responses were emitted");
  assert.deepEqual(consoleErrors, [], "browser console errors were emitted");
} finally {
  await writeFile(
    resolve(outputDirectory, "report.json"),
    `${JSON.stringify(report ?? {
      consoleErrors,
      consoleWarnings,
      pageErrors,
      requestFailures,
      badResponses,
    }, null, 2)}\n`,
  );
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
