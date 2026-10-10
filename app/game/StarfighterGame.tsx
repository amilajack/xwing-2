"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  advance,
  Canvas,
  useFrame,
  useThree,
  type GLProps,
} from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  float,
  instancedBufferAttribute,
  max,
  positionView,
  screenDPR,
  screenSize,
} from "three/tsl";
import { deviceTiltFromOrientation, type DeviceTilt } from "./deviceTilt";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

declare global {
  interface Window {
    __rogueVectorQa?: {
      stageFleet: () => void;
      simulateGyro: (beta: number, gamma: number) => void;
      steerForSteps: (steerX: number, steerY: number, steps: number) => void;
      boostForSteps: (steps: number) => number;
      snapshot: () => {
        status: GameStatus;
        quality: QualityName;
        detail: "high" | "low";
        backend: RenderBackend;
        touchDevice: boolean;
        gyroPermission: GyroPermissionState;
        gyro: { x: number; y: number; baseline: boolean };
        activeEnemies: Record<EnemyKind, number>;
        activeProjectiles: number;
        speed: number;
        boostActive: boolean;
        boostRemaining: number;
        sideways: boolean;
        playerPosition: [number, number, number];
        playerForward: [number, number, number];
        viewport: {
          width: number;
          height: number;
          cameraAspect: number;
        };
      };
    };
  }
}

type GameStatus =
  | "loading"
  | "menu"
  | "playing"
  | "paused"
  | "gameover"
  | "unsupported"
  | "asseterror";
type QualityName = "low" | "medium" | "high" | "ultra" | "custom";
type RenderBackend = "webgpu" | "webgl2";
type EnemyKind = "fighter" | "interceptor" | "bomber";
type GyroPermissionState =
  | "unavailable"
  | "prompt"
  | "requesting"
  | "granted"
  | "denied";
type WakeLockHandle = { release: () => Promise<void> };
type WakeLockManager = {
  request: (type: "screen") => Promise<WakeLockHandle>;
};

function isWakeLockManager(value: unknown): value is WakeLockManager {
  if (typeof value !== "object" || value === null) return false;
  return "request" in value && typeof value.request === "function";
}
type MotionPermissionRequest = () => Promise<"granted" | "denied">;
type OrientationLockRequest = (
  orientation: "any" | "natural" | "landscape" | "portrait",
) => Promise<void>;

function isMotionPermissionRequest(
  value: unknown,
): value is MotionPermissionRequest {
  return typeof value === "function";
}

function isOrientationLockRequest(
  value: unknown,
): value is OrientationLockRequest {
  return typeof value === "function";
}

type GraphicsSettings = {
  quality: QualityName;
  renderScale: number;
  maxDpr: number;
  targetFps: number;
  autoResolution: boolean;
  shadows: boolean;
  effects: number;
  asteroidCount: number;
  starCount: number;
  sensitivity: number;
  invertY: boolean;
  muted: boolean;
};

type RadarContact = {
  id: number;
  x: number;
  y: number;
  kind: EnemyKind;
};

type HudSnapshot = {
  shields: number;
  hull: number;
  speed: number;
  engineRamp: number;
  boost: number;
  boostActive: boolean;
  wave: number;
  score: number;
  enemies: number;
  camera: "CHASE" | "COCKPIT";
  targetX: number;
  targetY: number;
  targetVisible: boolean;
  targetLabel: string;
  targetDistance: number;
  radar: RadarContact[];
  boundary: boolean;
  damage: number;
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  renderScale: number;
  diagnostics: boolean;
  input: "KEYBOARD + MOUSE" | "GAMEPAD" | "PHONE / GYRO" | "TOUCH";
  sideways: boolean;
  rawGyroX: number;
  rawGyroY: number;
  isTouchDevice: boolean;
  gyroPermission: GyroPermissionState;
  onFireStart?: () => void;
  onFireEnd?: () => void;
  onBoostStart?: () => void;
  onBoostEnd?: () => void;
  onToggleSideways?: () => void;
  onToggleCamera?: () => void;
  onCalibrateGyro?: () => void;
};

const QUALITY_PRESETS: Record<Exclude<QualityName, "custom">, GraphicsSettings> =
  {
    low: {
      quality: "low",
      renderScale: 0.65,
      maxDpr: 1,
      targetFps: 60,
      autoResolution: true,
      shadows: false,
      effects: 0.45,
      asteroidCount: 130,
      starCount: 1400,
      sensitivity: 1,
      invertY: false,
      muted: false,
    },
    medium: {
      quality: "medium",
      renderScale: 0.82,
      maxDpr: 1.25,
      targetFps: 60,
      autoResolution: true,
      shadows: false,
      effects: 0.7,
      asteroidCount: 240,
      starCount: 2600,
      sensitivity: 1,
      invertY: false,
      muted: false,
    },
    high: {
      quality: "high",
      renderScale: 1,
      maxDpr: 1.5,
      targetFps: 60,
      autoResolution: true,
      shadows: true,
      effects: 0.9,
      asteroidCount: 380,
      starCount: 4200,
      sensitivity: 1,
      invertY: false,
      muted: false,
    },
    ultra: {
      quality: "ultra",
      renderScale: 1,
      maxDpr: 2,
      targetFps: 120,
      autoResolution: false,
      shadows: true,
      effects: 1,
      asteroidCount: 560,
      starCount: 6000,
      sensitivity: 1,
      invertY: false,
      muted: false,
    },
  };

const DEFAULT_SETTINGS = QUALITY_PRESETS.ultra;
const SETTINGS_KEY = "rogue-vector-settings-v2";
const SCORE_KEY = "rogue-vector-high-score";
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const FIXED_STEP = 1 / 60;
const MAX_ENEMIES = 20;
const MAX_PROJECTILES = 320;
const MAX_EXPLOSIONS = 32;
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
/** Roll axis, pointing back down the fuselage: +Z rolls the left wing down. */
const LOCAL_ROLL_AXIS = new THREE.Vector3(0, 0, 1);
const REFERENCE_SPEED_SCALE = 17.5;
const MAX_PITCH_RATE = THREE.MathUtils.degToRad(78);
const MAX_YAW_RATE = THREE.MathUtils.degToRad(92);
const FLIGHT_CONTROL_RESPONSE = 7;
// How far the ship lays over at full stick or mouse deflection. A phone
// needs no such scale: the ship copies the phone's own roll, angle for angle.
// The bank is a visual answer to the input, not an aerodynamic one: it rolls
// the model inside the flight frame rather than rolling the frame itself, so
// a banked ship still pitches and yaws along the axes the player aimed it at.
const MAX_BANK_ROLL = THREE.MathUtils.degToRad(55);
const BANK_ROLL_RESPONSE = 5;
const ARENA_HALF_EXTENT = 700;
// The afterburner reservoir holds ten seconds of thrust. It only refills while
// the burner is off, so a single hold can never exceed BOOST_MAX_SECONDS.
const BOOST_MAX_SECONDS = 10;
const BOOST_RECHARGE_PER_SECOND = 0.5;
const BOOST_REARM_SECONDS = BOOST_MAX_SECONDS * 0.25;
const BOOST_SPEED_FACTOR = 2.2;
const BOOST_RESPONSE = 4.5;
const BOOST_FOV_KICK = 14;
const BOOST_CHASE_PULLBACK = 16;
const PLAYER_XWING_VISUAL_SCALE = 5;
const SUN_DIRECTION = new THREE.Vector3(-180, 240, 160).normalize();
const SUN_RENDER_DISTANCE = 1200;
const SUN_SPRITE_DIAMETER = 400;
const SUN_LIGHT_DISTANCE = 400;
const SUN_SHADOW_EXTENT = 220;
const STAR_SIZE = 1.35;
const TONE_MAPPING_EXPOSURE = 1.45;
const SKY_COLOR = 0x030b14;
// three's ACES filmic fit: the matrices either side of its RRT/ODT curve.
const ACES_INPUT_INVERSE = new THREE.Matrix3()
  .set(
    0.59719, 0.35458, 0.04823,
    0.076, 0.90834, 0.01566,
    0.0284, 0.13383, 0.83777,
  )
  .invert();
const ACES_OUTPUT_INVERSE = new THREE.Matrix3()
  .set(
    1.60475, -0.53108, -0.07367,
    -0.10208, 1.10813, -0.00605,
    -0.00327, -0.07276, 1.07602,
  )
  .invert();
const SHIP_DISPLAY_SIZE: Record<ShipRole, number> = {
  player: 9.8 * PLAYER_XWING_VISUAL_SCALE,
  fighter: 6.2,
  interceptor: 7.6,
  bomber: 13.5,
};

type ShipRole = "player" | EnemyKind;
type ShipModelSet = Record<ShipRole, THREE.Group>;
type ShipModelLibrary = {
  high: ShipModelSet;
  low: ShipModelSet;
  asteroid: THREE.Mesh;
};

/**
 * WebGPURenderer tone-maps everything it draws, including the clear color, fog,
 * and materials flagged `toneMapped: false`. This solves for the scene color
 * that ACES at the game's exposure maps back onto a linear display color. The
 * result can exceed 1 for bright targets.
 */
function sceneColorFor(display: THREE.Vector3, scene = new THREE.Vector3()) {
  const { x, y, z } = display;
  // Solve the RRT/ODT fit (x² + 0.0245786x − 0.000090537) /
  // (0.983729x² + 0.432951x + 0.238081) = y for its positive root.
  const unfit = (fitted: number) => {
    const a = Math.max(1e-4, 1 - 0.983729 * fitted);
    const b = 0.0245786 - 0.432951 * fitted;
    const c = -(0.000090537 + 0.238081 * fitted);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  };
  // Very saturated targets would need negative light, which the renderer
  // clamps into a washed-out tint. Dim those until every channel is reachable.
  for (let brightness = 1; brightness > 0; brightness -= 0.02) {
    scene
      .set(x, y, z)
      .multiplyScalar(brightness)
      .applyMatrix3(ACES_OUTPUT_INVERSE);
    scene
      .set(unfit(scene.x), unfit(scene.y), unfit(scene.z))
      .applyMatrix3(ACES_INPUT_INVERSE)
      .multiplyScalar(0.6 / TONE_MAPPING_EXPOSURE);
    if (Math.min(scene.x, scene.y, scene.z) >= 0) break;
  }
  return scene;
}

/** The scene color that reaches the screen as the given sRGB hex color. */
function displayColor(hex: number) {
  const color = new THREE.Color(hex);
  const scene = sceneColorFor(new THREE.Vector3(color.r, color.g, color.b));
  return color.setRGB(scene.x, scene.y, scene.z);
}

// three's inspector reports frame, CPU, and GPU timings on either backend. It
// has to be attached before the renderer initializes to mount its overlay.
async function attachDevelopmentInspector(renderer: THREE.WebGPURenderer) {
  if (!IS_DEVELOPMENT) return;
  // The inspector and its Settings tab import each other. Turbopack can only
  // evaluate that cycle when it is entered through the tab.
  // @ts-expect-error -- three publishes no type declarations for this tab.
  await import("three/examples/jsm/inspector/tabs/Settings.js");
  const { Inspector } = await import(
    "three/examples/jsm/inspector/Inspector.js"
  );
  renderer.inspector = new Inspector();
}

// react-three-fiber can ask for the renderer again while the first one is
// still initializing, so each canvas keeps a single pending renderer.
const pendingRenderers = new WeakMap<
  HTMLCanvasElement,
  Promise<THREE.WebGPURenderer>
>();

// WebGPURenderer targets WebGPU and falls back to its own WebGL2 backend when
// the browser has no usable adapter. Initialization only fails with neither.
function createRendererFactory(onUnavailable: () => void): GLProps {
  return ({ canvas }) => {
    const htmlCanvas = canvas as HTMLCanvasElement;
    let pending = pendingRenderers.get(htmlCanvas);
    if (!pending) {
      const query = new URLSearchParams(window.location.search);
      const renderer = new THREE.WebGPURenderer({
        alpha: false,
        antialias: false,
        canvas: htmlCanvas,
        depth: true,
        // QA can pin the fallback backend on a WebGPU-capable machine.
        forceWebGL: query.has("qa") && query.has("forceWebGL"),
        powerPreference: "high-performance",
        stencil: false,
      });
      pending = attachDevelopmentInspector(renderer)
        .then(() => renderer.init())
        .then(() => renderer);
      pending.catch(onUnavailable);
      pendingRenderers.set(htmlCanvas, pending);
    }
    return pending;
  };
}

const EMPTY_HUD: HudSnapshot = {
  shields: 100,
  hull: 100,
  speed: 0,
  engineRamp: 0,
  boost: 100,
  boostActive: false,
  wave: 1,
  score: 0,
  enemies: 0,
  camera: "CHASE",
  targetX: 50,
  targetY: 50,
  targetVisible: false,
  targetLabel: "",
  targetDistance: 0,
  radar: [],
  boundary: false,
  damage: 0,
  fps: 60,
  frameMs: 16.7,
  drawCalls: 0,
  triangles: 0,
  renderScale: 1,
  diagnostics: false,
  input: "KEYBOARD + MOUSE",
  sideways: false,
  rawGyroX: 0,
  rawGyroY: 0,
  isTouchDevice: false,
  gyroPermission: "unavailable",
};

function loadSettings(): GraphicsSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(SETTINGS_KEY) ?? "{}",
    ) as Partial<GraphicsSettings>;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function loadHighScore() {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(SCORE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function requestLandscapeLock() {
  if (typeof window === "undefined") return;
  const orientation = window.screen.orientation;
  const lockCandidate = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(orientation),
    "lock",
  )?.value;
  if (!isOrientationLockRequest(lockCandidate)) return;
  void lockCandidate.call(orientation, "landscape").catch((error: unknown) => {
    console.debug("Landscape orientation lock is unavailable", error);
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function seededRandom(seed = 7831) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function deadzone(value: number, zone = 0.12) {
  const abs = Math.abs(value);
  if (abs <= zone) return 0;
  return Math.sign(value) * ((abs - zone) / (1 - zone));
}

async function loadShipModelLibrary(isTouchDevice: boolean): Promise<ShipModelLibrary> {
  const loader = new GLTFLoader();
  const loadUncached = async (path: string, role: ShipRole) => {
    const gltf = await loader.loadAsync(path);
    const scene = gltf.scene;
    const nonVisualNodes: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = true;
      } else if (object instanceof THREE.Camera || object instanceof THREE.Light) {
        nonVisualNodes.push(object);
      }
    });
    nonVisualNodes.forEach((object) => object.removeFromParent());

    const orientedScene = new THREE.Group();
    orientedScene.name = `${role}-asset-orientation`;
    orientedScene.add(scene);
    if (role === "player") {
      // The Sketchfab X-wing is authored nose-forward on +Z, while the
      // simulation's canonical forward axis is -Z.
      orientedScene.rotation.y = Math.PI;
    }

    orientedScene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(orientedScene);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(largestDimension) || largestDimension <= 0) {
      throw new Error(`${path} has invalid model bounds.`);
    }
    const normalization = new THREE.Group();
    normalization.name = `${role}-asset-normalization`;
    normalization.add(orientedScene);
    const normalizationScale = SHIP_DISPLAY_SIZE[role] / largestDimension;
    normalization.scale.setScalar(normalizationScale);
    normalization.position.copy(center).multiplyScalar(-normalizationScale);
    normalization.updateMatrixWorld(true);

    const gameRoot = new THREE.Group();
    gameRoot.name = `${role}-normalized-gltf`;
    gameRoot.add(normalization);
    return gameRoot;
  };
  const loadedModels = new Map<string, Promise<THREE.Group>>();
  const load = (path: string, role: ShipRole) => {
    const existing = loadedModels.get(`${role}:${path}`);
    if (existing) return existing;
    const model = loadUncached(path, role);
    loadedModels.set(`${role}:${path}`, model);
    return model;
  };

  const [
    playerHigh,
    playerLow,
    fighterHigh,
    fighterLow,
    interceptorHigh,
    interceptorLow,
    bomberHigh,
    bomberLow,
    asteroidScene,
  ] = await Promise.all([
    load(isTouchDevice ? "/models/xwing-low.glb" : "/models/xwing-high.glb", "player"),
    load("/models/xwing-low.glb", "player"),
    load(isTouchDevice ? "/models/tie-fighter-low.glb" : "/models/tie-fighter-high.glb", "fighter"),
    load("/models/tie-fighter-low.glb", "fighter"),
    load(isTouchDevice ? "/models/tie-interceptor-low.glb" : "/models/tie-interceptor-high.glb", "interceptor"),
    load("/models/tie-interceptor-low.glb", "interceptor"),
    load(isTouchDevice ? "/models/stealth-bomber-low.glb" : "/models/stealth-bomber-high.glb", "bomber"),
    load("/models/stealth-bomber-low.glb", "bomber"),
    loader.loadAsync("/models/asteroid-high.glb").then((gltf) => gltf.scene),
  ]);

  let asteroid: THREE.Mesh | undefined;
  asteroidScene.traverse((object) => {
    if (!asteroid && object instanceof THREE.Mesh) asteroid = object;
  });
  if (!asteroid) throw new Error("The high-detail asteroid glTF has no mesh.");
  asteroidScene.updateMatrixWorld(true);
  const asteroidGeometry = asteroid.geometry
    .clone()
    .applyMatrix4(asteroid.matrixWorld);
  asteroidGeometry.computeBoundingBox();
  const asteroidBounds = asteroidGeometry.boundingBox;
  if (!asteroidBounds) {
    throw new Error("The high-detail asteroid glTF has invalid bounds.");
  }
  const asteroidCenter = asteroidBounds.getCenter(new THREE.Vector3());
  const asteroidSize = asteroidBounds.getSize(new THREE.Vector3());
  const asteroidLargestDimension = Math.max(
    asteroidSize.x,
    asteroidSize.y,
    asteroidSize.z,
  );
  asteroidGeometry.translate(
    -asteroidCenter.x,
    -asteroidCenter.y,
    -asteroidCenter.z,
  );
  asteroidGeometry.scale(
    1 / asteroidLargestDimension,
    1 / asteroidLargestDimension,
    1 / asteroidLargestDimension,
  );
  asteroid = new THREE.Mesh(asteroidGeometry, asteroid.material);

  return {
    high: {
      player: playerHigh,
      fighter: fighterHigh,
      interceptor: interceptorHigh,
      bomber: bomberHigh,
    },
    low: {
      player: playerLow,
      fighter: fighterLow,
      interceptor: interceptorLow,
      bomber: bomberLow,
    },
    asteroid,
  };
}

function disposeModelLibrary(library: ShipModelLibrary) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const detail of [library.high, library.low]) {
    for (const model of Object.values(detail)) {
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        const values = Array.isArray(object.material)
          ? object.material
          : [object.material];
        values.forEach((material) => materials.add(material));
      });
    }
  }
  geometries.add(library.asteroid.geometry);
  const asteroidMaterials = Array.isArray(library.asteroid.material)
    ? library.asteroid.material
    : [library.asteroid.material];
  asteroidMaterials.forEach((material) => materials.add(material));
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function makeGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.12, "rgba(150,235,255,.95)");
    gradient.addColorStop(0.42, "rgba(35,165,255,.45)");
    gradient.addColorStop(1, "rgba(0,80,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeSunTexture() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = 128;
  canvas.height = 128;

  if (context) {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);

    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.44, "rgba(255,246,222,1)");
    gradient.addColorStop(0.58, "rgba(255,206,120,1)");
    gradient.addColorStop(0.63, "rgba(255,150,54,.45)");
    gradient.addColorStop(1, "rgba(255,96,16,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }

  // The disc glows over the sky without tone mapping. Each texel becomes the
  // light to add to the sky so that the tone-mapped sum shows the gradient.
  const texels = context?.getImageData(0, 0, 128, 128).data;
  const light = new Uint16Array(128 * 128 * 4);
  const sky = new THREE.Color(SKY_COLOR);
  const skyLight = sceneColorFor(new THREE.Vector3().setFromColor(sky));
  const skyDisplay = sky.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const display = new THREE.Color();
  const scene = new THREE.Vector3();
  for (let index = 0; texels && index < texels.length; index += 4) {
    const alpha = texels[index + 3] / 255 / 255;
    display.setRGB(
      Math.min(1, skyDisplay.r + texels[index] * alpha),
      Math.min(1, skyDisplay.g + texels[index + 1] * alpha),
      Math.min(1, skyDisplay.b + texels[index + 2] * alpha),
      THREE.SRGBColorSpace,
    );
    sceneColorFor(scene.setFromColor(display), scene).sub(skyLight);
    light[index] = THREE.DataUtils.toHalfFloat(Math.max(0, scene.x));
    light[index + 1] = THREE.DataUtils.toHalfFloat(Math.max(0, scene.y));
    light[index + 2] = THREE.DataUtils.toHalfFloat(Math.max(0, scene.z));
    light[index + 3] = THREE.DataUtils.toHalfFloat(1);
  }

  const texture = new THREE.DataTexture(
    light,
    128,
    128,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return texture;
}

class SharedAssets {
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly playerHull = new THREE.MeshStandardMaterial({
    color: 0xcbd1ce,
    roughness: 0.58,
    metalness: 0.38,
  });
  readonly canopy = new THREE.MeshStandardMaterial({
    color: 0x182934,
    roughness: 0.16,
    metalness: 0.78,
    emissive: 0x081822,
    emissiveIntensity: 0.8,
  });
  readonly glowTexture = makeGlowTexture();
  readonly sunTexture = makeSunTexture();

  dispose() {
    this.box.dispose();
    this.playerHull.dispose();
    this.canopy.dispose();
    this.glowTexture.dispose();
    this.sunTexture.dispose();
  }
}

function addPart(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/*
 * Ship geometry is authored into the project-local glTF assets by
 * scripts/generate-ship-models.mjs. These retired runtime constructors are kept
 * in this comment only as a migration record; the game never compiles or runs
 * procedural ship geometry.
 *
function createPlayerShip(assets: SharedAssets) {
  const ship = new THREE.Group();
  ship.name = "RV-X77";

  addPart(
    ship,
    assets.cylinder,
    assets.playerHull,
    [0, 0, 0.2],
    [0.42, 4.9, 0.42],
    [Math.PI / 2, 0, 0],
  );
  addPart(
    ship,
    assets.cone,
    assets.playerHull,
    [0, 0, -2.65],
    [0.42, 1.75, 0.42],
    [-Math.PI / 2, 0, 0],
  );
  addPart(
    ship,
    assets.sphere,
    assets.canopy,
    [0, 0.38, -0.45],
    [0.52, 0.35, 0.72],
  );
  addPart(
    ship,
    assets.box,
    assets.playerAccent,
    [0, 0.02, -1.1],
    [0.5, 0.06, 1.45],
  );

  const wingData: Array<[number, number, number]> = [
    [-1, 1, 1],
    [1, 1, -1],
    [-1, -1, -1],
    [1, -1, 1],
  ];
  wingData.forEach(([side, vertical, cant]) => {
    const wing = new THREE.Group();
    wing.position.set(side * 1.45, vertical * 0.34, 0.2);
    wing.rotation.z = cant * 0.14;
    addPart(
      wing,
      assets.box,
      assets.playerPanel,
      [0, 0, 0],
      [2.65, 0.1, 1.06],
    );
    addPart(
      wing,
      assets.box,
      assets.playerAccent,
      [side * 0.25, vertical * 0.065, -0.08],
      [1.5, 0.035, 0.12],
    );
    addPart(
      wing,
      assets.cylinder,
      assets.playerHull,
      [side * 1.15, vertical * 0.05, -0.15],
      [0.11, 2.05, 0.11],
      [Math.PI / 2, 0, 0],
    );
    ship.add(wing);
  });

  [-0.62, 0.62].forEach((x) => {
    addPart(
      ship,
      assets.cylinder,
      assets.playerPanel,
      [x, -0.06, 0.72],
      [0.34, 1.25, 0.34],
      [Math.PI / 2, 0, 0],
    );
    const glow = new THREE.Sprite(assets.engineGlow);
    glow.position.set(x, -0.06, 1.42);
    glow.scale.set(0.85, 0.85, 1);
    ship.add(glow);
  });

  ship.scale.setScalar(1.15);
  return ship;
}

function createTieFighter(assets: SharedAssets) {
  const ship = new THREE.Group();
  addPart(ship, assets.sphere, assets.tieHull, [0, 0, 0], [0.82, 0.72, 0.82]);
  addPart(
    ship,
    assets.sphere,
    assets.canopy,
    [0, 0, -0.62],
    [0.48, 0.42, 0.18],
  );
  [-1, 1].forEach((side) => {
    addPart(
      ship,
      assets.cylinder,
      assets.tieHull,
      [side * 0.95, 0, 0],
      [0.11, 1.5, 0.11],
      [0, 0, Math.PI / 2],
    );
    addPart(
      ship,
      assets.box,
      assets.tiePanel,
      [side * 1.75, 0, 0],
      [0.12, 3.15, 2.35],
    );
    addPart(
      ship,
      assets.box,
      assets.tieHull,
      [side * 1.81, 0, 0],
      [0.05, 3.3, 0.09],
    );
    addPart(
      ship,
      assets.box,
      assets.tieHull,
      [side * 1.81, 0, 0],
      [0.05, 0.09, 2.5],
    );
  });
  const glow = new THREE.Sprite(assets.enemyGlow);
  glow.position.set(0, 0, 0.72);
  glow.scale.set(0.65, 0.65, 1);
  ship.add(glow);
  return ship;
}

function createTieInterceptor(assets: SharedAssets) {
  const ship = new THREE.Group();
  addPart(ship, assets.sphere, assets.tieHull, [0, 0, 0], [0.72, 0.62, 0.8]);
  addPart(
    ship,
    assets.sphere,
    assets.canopy,
    [0, 0, -0.64],
    [0.44, 0.37, 0.16],
  );
  [-1, 1].forEach((side) => {
    addPart(
      ship,
      assets.cylinder,
      assets.tieHull,
      [side * 0.85, 0, 0],
      [0.1, 1.35, 0.1],
      [0, 0, Math.PI / 2],
    );
    addPart(
      ship,
      assets.box,
      assets.interceptorPanel,
      [side * 1.6, 0.55, 0.24],
      [0.1, 1.95, 1.6],
      [0, 0, side * -0.2],
    );
    addPart(
      ship,
      assets.box,
      assets.interceptorPanel,
      [side * 1.6, -0.55, 0.24],
      [0.1, 1.95, 1.6],
      [0, 0, side * 0.2],
    );
    addPart(
      ship,
      assets.cylinder,
      assets.tieHull,
      [side * 1.8, 0.74, -1.22],
      [0.07, 1.65, 0.07],
      [Math.PI / 2, 0, 0],
    );
    addPart(
      ship,
      assets.cylinder,
      assets.tieHull,
      [side * 1.8, -0.74, -1.22],
      [0.07, 1.65, 0.07],
      [Math.PI / 2, 0, 0],
    );
  });
  const glow = new THREE.Sprite(assets.enemyGlow);
  glow.position.set(0, 0, 0.7);
  glow.scale.set(0.55, 0.55, 1);
  ship.add(glow);
  ship.scale.setScalar(0.92);
  return ship;
}

function createStealthBomber(assets: SharedAssets) {
  const ship = new THREE.Group();
  addPart(
    ship,
    assets.octahedron,
    assets.bomberHull,
    [0, -0.05, 0.1],
    [3.5, 0.52, 2.5],
    [0, Math.PI / 4, 0],
  );
  addPart(
    ship,
    assets.box,
    assets.bomberHull,
    [-2.65, 0, 0.5],
    [2.8, 0.18, 1.75],
    [0, 0.24, 0],
  );
  addPart(
    ship,
    assets.box,
    assets.bomberHull,
    [2.65, 0, 0.5],
    [2.8, 0.18, 1.75],
    [0, -0.24, 0],
  );
  addPart(
    ship,
    assets.sphere,
    assets.canopy,
    [0, 0.28, -1.08],
    [0.64, 0.24, 0.74],
  );
  addPart(
    ship,
    assets.box,
    assets.bomberEdge,
    [0, -0.31, -0.62],
    [4.65, 0.035, 0.08],
  );
  [-1.45, 1.45].forEach((x) => {
    const glow = new THREE.Sprite(assets.engineGlow);
    glow.position.set(x, 0, 1.55);
    glow.scale.set(0.62, 0.62, 1);
    ship.add(glow);
  });
  ship.scale.setScalar(1.15);
  return ship;
}
*/

function createCockpitRig(assets: SharedAssets) {
  const rig = new THREE.Group();
  addPart(
    rig,
    assets.box,
    assets.canopy,
    [0, -0.72, -1.22],
    [2.25, 0.48, 1.05],
  );
  addPart(
    rig,
    assets.box,
    assets.playerHull,
    [-0.95, 0, -1.75],
    [0.08, 2.1, 0.08],
    [0, 0, -0.38],
  );
  addPart(
    rig,
    assets.box,
    assets.playerHull,
    [0.95, 0, -1.75],
    [0.08, 2.1, 0.08],
    [0, 0, 0.38],
  );
  addPart(
    rig,
    assets.box,
    assets.playerHull,
    [0, 0.62, -1.9],
    [1.92, 0.07, 0.07],
  );
  rig.visible = false;
  return rig;
}

type Enemy = {
  id: number;
  active: boolean;
  kind: EnemyKind;
  group: THREE.Group;
  health: number;
  maxHealth: number;
  speed: number;
  cooldown: number;
  burst: number;
  phase: number;
  radius: number;
};

type Projectile = {
  active: boolean;
  friendly: boolean;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  damage: number;
};

type Explosion = {
  active: boolean;
  sprite: THREE.Sprite;
  life: number;
  duration: number;
  size: number;
};

type Asteroid = {
  position: THREE.Vector3;
  radius: number;
};

class SynthAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  private noise?: AudioBuffer;
  muted = false;

  ensure() {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const AudioContextCtor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextCtor) return;
    this.context = new AudioContextCtor();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.23;
    this.master.connect(this.context.destination);
    this.engine = this.context.createOscillator();
    this.engine.type = "sawtooth";
    this.engineGain = this.context.createGain();
    this.engineGain.gain.value = 0.035;
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    this.engine.connect(filter);
    filter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engine.start();

    this.noise = this.context.createBuffer(
      1,
      Math.floor(this.context.sampleRate * 0.6),
      this.context.sampleRate,
    );
    const channel = this.noise.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        muted ? 0 : 0.23,
        this.context.currentTime,
        0.03,
      );
    }
  }

  setEngine(speed: number, boost: boolean) {
    if (!this.engine || !this.engineGain || !this.context) return;
    this.engine.frequency.setTargetAtTime(
      54 + speed * 0.62 + (boost ? 32 : 0),
      this.context.currentTime,
      0.08,
    );
    this.engineGain.gain.setTargetAtTime(
      0.025 + speed * 0.00022,
      this.context.currentTime,
      0.08,
    );
  }

  laser(enemy = false) {
    if (!this.context || !this.master || this.muted) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = enemy ? "square" : "sawtooth";
    const now = this.context.currentTime;
    oscillator.frequency.setValueAtTime(enemy ? 240 : 760, now);
    oscillator.frequency.exponentialRampToValueAtTime(enemy ? 110 : 240, now + 0.1);
    gain.gain.setValueAtTime(enemy ? 0.035 : 0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.13);
  }

  impact(large = false) {
    if (!this.context || !this.master || !this.noise || this.muted) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    source.buffer = this.noise;
    filter.type = "lowpass";
    filter.frequency.value = large ? 360 : 900;
    gain.gain.setValueAtTime(large ? 0.18 : 0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (large ? 0.48 : 0.16));
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + (large ? 0.5 : 0.18));
  }

  suspend() {
    void this.context?.suspend();
  }

  dispose() {
    this.engine?.stop();
    void this.context?.close();
  }
}

type GameCallbacks = {
  onHud: (hud: HudSnapshot) => void;
  onStatus: (status: GameStatus) => void;
  onHighScore: (score: number) => void;
};

class DogfightEngine {
  readonly supported = true;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: GameCallbacks;
  private readonly modelLibrary: ShipModelLibrary;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly assets: SharedAssets;
  private readonly audio = new SynthAudio();
  private readonly renderer: THREE.WebGPURenderer;
  private resizeObserver?: ResizeObserver;
  private player!: THREE.Group;
  /** The visible ship, banked inside the flight frame. */
  private playerModel!: THREE.Group;
  private bankRoll = 0;
  /** The phone's roll from its calibrated neutral, as the bank that copies it. */
  private phoneBankRoll = 0;
  private cockpit!: THREE.Group;
  private sun!: THREE.DirectionalLight;
  private sunDisc!: THREE.Sprite;
  private stars!: THREE.Sprite;
  private asteroidMesh!: THREE.InstancedMesh;
  private playerLasers!: THREE.InstancedMesh;
  private enemyLasers!: THREE.InstancedMesh;
  private enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];
  private explosions: Explosion[] = [];
  private asteroids: Asteroid[] = [];
  private asteroidGrid = new Map<string, number[]>();
  private settings: GraphicsSettings;
  private modelDetail: "high" | "low";
  private status: GameStatus = "menu";
  private cameraMode: "CHASE" | "COCKPIT" = "CHASE";
  private keys = new Set<string>();
  private mouseXPercent = 0;
  private mouseYPercent = 0;
  private mouseFire = false;
  private touchFire = false;
  private touchBoost = false;
  private touchSteeringActive = false;
  private gyroPermission: GyroPermissionState = "prompt";
  private gyroPermissionRequest?: Promise<boolean>;
  private gyroBaseline: DeviceTilt = { pitch: 0, roll: 0 };
  private gyroHasBaseline = false;
  private rawGyroX = 0;
  private rawGyroY = 0;
  private gyroScreenAngle?: number;
  private gyroFilteredX = 0;
  private gyroFilteredY = 0;
  private wakeLock?: WakeLockHandle;
  private isTouchDevice = false;
  private sideways = false;
  private sidewaysRotation = 0;
  private sidewaysStartRotation = 0;
  private sidewaysTargetRotation = 0;
  private sidewaysTween = 1;
  private speedMultiplier = 4;
  private speed = 70;
  private boostRemaining = BOOST_MAX_SECONDS;
  private boostActive = false;
  private boostLocked = false;
  private boostBlend = 0;
  private readonly angularVelocity = new THREE.Vector3();
  private shields = 100;
  private hull = 100;
  private lastDamageTime = -20;
  private collisionCooldown = 0;
  private fireCooldown = 0;
  private muzzleSide = 1;
  private wave = 1;
  private score = 0;
  private waveDelay = 0;
  private elapsed = 0;
  private accumulator = 0;
  private lastRender = 0;
  private lastHud = 0;
  private frameSamples = 0;
  private frameSampleTime = 0;
  private fps = 60;
  private frameMs = 16.7;
  private effectiveScale = 1;
  private adaptiveTimer = 0;
  private diagnostics = false;
  private lastGamepadCamera = false;
  private lastGamepadSideways = false;
  private activeInput: HudSnapshot["input"] = "KEYBOARD + MOUSE";
  private disposed = false;
  private damageFlash = 0;
  private idleAngle = 0;
  private simulationTick = 0;

  private readonly tempV1 = new THREE.Vector3();
  private readonly tempV2 = new THREE.Vector3();
  private readonly tempV3 = new THREE.Vector3();
  private readonly tempQ1 = new THREE.Quaternion();
  private readonly tempEuler = new THREE.Euler();
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempObject = new THREE.Object3D();
  private readonly tempScale = new THREE.Vector3();
  private readonly renderSize = new THREE.Vector2();

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    settings: GraphicsSettings,
    modelLibrary: ShipModelLibrary,
    callbacks: GameCallbacks,
  ) {
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.scene = scene;
    this.camera = camera;
    this.settings = { ...settings };
    this.modelDetail = settings.quality === "low" ? "low" : "high";
    this.modelLibrary = modelLibrary;
    this.callbacks = callbacks;
    this.assets = new SharedAssets();

    this.camera.fov = 67;
    this.camera.near = 0.1;
    this.camera.far = 2200;
    this.camera.updateProjectionMatrix();
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    this.renderer.setClearColor(displayColor(SKY_COLOR), 1);
    this.scene.fog = new THREE.FogExp2(displayColor(0x06111d), 0.00052);

    this.buildWorld();
    this.bindEvents();
    this.applySettings(settings);
    this.resize();
    this.attachQaControls();
  }

  private get backend(): RenderBackend {
    return "isWebGPUBackend" in this.renderer.backend ? "webgpu" : "webgl2";
  }

  private attachQaControls() {
    if (!new URLSearchParams(window.location.search).has("qa")) return;
    window.__rogueVectorQa = {
      stageFleet: () => this.stageFleetInspection(),
      simulateGyro: (beta, gamma) => {
        this.gyroPermission = "granted";
        this.onDeviceOrientation(
          new DeviceOrientationEvent("deviceorientation", { beta, gamma }),
        );
      },
      steerForSteps: (steerX, steerY, steps) => {
        // Stands in for stick or mouse steering, as a real mouse move would.
        this.activeInput = "KEYBOARD + MOUSE";
        this.mouseXPercent = clamp(steerX, -1, 1);
        this.mouseYPercent = clamp(steerY, -1, 1);
        const boundedSteps = clamp(Math.floor(steps), 1, 360);
        for (let step = 0; step < boundedSteps; step += 1) {
          this.updatePlayer(FIXED_STEP, { fire: false, boost: false });
        }
      },
      // Holds the burner down for `steps` fixed updates and reports the
      // longest uninterrupted stretch, in seconds, that it stayed lit.
      boostForSteps: (steps) => {
        const boundedSteps = clamp(Math.floor(steps), 1, 6000);
        let longestRun = 0;
        let currentRun = 0;
        for (let step = 0; step < boundedSteps; step += 1) {
          this.updatePlayer(FIXED_STEP, { fire: false, boost: true });
          currentRun = this.boostActive ? currentRun + 1 : 0;
          longestRun = Math.max(longestRun, currentRun);
        }
        return longestRun * FIXED_STEP;
      },
      snapshot: () => {
        const activeEnemies = {
          fighter: 0,
          interceptor: 0,
          bomber: 0,
        };
        for (const enemy of this.enemies) {
          if (enemy.active) activeEnemies[enemy.kind] += 1;
        }
        const playerForward = this.tempV1
          .copy(LOCAL_FORWARD)
          .applyQuaternion(this.player.quaternion)
          .toArray();
        const playerRight = this.tempV1
          .set(1, 0, 0)
          .applyQuaternion(this.player.quaternion)
          .toArray();
        const playerUp = this.tempV1
          .set(0, 1, 0)
          .applyQuaternion(this.player.quaternion)
          .toArray();
        // The ship's own up vector, bank included, against the flight frame's
        // right: it leans one way or the other only when the model is banked.
        const shipUpDotFrameRight = this.tempV1
          .set(0, 1, 0)
          .applyEuler(this.playerModel.rotation)
          .applyQuaternion(this.player.quaternion)
          .dot(this.tempV2.fromArray(playerRight));
        return {
          status: this.status,
          quality: this.settings.quality,
          detail: this.modelDetail,
          backend: this.backend,
          touchDevice: this.isTouchDevice,
          gyroPermission: this.gyroPermission,
          gyro: {
            x: this.rawGyroX,
            y: this.rawGyroY,
            baseline: this.gyroHasBaseline,
          },
          activeEnemies,
          activeProjectiles: this.projectiles.filter(
            (projectile) => projectile.active,
          ).length,
          speed: this.speed,
          boostActive: this.boostActive,
          boostRemaining: this.boostRemaining,
          sideways: this.sideways,
          bankRoll: this.bankRoll,
          phoneBankRoll: this.phoneBankRoll,
          shipUpDotFrameRight,
          playerPosition: this.player.position.toArray(),
          playerForward,
          playerRight,
          playerUp,
          viewport: {
            width: this.canvas.clientWidth,
            height: this.canvas.clientHeight,
            cameraAspect: this.camera.aspect,
          },
        };
      },
    };
  }

  private stageFleetInspection() {
    this.clearActiveEntities();
    this.player.visible = true;
    this.player.position.set(-15, 0, -20);
    this.player.quaternion.identity();
    const positions: Record<EnemyKind, THREE.Vector3> = {
      fighter: new THREE.Vector3(-5, 0, -20),
      interceptor: new THREE.Vector3(5, 0, -20),
      bomber: new THREE.Vector3(16, 0, -20),
    };
    for (const kind of ["fighter", "interceptor", "bomber"] as const) {
      const enemy = this.enemies.find((candidate) => candidate.kind === kind);
      if (!enemy) continue;
      enemy.active = true;
      enemy.group.visible = true;
      enemy.group.position.copy(positions[kind]);
      enemy.group.quaternion.identity();
      enemy.speed = 0;
      enemy.cooldown = 999;
      enemy.health = 100;
    }
    this.cameraMode = "CHASE";
    this.cockpit.visible = false;
    this.camera.fov = 50;
    this.camera.position.set(0, 5, 24);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, -20);
    this.camera.updateProjectionMatrix();
    this.setStatus("paused");
  }

  private buildWorld() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    this.scene.add(new THREE.HemisphereLight(0x82b9d3, 0x172331, 2.2));
    this.sun = new THREE.DirectionalLight(0xe5f5ff, 4.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = SUN_LIGHT_DISTANCE - SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.far = SUN_LIGHT_DISTANCE + SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.left = -SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.right = SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.top = SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.bottom = -SUN_SHADOW_EXTENT;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.sun, this.sun.target);
    this.buildSunDisc();

    const rim = new THREE.PointLight(0x1b9ac4, 22, 700, 1.7);
    rim.position.set(260, -120, -300);
    this.scene.add(rim);

    this.buildStars();
    this.buildAsteroids();

    this.player = new THREE.Group();
    this.player.name = "player-flight-frame";
    this.playerModel = this.cloneShipModel("player");
    this.player.add(this.playerModel);
    this.player.add(new THREE.PointLight(0xb9eaff, 7, 42, 2));
    this.scene.add(this.player);
    this.cockpit = createCockpitRig(this.assets);
    this.camera.add(this.cockpit);
    this.scene.add(this.camera);

    this.buildEnemyPool();
    this.buildProjectilePool();
    this.buildExplosionPool();

    this.camera.position.set(0, 4, 12);
    this.camera.lookAt(0, 0, -20);
  }

  private buildSunDisc() {
    const material = new THREE.SpriteMaterial({
      map: this.assets.sunTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    this.sunDisc = new THREE.Sprite(material);
    this.sunDisc.scale.setScalar(SUN_SPRITE_DIAMETER);
    this.scene.add(this.sunDisc);
  }

  private updateSunPlacement() {
    this.sunDisc.position
      .copy(this.camera.position)
      .addScaledVector(SUN_DIRECTION, SUN_RENDER_DISTANCE);

    this.sun.target.position.copy(this.camera.position);
    this.sun.position
      .copy(this.camera.position)
      .addScaledVector(SUN_DIRECTION, SUN_LIGHT_DISTANCE);
  }

  private buildStars() {
    const random = seededRandom(2047);
    const positions = new Float32Array(6000 * 3);
    const colors = new Float32Array(6000 * 3);
    for (let index = 0; index < 6000; index += 1) {
      const radius = 650 + random() * 1100;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.cos(phi);
      positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      const tint = 0.72 + random() * 0.28;
      colors[index * 3] = tint * (random() > 0.88 ? 0.78 : 1);
      colors[index * 3 + 1] = tint * (random() > 0.82 ? 0.9 : 1);
      colors[index * 3 + 2] = tint;
    }
    // WebGPU point primitives are always one pixel, so each star is an
    // instanced sprite that grows as the ship closes on it.
    const material = new THREE.PointsNodeMaterial({
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    material.positionNode = instancedBufferAttribute<"vec3">(
      new THREE.InstancedBufferAttribute(positions, 3),
    );
    material.colorNode = instancedBufferAttribute<"vec3">(
      new THREE.InstancedBufferAttribute(colors, 3),
    );
    // Attenuate by half the canvas height like point primitives do, but
    // never below one device pixel, where a sprite would flicker out.
    material.sizeNode = max(
      float(STAR_SIZE)
        .mul(screenSize.y.div(screenDPR).mul(0.5))
        .div(positionView.z.negate()),
      float(1).div(screenDPR),
    );
    this.stars = new THREE.Sprite(material);
    this.stars.count = this.settings.starCount;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  private buildAsteroids() {
    const geometry = this.modelLibrary.asteroid.geometry;
    const material = this.modelLibrary.asteroid.material;
    this.asteroidMesh = new THREE.InstancedMesh(geometry, material, 560);
    this.asteroidMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.asteroidMesh.castShadow = true;
    this.asteroidMesh.receiveShadow = true;
    this.asteroidMesh.frustumCulled = true;

    const random = seededRandom(9917);
    for (let index = 0; index < 560; index += 1) {
      let x = 0;
      let y = 0;
      let z = 0;
      let distance = 0;
      do {
        x = (random() - 0.5) * 1450;
        y = (random() - 0.5) * 1450;
        z = (random() - 0.5) * 1450;
        distance = Math.hypot(x, y, z);
      } while (distance < 95 || distance > 830);
      const radius = 3.5 + Math.pow(random(), 1.8) * 16;
      const asteroid: Asteroid = {
        position: new THREE.Vector3(x, y, z),
        radius,
      };
      this.asteroids.push(asteroid);
      this.tempObject.position.copy(asteroid.position);
      this.tempObject.rotation.set(
        random() * Math.PI,
        random() * Math.PI,
        random() * Math.PI,
      );
      this.tempObject.scale.set(
        radius * (0.72 + random() * 0.48),
        radius * (0.72 + random() * 0.48),
        radius * (0.72 + random() * 0.48),
      );
      this.tempObject.updateMatrix();
      this.asteroidMesh.setMatrixAt(index, this.tempObject.matrix);
    }
    this.asteroidMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.asteroidMesh);
    this.rebuildAsteroidGrid();
  }

  private buildEnemyPool() {
    let id = 0;
    const add = (kind: EnemyKind, count: number) => {
      for (let index = 0; index < count; index += 1) {
        const group = this.cloneShipModel(kind);
        group.visible = false;
        group.matrixAutoUpdate = true;
        this.scene.add(group);
        this.enemies.push({
          id,
          active: false,
          kind,
          group,
          health: 0,
          maxHealth: 0,
          speed: 0,
          cooldown: 0,
          burst: 0,
          phase: Math.random() * Math.PI * 2,
          radius: kind === "bomber" ? 5.5 : 2.4,
        });
        id += 1;
      }
    };
    add("fighter", 10);
    add("interceptor", 7);
    add("bomber", 5);
  }

  private cloneShipModel(role: ShipRole) {
    const model = this.modelLibrary[this.modelDetail][role].clone(true);
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = this.settings.shadows;
        object.receiveShadow = true;
        object.frustumCulled = true;
      }
    });
    return model;
  }

  private replaceShipModels(detail: "high" | "low") {
    if (detail === this.modelDetail || !this.player) return;
    this.modelDetail = detail;

    const nextModel = this.cloneShipModel("player");
    nextModel.rotation.z = this.playerModel.rotation.z;
    this.player.remove(this.playerModel);
    this.playerModel = nextModel;
    this.player.add(this.playerModel);

    for (const enemy of this.enemies) {
      const nextGroup = this.cloneShipModel(enemy.kind);
      nextGroup.position.copy(enemy.group.position);
      nextGroup.quaternion.copy(enemy.group.quaternion);
      nextGroup.visible = enemy.group.visible;
      this.scene.remove(enemy.group);
      enemy.group = nextGroup;
      this.scene.add(enemy.group);
    }
  }

  private buildProjectilePool() {
    const geometry = new THREE.BoxGeometry(0.11, 0.11, 3.4);
    const friendlyMaterial = new THREE.MeshBasicMaterial({
      color: displayColor(0x61ff8f),
    });
    const enemyMaterial = new THREE.MeshBasicMaterial({
      color: displayColor(0xff4b32),
    });
    this.playerLasers = new THREE.InstancedMesh(
      geometry,
      friendlyMaterial,
      MAX_PROJECTILES,
    );
    this.enemyLasers = new THREE.InstancedMesh(
      geometry,
      enemyMaterial,
      MAX_PROJECTILES,
    );
    this.playerLasers.count = 0;
    this.enemyLasers.count = 0;
    this.playerLasers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.enemyLasers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.playerLasers.frustumCulled = false;
    this.enemyLasers.frustumCulled = false;
    this.scene.add(this.playerLasers, this.enemyLasers);
    for (let index = 0; index < MAX_PROJECTILES; index += 1) {
      this.projectiles.push({
        active: false,
        friendly: true,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        life: 0,
        damage: 0,
      });
    }
  }

  private buildExplosionPool() {
    for (let index = 0; index < MAX_EXPLOSIONS; index += 1) {
      const material = new THREE.SpriteMaterial({
        map: this.assets.glowTexture,
        color: 0xff7a2c,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      this.scene.add(sprite);
      this.explosions.push({
        active: false,
        sprite,
        life: 0,
        duration: 0,
        size: 0,
      });
    }
  }

  private bindEvents() {
    this.isTouchDevice =
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0);
    if (!this.isTouchDevice) this.gyroPermission = "unavailable";
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onCanvasMouseUp);
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    window.addEventListener("orientationchange", this.onScreenOrientationChange);
    window.addEventListener("touchstart", this.onTouchStart, { passive: true });
    window.addEventListener("touchmove", this.onTouchMove, { passive: true });
    window.addEventListener("touchend", this.onTouchEnd);
    window.addEventListener("resize", this.resize, { passive: true });
    window.visualViewport?.addEventListener("resize", this.resize, {
      passive: true,
    });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.canvas.addEventListener("mousedown", this.onCanvasMouseDown);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.canvas);
  }

  private onDeviceOrientation = (event: DeviceOrientationEvent) => {
    if (this.status !== "playing") return;

    const screenAngle =
      ((window.screen?.orientation?.angle ?? 0) % 360 + 360) % 360;
    // A baseline captured in one screen orientation is meaningless in another.
    if (this.gyroScreenAngle !== screenAngle) {
      this.gyroScreenAngle = screenAngle;
      this.gyroHasBaseline = false;
    }

    const tilt = deviceTiltFromOrientation(
      event.beta ?? 0,
      event.gamma ?? 0,
      screenAngle,
    );
    if (!this.gyroHasBaseline) {
      this.gyroBaseline = tilt;
      this.gyroHasBaseline = true;
      return;
    }

    const maxTiltDeg = 25;
    // Wrapped so a neutral near ±180° cannot read as a full turn.
    const rollDegrees =
      ((tilt.roll - this.gyroBaseline.roll + 540) % 360) - 180;
    const targetGyroX = clamp(rollDegrees / maxTiltDeg, -1, 1);
    const targetGyroY = clamp(
      (tilt.pitch - this.gyroBaseline.pitch) / maxTiltDeg,
      -1,
      1,
    );
    // Both axes share one smoothing constant: an axis that responds faster
    // than the other reads as cross-axis coupling even when the mapping is
    // clean, because the quicker axis is the one the player notices.
    const smoothing = 0.18;
    this.gyroFilteredX += (targetGyroX - this.gyroFilteredX) * smoothing;
    this.gyroFilteredY += (targetGyroY - this.gyroFilteredY) * smoothing;
    // Same smoothing again, so the bank and the turn it belongs to move as one.
    this.phoneBankRoll +=
      (-THREE.MathUtils.degToRad(rollDegrees) - this.phoneBankRoll) * smoothing;
    this.rawGyroX = this.gyroFilteredX;
    this.rawGyroY = this.gyroFilteredY;

    if (this.gyroPermission === "granted") {
      this.activeInput = "PHONE / GYRO";
      this.touchSteeringActive = false;
      this.mouseXPercent = deadzone(this.rawGyroX, 0.04);
      this.mouseYPercent = deadzone(-this.rawGyroY, 0.04);
    }
  };

  private onScreenOrientationChange = () => {
    this.calibrateGyro();
  };

  private onTouchStart = (event: TouchEvent) => {
    if (this.status === "playing" && this.gyroPermission === "prompt") {
      this.requestGyroPermission();
    }
    this.touchSteeringActive =
      !(event.target instanceof Element && event.target.closest(".touch-btn"));
  };

  private onTouchMove = (event: TouchEvent) => {
    if (this.status !== "playing") return;
    if (!this.touchSteeringActive || this.gyroPermission === "granted") return;
    const touch = event.touches[0];
    if (!touch) return;
    if (event.target instanceof Element && event.target.closest(".touch-btn")) {
      return;
    }
    const halfWidth = window.innerWidth / 2;
    const halfHeight = window.innerHeight / 2;
    this.mouseXPercent = clamp(
      ((touch.clientX - halfWidth) / (window.innerWidth / 2.3)) *
        this.settings.sensitivity,
      -1,
      1,
    );
    this.mouseYPercent = clamp(
      ((touch.clientY - halfHeight) / (window.innerHeight / 2.3)) *
        this.settings.sensitivity *
        (this.settings.invertY ? -1 : 1),
      -1,
      1,
    );
    this.activeInput = "TOUCH";
  };

  private onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length > 0) return;
    if (this.gyroPermission !== "granted") {
      this.mouseXPercent = 0;
      this.mouseYPercent = 0;
    }
    this.touchSteeringActive = false;
  };

  public calibrateGyro = () => {
    this.gyroHasBaseline = false;
    this.gyroScreenAngle = undefined;
    this.gyroFilteredX = 0;
    this.gyroFilteredY = 0;
    this.phoneBankRoll = 0;
    this.rawGyroX = 0;
    this.rawGyroY = 0;
  };

  public async requestGyroPermission(): Promise<boolean> {
    if (this.gyroPermission === "granted") return true;
    if (this.gyroPermissionRequest) return this.gyroPermissionRequest;
    const requestPermissionCandidate: unknown =
      Object.getOwnPropertyDescriptor(DeviceOrientationEvent, "requestPermission")
        ?.value;
    if (!isMotionPermissionRequest(requestPermissionCandidate)) {
      this.gyroPermission = "granted";
      this.calibrateGyro();
      return true;
    }

    this.gyroPermission = "requesting";
    const permissionRequest = requestPermissionCandidate()
      .then((state) => {
        const granted = state === "granted";
        this.gyroPermission = granted ? "granted" : "denied";
        if (granted) this.calibrateGyro();
        return granted;
      })
      .catch((error: unknown) => {
        console.error("Unable to request device orientation permission", error);
        this.gyroPermission = "denied";
        return false;
      })
      .finally(() => {
        this.gyroPermissionRequest = undefined;
      });
    this.gyroPermissionRequest = permissionRequest;
    return permissionRequest;
  }

  public setTouchFire = (active: boolean) => {
    this.touchFire = active;
    if (active) this.activeInput = "TOUCH";
  };

  public setTouchBoost = (active: boolean) => {
    this.touchBoost = active;
    if (active) this.activeInput = "TOUCH";
  };

  private onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.code);
    if (
      ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
        event.code,
      )
    ) {
      event.preventDefault();
    }
    if (event.repeat) return;
    if (event.code === "Escape") {
      if (this.status === "playing") this.pause();
      else if (this.status === "paused") this.resume();
    }
    if (event.code === "KeyC" && this.status === "playing") {
      this.toggleCamera();
    }
    if (event.code === "Space" && this.status === "playing") {
      this.toggleSideways();
    }
    if (event.code === "KeyP") {
      this.diagnostics = !this.diagnostics;
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  // Losing focus swallows the matching keyup, which would otherwise leave the
  // afterburner held down and silently drain the reservoir.
  private onBlur = () => {
    this.keys.clear();
    this.touchFire = false;
    this.touchBoost = false;
  };

  private onMouseMove = (event: MouseEvent) => {
    if (this.status !== "playing") return;
    const halfWidth = window.innerWidth / 2;
    const halfHeight = window.innerHeight / 2;
    this.mouseXPercent = clamp(
      ((event.clientX - halfWidth) / (window.innerWidth / 2.3)) *
        this.settings.sensitivity,
      -1,
      1,
    );
    const ySign = this.settings.invertY ? -1 : 1;
    this.mouseYPercent = clamp(
      ((event.clientY - halfHeight) / (window.innerHeight / 2.3)) *
        this.settings.sensitivity *
        ySign,
      -1,
      1,
    );
    this.activeInput = "KEYBOARD + MOUSE";
  };

  private onVisibility = () => {
    if (document.hidden && this.status === "playing") this.pause();
    if (!document.hidden && this.status === "paused") this.resetFlightInput();
    if (!document.hidden && this.status === "playing") this.requestWakeLock();
  };

  private resetFlightInput() {
    this.mouseXPercent = 0;
    this.mouseYPercent = 0;
    this.touchSteeringActive = false;
    this.calibrateGyro();
  }

  private onCanvasMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    if (this.status !== "playing") return;
    if (event.button === 2) this.mouseFire = true;
    else if (event.button === 0) this.toggleSideways();
  };

  private onCanvasMouseUp = (event: MouseEvent) => {
    if (event.button === 2) this.mouseFire = false;
  };

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  private resize = () => {
    if (!this.renderer) return;
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateRendererResolution(width, height);
  };

  applySettings(settings: GraphicsSettings) {
    const desiredDetail = settings.quality === "low" ? "low" : "high";
    this.settings = { ...settings };
    this.replaceShipModels(desiredDetail);
    this.audio.setMuted(settings.muted);
    this.effectiveScale = Math.min(
      this.effectiveScale || settings.renderScale,
      settings.renderScale,
    );
    if (this.asteroidMesh) {
      this.asteroidMesh.count = Math.min(
        settings.asteroidCount,
        this.isTouchDevice ? 320 : settings.asteroidCount,
      );
      this.asteroidMesh.castShadow = settings.shadows && !this.isTouchDevice;
      this.rebuildAsteroidGrid();
    }
    if (this.stars) {
      this.stars.count = Math.min(
        settings.starCount,
        this.isTouchDevice ? 3500 : settings.starCount,
      );
    }
    if (this.renderer) {
      this.renderer.shadowMap.enabled = settings.shadows && !this.isTouchDevice;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.sun.castShadow = settings.shadows && !this.isTouchDevice;
      this.updateRendererResolution();
    }
  }

  private updateRendererResolution(
    width = Math.max(1, Math.round(this.canvas.getBoundingClientRect().width)),
    height = Math.max(1, Math.round(this.canvas.getBoundingClientRect().height)),
  ) {
    if (!this.renderer) return;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      this.settings.maxDpr,
      this.isTouchDevice ? 1.25 : this.settings.maxDpr,
    );
    const pixelRatio = dpr * this.effectiveScale;
    if (Math.abs(this.renderer.getPixelRatio() - pixelRatio) > 0.001) {
      this.renderer.setPixelRatio(pixelRatio);
    }
    this.renderer.getSize(this.renderSize);
    if (this.renderSize.x !== width || this.renderSize.y !== height) {
      this.renderer.setSize(width, height, false);
    }
  }

  begin() {
    this.resetFlightInput();
    this.resetGame();
    this.audio.ensure();
    this.audio.setMuted(this.settings.muted);
    this.requestWakeLock();
    this.setStatus("playing");
  }

  restart() {
    this.begin();
  }

  pause() {
    if (this.status !== "playing") return;
    this.audio.suspend();
    this.releaseWakeLock();
    this.setStatus("paused");
  }

  resume() {
    if (this.status !== "paused") return;
    this.audio.ensure();
    this.accumulator = 0;
    this.resetFlightInput();
    this.requestWakeLock();
    this.setStatus("playing");
  }

  private requestWakeLock() {
    if (this.wakeLock || typeof navigator === "undefined") return;
    const wakeLockCandidate = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      "wakeLock",
    )?.get?.call(navigator);
    if (!isWakeLockManager(wakeLockCandidate)) return;
    void wakeLockCandidate
      .request("screen")
      .then((handle) => {
        if (this.status === "playing") {
          this.wakeLock = handle;
        } else {
          void handle.release().catch((error: unknown) => {
            console.debug("Screen wake lock release failed", error);
          });
        }
      })
      .catch((error: unknown) => {
        console.debug("Screen wake lock is unavailable", error);
      });
  }

  private releaseWakeLock() {
    const wakeLock = this.wakeLock;
    this.wakeLock = undefined;
    if (!wakeLock) return;
    void wakeLock.release().catch((error: unknown) => {
      console.debug("Screen wake lock release failed", error);
    });
  }

  showMenu() {
    this.clearActiveEntities();
    this.player.position.set(0, 0, 0);
    this.player.quaternion.identity();
    this.player.visible = true;
    this.cameraMode = "CHASE";
    this.cockpit.visible = false;
    this.setStatus("menu");
  }

  private setStatus(status: GameStatus) {
    this.status = status;
    this.callbacks.onStatus(status);
  }

  private resetGame() {
    this.clearActiveEntities();
    this.player.visible = true;
    this.player.position.set(0, 0, 0);
    this.player.quaternion.identity();
    this.mouseXPercent = 0;
    this.mouseYPercent = 0;
    this.mouseFire = false;
    this.sideways = false;
    this.sidewaysRotation = 0;
    this.bankRoll = 0;
    this.sidewaysStartRotation = 0;
    this.sidewaysTargetRotation = 0;
    this.sidewaysTween = 1;
    this.speedMultiplier = 4;
    this.speed = 70;
    this.boostRemaining = BOOST_MAX_SECONDS;
    this.boostActive = false;
    this.boostLocked = false;
    this.boostBlend = 0;
    this.angularVelocity.set(0, 0, 0);
    this.shields = 100;
    this.hull = 100;
    this.lastDamageTime = -20;
    this.collisionCooldown = 0;
    this.fireCooldown = 0;
    this.wave = 1;
    this.score = 0;
    this.waveDelay = 0;
    this.elapsed = 0;
    this.damageFlash = 0;
    this.cameraMode = "CHASE";
    this.cockpit.visible = false;
    this.spawnWave();
  }

  private clearActiveEntities() {
    this.enemies.forEach((enemy) => {
      enemy.active = false;
      enemy.group.visible = false;
    });
    this.projectiles.forEach((projectile) => {
      projectile.active = false;
    });
    this.explosions.forEach((explosion) => {
      explosion.active = false;
      explosion.sprite.visible = false;
    });
    if (this.playerLasers) this.playerLasers.count = 0;
    if (this.enemyLasers) this.enemyLasers.count = 0;
  }

  private spawnWave() {
    const desiredFighters = Math.min(2 + Math.ceil(this.wave * 0.75), 8);
    const desiredInterceptors =
      this.wave >= 2 ? Math.min(1 + Math.floor(this.wave / 2), 6) : 0;
    const desiredBombers =
      this.wave >= 3 ? Math.min(Math.floor(this.wave / 3), 4) : 0;
    const desiredTotal = Math.min(
      desiredFighters + desiredInterceptors + desiredBombers,
      MAX_ENEMIES,
    );
    let spawned = 0;
    const spawnKind = (kind: EnemyKind, count: number) => {
      for (let index = 0; index < count && spawned < desiredTotal; index += 1) {
        const enemy = this.enemies.find(
          (candidate) => !candidate.active && candidate.kind === kind,
        );
        if (!enemy) break;
        this.activateEnemy(enemy);
        spawned += 1;
      }
    };
    spawnKind("fighter", desiredFighters);
    spawnKind("interceptor", desiredInterceptors);
    spawnKind("bomber", desiredBombers);
  }

  private activateEnemy(enemy: Enemy) {
    const healthByKind = {
      fighter: 48 + this.wave * 2,
      interceptor: 36 + this.wave * 1.5,
      bomber: 132 + this.wave * 4,
    };
    const speedByKind = {
      fighter: 67 + Math.min(this.wave, 8) * 1.4,
      interceptor: 94 + Math.min(this.wave, 8) * 1.7,
      bomber: 49 + Math.min(this.wave, 8),
    };
    enemy.active = true;
    enemy.health = healthByKind[enemy.kind];
    enemy.maxHealth = enemy.health;
    enemy.speed = speedByKind[enemy.kind];
    enemy.cooldown = 0.6 + Math.random();
    enemy.burst = 0;
    enemy.group.visible = true;

    let attempts = 0;
    do {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 260 + Math.random() * 240;
      enemy.group.position.set(
        this.player.position.x + radius * Math.sin(phi) * Math.cos(theta),
        this.player.position.y + radius * Math.cos(phi) * 0.65,
        this.player.position.z + radius * Math.sin(phi) * Math.sin(theta),
      );
      attempts += 1;
    } while (this.positionHitsAsteroid(enemy.group.position, 18) && attempts < 12);
    this.tempV1.subVectors(this.player.position, enemy.group.position).normalize();
    enemy.group.quaternion.setFromUnitVectors(LOCAL_FORWARD, this.tempV1);
  }

  private toggleCamera() {
    this.cameraMode = this.cameraMode === "CHASE" ? "COCKPIT" : "CHASE";
    this.cockpit.visible = this.cameraMode === "COCKPIT";
    this.player.visible = this.cameraMode === "CHASE";
  }

  private toggleSideways() {
    this.sideways = !this.sideways;
    this.sidewaysStartRotation = this.sidewaysRotation;
    if (this.sideways) {
      this.sidewaysTargetRotation =
        this.mouseXPercent < 0 ? -Math.PI / 2 : Math.PI / 2;
    } else {
      this.sidewaysTargetRotation = 0;
    }
    this.sidewaysTween = 0;
  }

  frame(now: number, frameDelta: number) {
    if (this.disposed) return;
    const delta = Math.min(0.05, Math.max(0, frameDelta));

    if (this.status === "playing") {
      this.fixedUpdate(delta);
      this.updateCamera(delta);
      this.updateAdaptiveResolution(delta);
    } else {
      this.updateIdle(delta);
    }

    this.updateExplosions(delta);

    const targetInterval = 1000 / Math.max(30, this.settings.targetFps);
    if (now - this.lastRender < targetInterval * 0.84) return;
    const renderDelta = Math.min(
      0.1,
      Math.max(0, (now - this.lastRender) / 1000),
    );
    this.lastRender = now;
    this.frameSamples += 1;
    this.frameSampleTime += renderDelta;

    this.syncProjectileInstances();
    this.updateSunPlacement();
    this.renderer.render(this.scene, this.camera);

    if (this.frameSampleTime >= 0.75) {
      this.fps = this.frameSamples / this.frameSampleTime;
      this.frameMs = 1000 / Math.max(1, this.fps);
      this.frameSamples = 0;
      this.frameSampleTime = 0;
    }
    if (now - this.lastHud > 90) {
      this.lastHud = now;
      this.publishHud();
    }
  }

  private updateIdle(delta: number) {
    this.idleAngle += delta * 0.055;
    this.stars.rotation.y += delta * 0.002;
    if (this.status === "menu") {
      const radius = 18;
      this.camera.position.set(
        Math.sin(this.idleAngle) * radius,
        5.5 + Math.sin(this.idleAngle * 1.7) * 1.5,
        Math.cos(this.idleAngle) * radius,
      );
      this.camera.lookAt(0, 0, 0);
      this.player.visible = true;
      this.player.rotation.y += delta * 0.09;
      this.player.rotation.x = Math.sin(this.idleAngle * 1.3) * 0.08;
    }
  }

  private fixedUpdate(delta: number) {
    this.elapsed += delta;
    this.simulationTick += 1;
    this.fireCooldown = Math.max(0, this.fireCooldown - delta);
    this.collisionCooldown = Math.max(0, this.collisionCooldown - delta);
    this.damageFlash = Math.max(0, this.damageFlash - delta * 2.8);

    const input = this.readInput(delta);
    this.updatePlayer(delta, input);
    this.updateEnemies(delta);
    this.updateProjectiles(delta);
    this.updateShieldRegen(delta);

    if (this.activeEnemyCount() === 0) {
      this.waveDelay += delta;
      if (this.waveDelay > 2.2) {
        this.wave += 1;
        this.waveDelay = 0;
        this.spawnWave();
      }
    } else {
      this.waveDelay = 0;
    }
  }

  private readInput(delta: number) {
    const deltaMilliseconds = delta * 1000;
    if (this.keys.has("ArrowLeft")) {
      this.mouseXPercent -= 0.003 * deltaMilliseconds;
    }
    if (this.keys.has("ArrowRight")) {
      this.mouseXPercent += 0.003 * deltaMilliseconds;
    }
    if (this.keys.has("ArrowUp")) {
      this.mouseYPercent -= 0.0025 * deltaMilliseconds;
    }
    if (this.keys.has("ArrowDown")) {
      this.mouseYPercent += 0.0025 * deltaMilliseconds;
    }
    let fire =
      this.mouseFire ||
      this.touchFire ||
      this.keys.has("ControlLeft") ||
      this.keys.has("ControlRight");
    let boost =
      this.touchBoost ||
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight");

    const gamepads = navigator.getGamepads?.() ?? [];
    const gamepad = Array.from(gamepads).find(
      (candidate): candidate is Gamepad => Boolean(candidate?.connected),
    );
    if (gamepad) {
      const gamepadActive =
        gamepad.axes.some((axis) => Math.abs(axis) > 0.14) ||
        gamepad.buttons.some((button) => button.pressed);
      if (gamepadActive) {
        this.activeInput = "GAMEPAD";
        this.mouseXPercent = deadzone(gamepad.axes[0] ?? 0);
        this.mouseYPercent = deadzone(gamepad.axes[1] ?? 0);
      }
      fire ||= (gamepad.buttons[7]?.value ?? 0) > 0.25;
      boost ||= (gamepad.buttons[6]?.value ?? 0) > 0.25;
      const sidewaysPressed = Boolean(gamepad.buttons[0]?.pressed);
      if (sidewaysPressed && !this.lastGamepadSideways) this.toggleSideways();
      this.lastGamepadSideways = sidewaysPressed;
      const cameraPressed = Boolean(gamepad.buttons[3]?.pressed);
      if (cameraPressed && !this.lastGamepadCamera) this.toggleCamera();
      this.lastGamepadCamera = cameraPressed;
    } else {
      this.lastGamepadCamera = false;
      this.lastGamepadSideways = false;
    }

    this.mouseXPercent = clamp(this.mouseXPercent, -1, 1);
    this.mouseYPercent = clamp(this.mouseYPercent, -1, 1);
    return { fire, boost };
  }

  private updateBoost(delta: number, held: boolean) {
    if (held && !this.boostLocked && this.boostRemaining > 0) {
      this.boostActive = true;
      this.boostRemaining = Math.max(0, this.boostRemaining - delta);
      // Draining to empty locks the burner out until the reservoir has
      // recovered, so the pilot cannot chain two full-length burns.
      if (this.boostRemaining === 0) {
        this.boostActive = false;
        this.boostLocked = true;
      }
    } else {
      this.boostActive = false;
      this.boostRemaining = Math.min(
        BOOST_MAX_SECONDS,
        this.boostRemaining + delta * BOOST_RECHARGE_PER_SECOND,
      );
      if (this.boostLocked && this.boostRemaining >= BOOST_REARM_SECONDS) {
        this.boostLocked = false;
      }
    }

    this.boostBlend = THREE.MathUtils.damp(
      this.boostBlend,
      this.boostActive ? 1 : 0,
      BOOST_RESPONSE,
      delta,
    );
  }

  private updatePlayer(delta: number, input: { fire: boolean; boost: boolean }) {
    this.speedMultiplier = Math.min(9, this.speedMultiplier + 0.001);
    this.updateBoost(delta, input.boost);
    this.speed =
      this.speedMultiplier *
      REFERENCE_SPEED_SCALE *
      (1 + this.boostBlend * (BOOST_SPEED_FACTOR - 1));

    const previousProfileRotation = this.sidewaysRotation;
    if (this.sidewaysTween < 1) {
      this.sidewaysTween = Math.min(1, this.sidewaysTween + delta / 0.8);
      const exponentialOut =
        this.sidewaysTween >= 1
          ? 1
          : 1 - Math.pow(2, -10 * this.sidewaysTween);
      this.sidewaysRotation = THREE.MathUtils.lerp(
        this.sidewaysStartRotation,
        this.sidewaysTargetRotation,
        exponentialOut,
      );
    }

    const targetPitchRate = -this.mouseYPercent * MAX_PITCH_RATE;
    const targetYawRate = -this.mouseXPercent * MAX_YAW_RATE;
    this.angularVelocity.x = THREE.MathUtils.damp(
      this.angularVelocity.x,
      targetPitchRate,
      FLIGHT_CONTROL_RESPONSE,
      delta,
    );
    this.angularVelocity.y = THREE.MathUtils.damp(
      this.angularVelocity.y,
      targetYawRate,
      FLIGHT_CONTROL_RESPONSE,
      delta,
    );

    // Lay the ship over into the turn. On a phone it copies the phone's roll
    // exactly; that reading is already smoothed, and damping it again would
    // leave the ship trailing the hand. Other inputs bank in proportion to
    // the steering. Rotating the model rather than the flight frame keeps it
    // decorative: holding a turn never bends the climb input into a turn.
    this.bankRoll =
      this.activeInput === "PHONE / GYRO"
        ? this.phoneBankRoll
        : THREE.MathUtils.damp(
            this.bankRoll,
            -this.mouseXPercent * MAX_BANK_ROLL,
            BANK_ROLL_RESPONSE,
            delta,
          );
    this.playerModel.rotation.z = this.bankRoll;

    this.tempEuler.set(
      this.angularVelocity.x * delta,
      this.angularVelocity.y * delta,
      this.sidewaysRotation - previousProfileRotation,
      "XYZ",
    );
    this.tempQ1.setFromEuler(this.tempEuler);
    this.player.quaternion.multiply(this.tempQ1).normalize();

    const playerForward = this.tempV1
      .copy(LOCAL_FORWARD)
      .applyQuaternion(this.player.quaternion);
    this.player.position.addScaledVector(playerForward, this.speed * delta);
    this.audio.setEngine(this.speed, this.boostActive);

    if (input.fire && this.fireCooldown <= 0) {
      this.firePlayerLaser();
      this.fireCooldown = 0.115;
    }

    this.wrapFlightArena();
    this.checkPlayerAsteroidCollision();
  }

  private wrapFlightArena() {
    this.tempV1.set(0, 0, 0);
    const arenaSpan = ARENA_HALF_EXTENT * 2;
    for (const axis of ["x", "y", "z"] as const) {
      if (this.player.position[axis] > ARENA_HALF_EXTENT) {
        this.tempV1[axis] = -arenaSpan;
      } else if (this.player.position[axis] < -ARENA_HALF_EXTENT) {
        this.tempV1[axis] = arenaSpan;
      }
    }
    if (this.tempV1.lengthSq() === 0) return;

    this.player.position.add(this.tempV1);
    this.camera.position.add(this.tempV1);
    for (const enemy of this.enemies) {
      if (enemy.active) enemy.group.position.add(this.tempV1);
    }
    for (const projectile of this.projectiles) {
      if (projectile.active) projectile.position.add(this.tempV1);
    }
    for (const explosion of this.explosions) {
      if (explosion.active) explosion.sprite.position.add(this.tempV1);
    }
  }

  private firePlayerLaser() {
    this.muzzleSide *= -1;
    this.tempV1
      .set(
        this.muzzleSide * 2.75 * PLAYER_XWING_VISUAL_SCALE,
        this.muzzleSide * 0.58 * PLAYER_XWING_VISUAL_SCALE,
        -1.4 * PLAYER_XWING_VISUAL_SCALE,
      )
      .applyQuaternion(this.player.quaternion)
      .add(this.player.position);
    this.tempV2
      .copy(LOCAL_FORWARD)
      .applyQuaternion(this.player.quaternion)
      .multiplyScalar(285 + this.speed)
      .addScaledVector(
        this.tempV3.copy(LOCAL_FORWARD).applyQuaternion(this.player.quaternion),
        this.speed,
      );
    this.spawnProjectile(true, this.tempV1, this.tempV2, 28, 2.25);
    this.audio.laser(false);
  }

  private updateEnemies(delta: number) {
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      enemy.cooldown -= delta;
      const toPlayer = this.tempV1.subVectors(
        this.player.position,
        enemy.group.position,
      );
      const distance = toPlayer.length();
      toPlayer.multiplyScalar(1 / Math.max(distance, 0.001));

      const desired = this.tempV2.copy(toPlayer);
      const weaveStrength =
        enemy.kind === "interceptor" ? 0.52 : enemy.kind === "fighter" ? 0.25 : 0.12;
      desired.x += Math.sin(this.elapsed * 1.7 + enemy.phase) * weaveStrength;
      desired.y += Math.cos(this.elapsed * 1.25 + enemy.phase) * weaveStrength * 0.6;

      if (enemy.kind === "bomber" && distance < 190) {
        desired.addScaledVector(
          this.tempV3
            .set(Math.sin(enemy.phase), Math.cos(enemy.phase), 0)
            .normalize(),
          0.8,
        );
      }

      if (this.simulationTick % 3 === enemy.id % 3) {
        const nearby = this.findNearbyAsteroid(enemy.group.position, 28);
        if (nearby) {
          this.tempV3
            .subVectors(enemy.group.position, nearby.position)
            .normalize();
          desired.addScaledVector(this.tempV3, 1.65);
        }
      }

      desired.normalize();
      this.tempQ1.setFromUnitVectors(LOCAL_FORWARD, desired);
      const turnRate =
        enemy.kind === "interceptor" ? 1.75 : enemy.kind === "fighter" ? 1.18 : 0.72;
      enemy.group.quaternion.slerp(this.tempQ1, Math.min(1, turnRate * delta));
      this.tempV3
        .copy(LOCAL_FORWARD)
        .applyQuaternion(enemy.group.quaternion);
      enemy.group.position.addScaledVector(this.tempV3, enemy.speed * delta);

      if (enemy.kind === "bomber") {
        const cloakVisible =
          distance < 330 || Math.sin(this.elapsed * 1.4 + enemy.phase) > -0.25;
        enemy.group.visible = cloakVisible;
      } else {
        enemy.group.visible = true;
      }

      const aimDot = this.tempV3.dot(toPlayer);
      const aimThreshold =
        enemy.kind === "interceptor" ? 0.955 : enemy.kind === "bomber" ? 0.975 : 0.965;
      const range = enemy.kind === "bomber" ? 520 : 430;
      if (enemy.cooldown <= 0 && aimDot > aimThreshold && distance < range) {
        this.fireEnemyLaser(enemy);
      }
    }
  }

  private fireEnemyLaser(enemy: Enemy) {
    const forward = this.tempV1
      .copy(LOCAL_FORWARD)
      .applyQuaternion(enemy.group.quaternion);
    const position = this.tempV2
      .copy(enemy.group.position)
      .addScaledVector(forward, enemy.kind === "bomber" ? 4.8 : 2.3);
    const projectileSpeed =
      enemy.kind === "interceptor" ? 238 : enemy.kind === "bomber" ? 176 : 205;
    const damage = enemy.kind === "bomber" ? 28 : enemy.kind === "interceptor" ? 11 : 14;
    const velocity = this.tempV3.copy(forward).multiplyScalar(projectileSpeed);
    this.spawnProjectile(false, position, velocity, damage, 3.4);
    if (enemy.kind === "bomber") {
      this.tempV1.set(1, 0, 0).applyQuaternion(enemy.group.quaternion);
      this.tempV2.copy(position).addScaledVector(this.tempV1, 1.2);
      this.spawnProjectile(false, this.tempV2, velocity, damage, 3.4);
      enemy.cooldown = Math.max(1.55, 2.7 - this.wave * 0.05);
    } else if (enemy.kind === "interceptor") {
      enemy.burst += 1;
      if (enemy.burst >= 3) {
        enemy.burst = 0;
        enemy.cooldown = Math.max(0.78, 1.28 - this.wave * 0.03);
      } else {
        enemy.cooldown = 0.18;
      }
    } else {
      enemy.cooldown = Math.max(0.58, 1.05 - this.wave * 0.025);
    }
    if (Math.random() < 0.42) this.audio.laser(true);
  }

  private spawnProjectile(
    friendly: boolean,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    damage: number,
    life: number,
  ) {
    const projectile = this.projectiles.find((candidate) => !candidate.active);
    if (!projectile) return;
    projectile.active = true;
    projectile.friendly = friendly;
    projectile.position.copy(position);
    projectile.velocity.copy(velocity);
    projectile.damage = damage;
    projectile.life = life;
  }

  private updateProjectiles(delta: number) {
    for (const projectile of this.projectiles) {
      if (!projectile.active) continue;
      projectile.life -= delta;
      if (projectile.life <= 0) {
        projectile.active = false;
        continue;
      }
      projectile.position.addScaledVector(projectile.velocity, delta);

      if (projectile.friendly) {
        for (const enemy of this.enemies) {
          if (!enemy.active) continue;
          const hitRadius = enemy.radius + (projectile.damage > 25 ? 0.8 : 0);
          if (
            projectile.position.distanceToSquared(enemy.group.position) <
            hitRadius * hitRadius
          ) {
            projectile.active = false;
            enemy.health -= projectile.damage;
            this.spawnExplosion(projectile.position, 3.5);
            this.audio.impact(false);
            if (enemy.health <= 0) this.destroyEnemy(enemy);
            break;
          }
        }
      } else if (
        projectile.position.distanceToSquared(this.player.position) <
        3.4 * 3.4
      ) {
        projectile.active = false;
        this.spawnExplosion(projectile.position, projectile.damage > 20 ? 6 : 3);
        this.damagePlayer(projectile.damage);
      }
    }
  }

  private destroyEnemy(enemy: Enemy) {
    enemy.active = false;
    enemy.group.visible = false;
    const scoreByKind = {
      fighter: 110,
      interceptor: 175,
      bomber: 340,
    };
    this.score += scoreByKind[enemy.kind] * this.wave;
    this.spawnExplosion(
      enemy.group.position,
      enemy.kind === "bomber" ? 18 : 10,
    );
    this.audio.impact(true);
  }

  private damagePlayer(amount: number) {
    this.lastDamageTime = this.elapsed;
    this.damageFlash = 1;
    let remaining = amount;
    if (this.shields > 0) {
      const absorbed = Math.min(this.shields, remaining);
      this.shields -= absorbed;
      remaining -= absorbed;
    }
    if (remaining > 0) this.hull = Math.max(0, this.hull - remaining);
    this.audio.impact(amount > 20);
    if (this.hull <= 0) this.endGame();
  }

  private updateShieldRegen(delta: number) {
    if (this.elapsed - this.lastDamageTime > 4.2) {
      this.shields = Math.min(100, this.shields + delta * 7.5);
    }
  }

  private checkPlayerAsteroidCollision() {
    const nearby = this.findNearbyAsteroid(this.player.position, 4);
    if (!nearby) return;
    const minDistance = nearby.radius + 2.7;
    const distanceSquared = this.player.position.distanceToSquared(nearby.position);
    if (distanceSquared >= minDistance * minDistance) return;
    this.tempV1.subVectors(this.player.position, nearby.position);
    if (this.tempV1.lengthSq() < 0.001) this.tempV1.set(0, 1, 0);
    this.tempV1.normalize();
    this.player.position
      .copy(nearby.position)
      .addScaledVector(this.tempV1, minDistance + 0.5);
    if (this.collisionCooldown <= 0) {
      this.damagePlayer(Math.min(36, 12 + this.speed * 0.12));
      this.collisionCooldown = 0.85;
    }
  }

  private rebuildAsteroidGrid() {
    this.asteroidGrid.clear();
    const count = Math.min(
      this.settings.asteroidCount,
      this.asteroids.length,
    );
    for (let index = 0; index < count; index += 1) {
      const asteroid = this.asteroids[index];
      const key = this.gridKey(asteroid.position);
      const list = this.asteroidGrid.get(key);
      if (list) list.push(index);
      else this.asteroidGrid.set(key, [index]);
    }
  }

  private gridKey(position: THREE.Vector3) {
    const cell = 110;
    return `${Math.floor(position.x / cell)},${Math.floor(
      position.y / cell,
    )},${Math.floor(position.z / cell)}`;
  }

  private findNearbyAsteroid(position: THREE.Vector3, padding: number) {
    const cell = 110;
    const cx = Math.floor(position.x / cell);
    const cy = Math.floor(position.y / cell);
    const cz = Math.floor(position.z / cell);
    let closest: Asteroid | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let x = -1; x <= 1; x += 1) {
      for (let y = -1; y <= 1; y += 1) {
        for (let z = -1; z <= 1; z += 1) {
          const indices = this.asteroidGrid.get(`${cx + x},${cy + y},${cz + z}`);
          if (!indices) continue;
          for (const index of indices) {
            const asteroid = this.asteroids[index];
            const distance = position.distanceToSquared(asteroid.position);
            const threshold = asteroid.radius + padding;
            if (distance < threshold * threshold && distance < closestDistance) {
              closestDistance = distance;
              closest = asteroid;
            }
          }
        }
      }
    }
    return closest;
  }

  private positionHitsAsteroid(position: THREE.Vector3, padding: number) {
    return Boolean(this.findNearbyAsteroid(position, padding));
  }

  private spawnExplosion(position: THREE.Vector3, size: number) {
    const explosion = this.explosions.find((candidate) => !candidate.active);
    if (!explosion) return;
    explosion.active = true;
    explosion.life = 0;
    explosion.duration = 0.42 + size * 0.025;
    explosion.size = size * (0.72 + this.settings.effects * 0.45);
    explosion.sprite.visible = true;
    explosion.sprite.position.copy(position);
    explosion.sprite.scale.setScalar(0.1);
    const material = explosion.sprite.material as THREE.SpriteMaterial;
    material.opacity = 1;
  }

  private updateExplosions(delta: number) {
    for (const explosion of this.explosions) {
      if (!explosion.active) continue;
      explosion.life += delta;
      const progress = explosion.life / explosion.duration;
      if (progress >= 1) {
        explosion.active = false;
        explosion.sprite.visible = false;
        continue;
      }
      const scale =
        explosion.size * (0.3 + Math.sin(Math.min(1, progress) * Math.PI) * 1.2);
      explosion.sprite.scale.setScalar(scale);
      (explosion.sprite.material as THREE.SpriteMaterial).opacity =
        1 - progress * progress;
    }
  }

  private syncProjectileInstances() {
    if (!this.playerLasers || !this.enemyLasers) return;
    let friendlyCount = 0;
    let enemyCount = 0;
    for (const projectile of this.projectiles) {
      if (!projectile.active) continue;
      this.tempV1.copy(projectile.velocity).normalize();
      this.tempQ1.setFromUnitVectors(LOCAL_FORWARD, this.tempV1);
      const heavy = projectile.damage > 20 && !projectile.friendly;
      this.tempScale.set(heavy ? 2.1 : 1, heavy ? 2.1 : 1, heavy ? 1.45 : 1);
      this.tempMatrix.compose(
        projectile.position,
        this.tempQ1,
        this.tempScale,
      );
      if (projectile.friendly) {
        this.playerLasers.setMatrixAt(friendlyCount, this.tempMatrix);
        friendlyCount += 1;
      } else {
        this.enemyLasers.setMatrixAt(enemyCount, this.tempMatrix);
        enemyCount += 1;
      }
    }
    this.playerLasers.count = friendlyCount;
    this.enemyLasers.count = enemyCount;
    if (friendlyCount > 0) this.playerLasers.instanceMatrix.needsUpdate = true;
    if (enemyCount > 0) this.enemyLasers.instanceMatrix.needsUpdate = true;
  }

  private updateCamera(delta: number) {
    const targetFov =
      (this.cameraMode === "COCKPIT" ? 67 : 50) +
      this.boostBlend * BOOST_FOV_KICK;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, delta * 5);
    this.camera.updateProjectionMatrix();

    if (this.cameraMode === "CHASE") {
      const followAlpha = 1 - Math.exp(-delta * 8);
      const playerForward = this.tempV1
        .copy(LOCAL_FORWARD)
        .applyQuaternion(this.player.quaternion);
      const playerUp = this.tempV2
        .set(0, 1, 0)
        .applyQuaternion(this.player.quaternion);
      this.tempV3
        .copy(this.player.position)
        .addScaledVector(
          playerForward,
          -42 - this.boostBlend * BOOST_CHASE_PULLBACK,
        )
        .addScaledVector(playerUp, 15);
      this.camera.position.lerp(this.tempV3, followAlpha);
      this.camera.up.lerp(playerUp, followAlpha).normalize();
      this.tempV3
        .copy(this.player.position)
        .addScaledVector(playerForward, 120);
      this.camera.lookAt(this.tempV3);
    } else {
      this.camera.position
        .set(0, 0.54, -0.32)
        .applyQuaternion(this.player.quaternion)
        .add(this.player.position);
      // From inside the cockpit the ship is invisible, so the bank has to
      // show up as the horizon laying over instead.
      this.camera.quaternion
        .copy(this.player.quaternion)
        .multiply(
          this.tempQ1.setFromAxisAngle(LOCAL_ROLL_AXIS, this.bankRoll),
        );
      this.camera.up.set(0, 1, 0);
    }
  }

  private updateAdaptiveResolution(delta: number) {
    if (!this.settings.autoResolution) {
      if (Math.abs(this.effectiveScale - this.settings.renderScale) > 0.01) {
        this.effectiveScale = this.settings.renderScale;
        this.updateRendererResolution();
      }
      return;
    }
    this.adaptiveTimer += delta;
    if (this.adaptiveTimer < 2.2) return;
    this.adaptiveTimer = 0;
    const lowThreshold = this.settings.targetFps * 0.87;
    const highThreshold = this.settings.targetFps * 0.98;
    let next = this.effectiveScale;
    if (this.fps < lowThreshold) next = Math.max(0.5, next - 0.08);
    else if (this.fps > highThreshold)
      next = Math.min(this.settings.renderScale, next + 0.035);
    if (Math.abs(next - this.effectiveScale) > 0.01) {
      this.effectiveScale = next;
      this.updateRendererResolution();
    }
  }

  private activeEnemyCount() {
    let count = 0;
    for (const enemy of this.enemies) {
      if (enemy.active) count += 1;
    }
    return count;
  }

  private findTarget() {
    let target: Enemy | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    const playerForward = this.tempV1
      .copy(LOCAL_FORWARD)
      .applyQuaternion(this.player.quaternion);
    for (const enemy of this.enemies) {
      if (!enemy.active || !enemy.group.visible) continue;
      const direction = this.tempV2.subVectors(
        enemy.group.position,
        this.player.position,
      );
      const distance = direction.length();
      direction.multiplyScalar(1 / Math.max(0.001, distance));
      const dot = playerForward.dot(direction);
      if (dot < 0.2) continue;
      const score = distance * (1.5 - dot);
      if (score < bestScore) {
        bestScore = score;
        target = enemy;
      }
    }
    return target;
  }

  private publishHud() {
    if (!this.renderer) return;
    const radar: RadarContact[] = [];
    const inversePlayer = this.tempQ1.copy(this.player.quaternion).invert();
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      this.tempV1
        .subVectors(enemy.group.position, this.player.position)
        .applyQuaternion(inversePlayer);
      radar.push({
        id: enemy.id,
        x: clamp((this.tempV1.x / 560) * 45, -44, 44),
        y: clamp((this.tempV1.z / 560) * 45, -44, 44),
        kind: enemy.kind,
      });
    }

    const target = this.findTarget();
    let targetX = 50;
    let targetY = 50;
    let targetVisible = false;
    let targetDistance = 0;
    let targetLabel = "";
    if (target) {
      this.tempV1.copy(target.group.position).project(this.camera);
      targetX = (this.tempV1.x * 0.5 + 0.5) * 100;
      targetY = (-this.tempV1.y * 0.5 + 0.5) * 100;
      targetVisible =
        this.tempV1.z > -1 &&
        this.tempV1.z < 1 &&
        targetX > 3 &&
        targetX < 97 &&
        targetY > 3 &&
        targetY < 97;
      targetDistance = target.group.position.distanceTo(this.player.position);
      targetLabel =
        target.kind === "fighter"
          ? "TIE / LN"
          : target.kind === "interceptor"
            ? "TIE / IN"
            : "STEALTH BOMBER";
    }

    this.callbacks.onHud({
      shields: this.shields,
      hull: this.hull,
      speed: this.speed,
      engineRamp: clamp(((this.speedMultiplier - 4) / 5) * 100, 0, 100),
      boost: clamp((this.boostRemaining / BOOST_MAX_SECONDS) * 100, 0, 100),
      boostActive: this.boostActive,
      wave: this.wave,
      score: this.score,
      enemies: this.activeEnemyCount(),
      camera: this.cameraMode,
      targetX,
      targetY,
      targetVisible,
      targetLabel,
      targetDistance,
      radar,
      boundary: false,
      damage: this.damageFlash,
      fps: this.fps,
      frameMs: this.frameMs,
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
      renderScale: this.effectiveScale,
      diagnostics: this.diagnostics,
      input: this.activeInput,
      sideways: this.sideways,
      rawGyroX: this.rawGyroX,
      rawGyroY: this.rawGyroY,
      isTouchDevice: this.isTouchDevice,
      gyroPermission: this.gyroPermission,
      onFireStart: () => this.setTouchFire(true),
      onFireEnd: () => this.setTouchFire(false),
      onBoostStart: () => this.setTouchBoost(true),
      onBoostEnd: () => this.setTouchBoost(false),
      onToggleSideways: () => this.toggleSideways(),
      onToggleCamera: () => this.toggleCamera(),
      onCalibrateGyro: () => this.calibrateGyro(),
    });
  }

  private endGame() {
    this.setStatus("gameover");
    this.player.visible = false;
    this.spawnExplosion(this.player.position, 26);
    let highScore = this.score;
    try {
      const saved = Number(window.localStorage.getItem(SCORE_KEY) ?? 0);
      highScore = Math.max(saved, this.score);
      window.localStorage.setItem(SCORE_KEY, String(highScore));
    } catch {
      // Storage is optional; gameplay continues without persistence.
    }
    this.callbacks.onHighScore(highScore);
  }

  dispose() {
    this.disposed = true;
    this.releaseWakeLock();
    this.resizeObserver?.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onCanvasMouseUp);
    window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    window.removeEventListener("orientationchange", this.onScreenOrientationChange);
    window.removeEventListener("touchstart", this.onTouchStart);
    window.removeEventListener("touchmove", this.onTouchMove);
    window.removeEventListener("touchend", this.onTouchEnd);
    window.removeEventListener("resize", this.resize);
    window.visualViewport?.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("mousedown", this.onCanvasMouseDown);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.audio.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        materials.forEach((material) => material?.dispose());
      }
      if (object instanceof THREE.Sprite) object.material.dispose();
    });
    this.assets.dispose();
    disposeModelLibrary(this.modelLibrary);
    if (window.__rogueVectorQa) delete window.__rogueVectorQa;
  }
}

function GameRuntime({
  settings,
  callbacks,
  engineRef,
}: {
  settings: GraphicsSettings;
  callbacks: GameCallbacks;
  engineRef: { current: DogfightEngine | null };
}) {
  const renderer = useThree(
    (state) => state.gl,
  ) as unknown as THREE.WebGPURenderer;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const runtimeRef = useRef<DogfightEngine | null>(null);
  const latestSettings = useRef(settings);

  useFrame((state, delta) => {
    runtimeRef.current?.frame(state.clock.elapsedTime * 1000, delta);
  }, 1);

  // The renderer's own loop steps react-three-fiber, so three's per-frame
  // bookkeeping brackets every render. A manual frameloop reads seconds.
  useEffect(() => {
    void renderer.setAnimationLoop((time) => advance(time / 1000));
    return () => {
      void renderer.setAnimationLoop(null);
    };
  }, [renderer]);

  useEffect(() => {
    let cancelled = false;
    let localEngine: DogfightEngine | null = null;

    if (!(renderer instanceof THREE.WebGPURenderer)) {
      callbacks.onStatus("unsupported");
      return;
    }

    const isTouchDevice =
      "ontouchstart" in window || navigator.maxTouchPoints > 0;
    void loadShipModelLibrary(isTouchDevice)
      .then((library) => {
        if (cancelled) {
          disposeModelLibrary(library);
          return;
        }
        const engine = new DogfightEngine(
          renderer,
          scene,
          camera,
          latestSettings.current,
          library,
          callbacks,
        );
        localEngine = engine;
        runtimeRef.current = engine;
        engineRef.current = engine;
        callbacks.onStatus("menu");
      })
      .catch(() => {
        if (!cancelled) callbacks.onStatus("asseterror");
      });

    return () => {
      cancelled = true;
      localEngine?.dispose();
      if (runtimeRef.current === localEngine) runtimeRef.current = null;
      if (engineRef.current === localEngine) engineRef.current = null;
    };
  }, [callbacks, camera, engineRef, renderer, scene]);

  useEffect(() => {
    latestSettings.current = settings;
    runtimeRef.current?.applySettings(settings);
  }, [settings]);

  return null;
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GraphicsSettings;
  onChange: (settings: GraphicsSettings) => void;
  onClose: () => void;
}) {
  const updateCustom = <Key extends keyof GraphicsSettings>(
    key: Key,
    value: GraphicsSettings[Key],
  ) => {
    onChange({ ...settings, quality: "custom", [key]: value });
  };

  const selectPreset = (quality: QualityName) => {
    if (quality === "custom") return;
    const preset = QUALITY_PRESETS[quality];
    onChange({
      ...preset,
      sensitivity: settings.sensitivity,
      invertY: settings.invertY,
      muted: settings.muted,
    });
  };

  return (
    <div className="overlay">
      <section className="settings-panel" aria-label="Graphics and controls">
        <header className="settings-header">
          <div>
            <span className="menu-kicker">System configuration</span>
            <h2>Graphics & controls</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <div className="settings-grid">
          <label className="setting">
            <span>Quality preset</span>
            <select
              value={settings.quality}
              onChange={(event) =>
                selectPreset(event.target.value as QualityName)
              }
            >
              <option value="low">Lowest / Performance</option>
              <option value="medium">Medium</option>
              <option value="high">High / Recommended</option>
              <option value="ultra">Ultra</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          <label className="setting">
            <span>Frame target</span>
            <select
              value={settings.targetFps}
              onChange={(event) =>
                updateCustom("targetFps", Number(event.target.value))
              }
            >
              {[30, 60, 90, 120, 144].map((fps) => (
                <option key={fps} value={fps}>
                  {fps} FPS
                </option>
              ))}
            </select>
          </label>

          <label className="setting">
            <span>
              Render scale <output>{Math.round(settings.renderScale * 100)}%</output>
            </span>
            <input
              type="range"
              min="0.5"
              max="1"
              step="0.05"
              value={settings.renderScale}
              onChange={(event) =>
                updateCustom("renderScale", Number(event.target.value))
              }
            />
          </label>

          <label className="setting">
            <span>
              Pixel ratio cap <output>{settings.maxDpr.toFixed(2)}×</output>
            </span>
            <input
              type="range"
              min="0.75"
              max="2"
              step="0.25"
              value={settings.maxDpr}
              onChange={(event) =>
                updateCustom("maxDpr", Number(event.target.value))
              }
            />
          </label>

          <label className="setting">
            <span>
              Asteroid density <output>{settings.asteroidCount}</output>
            </span>
            <input
              type="range"
              min="80"
              max="560"
              step="20"
              value={settings.asteroidCount}
              onChange={(event) =>
                updateCustom("asteroidCount", Number(event.target.value))
              }
            />
          </label>

          <label className="setting">
            <span>
              Star density <output>{settings.starCount}</output>
            </span>
            <input
              type="range"
              min="800"
              max="6000"
              step="200"
              value={settings.starCount}
              onChange={(event) =>
                updateCustom("starCount", Number(event.target.value))
              }
            />
          </label>

          <label className="setting">
            <span>
              Effects density <output>{Math.round(settings.effects * 100)}%</output>
            </span>
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.05"
              value={settings.effects}
              onChange={(event) =>
                updateCustom("effects", Number(event.target.value))
              }
            />
          </label>

          <label className="setting">
            <span>
              Flight sensitivity <output>{settings.sensitivity.toFixed(1)}×</output>
            </span>
            <input
              type="range"
              min="0.5"
              max="1.8"
              step="0.1"
              value={settings.sensitivity}
              onChange={(event) =>
                updateCustom("sensitivity", Number(event.target.value))
              }
            />
          </label>

          <label className="setting toggle">
            <span className="setting-label">Adaptive resolution</span>
            <input
              type="checkbox"
              checked={settings.autoResolution}
              onChange={(event) =>
                updateCustom("autoResolution", event.target.checked)
              }
            />
          </label>

          <label className="setting toggle">
            <span className="setting-label">Dynamic shadows</span>
            <input
              type="checkbox"
              checked={settings.shadows}
              onChange={(event) => updateCustom("shadows", event.target.checked)}
            />
          </label>

          <label className="setting toggle">
            <span className="setting-label">Invert flight Y</span>
            <input
              type="checkbox"
              checked={settings.invertY}
              onChange={(event) => updateCustom("invertY", event.target.checked)}
            />
          </label>

          <label className="setting toggle">
            <span className="setting-label">Mute audio</span>
            <input
              type="checkbox"
              checked={settings.muted}
              onChange={(event) => updateCustom("muted", event.target.checked)}
            />
          </label>
        </div>

        <p className="settings-note">
          Changes apply live. Adaptive resolution adjusts only internal pixel
          density; combat simulation, enemy count, and scoring remain identical.
          Press P in flight to inspect frame timing and draw-call diagnostics.
        </p>
        <button className="primary-btn" onClick={onClose}>
          Apply configuration
        </button>
      </section>
    </div>
  );
}

function MobileGuidePanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay">
      <section className="pause-card mobile-guide-card" aria-label="Phone Setup Guide">
        <span className="menu-kicker">Mobile Local Playtest Guide</span>
        <h2>iPhone 13 Pro Setup</h2>
        <div className="mobile-guide-content">
          <ol className="mobile-guide-steps">
            <li>
              <strong>1. Connect Wi-Fi:</strong> Ensure iPhone 13 Pro is on the same local Wi-Fi network.
            </li>
            <li>
              <strong>2. Open Safari:</strong> Navigate to your desktop IP: <code>http://&lt;desktop-ip&gt;:3000</code>.
            </li>
            <li>
              <strong>3. Allow Motion:</strong> Tap <strong>Allow</strong> when iOS Safari requests Device Motion access.
            </li>
            <li>
              <strong>4. Calibrate Tilt:</strong> Hold your phone comfortably and tap <strong>CALIB TILT</strong> to set zero angle.
            </li>
          </ol>
          <div className="mobile-summary-box">
            <h4>Flight Gyro Controls:</h4>
            <ul>
              <li><strong>Turn Right / Left:</strong> Tilt phone to the right or left</li>
              <li><strong>Pitch Up (climb):</strong> Tilt top of phone toward you</li>
              <li><strong>Dive Down:</strong> Tilt bottom of phone up</li>
            </ul>
          </div>
        </div>
        <button className="primary-btn" onClick={onClose}>
          Return
        </button>
      </section>
    </div>
  );
}

function ControlsPanel({
  onClose,
  onOpenMobileGuide,
}: {
  onClose: () => void;
  onOpenMobileGuide?: () => void;
}) {
  return (
    <div className="overlay">
      <section className="pause-card controls-card-wide" aria-label="Controls">
        <span className="menu-kicker">Flight reference</span>
        <h2>Controls</h2>
        <div className="controls-grid controls-grid-3">
          <div className="control-card">
            <h3>Keyboard + mouse</h3>
            <div className="control-line">
              <span>Steer</span>
              <kbd>Mouse / arrows</kbd>
            </div>
            <div className="control-line">
              <span>90° profile roll</span>
              <kbd>Left click / Space</kbd>
            </div>
            <div className="control-line">
              <span>Fire cannon</span>
              <kbd>Right click / Ctrl</kbd>
            </div>
            <div className="control-line">
              <span>Afterburner</span>
              <kbd>Shift (10s hold)</kbd>
            </div>
            <div className="control-line">
              <span>Camera / diag</span>
              <kbd>C / P</kbd>
            </div>
          </div>

          <div className="control-card">
            <h3>Gamepad</h3>
            <div className="control-line">
              <span>Steer</span>
              <kbd>Left stick</kbd>
            </div>
            <div className="control-line">
              <span>90° profile roll</span>
              <kbd>A</kbd>
            </div>
            <div className="control-line">
              <span>Fire cannon</span>
              <kbd>RT</kbd>
            </div>
            <div className="control-line">
              <span>Afterburner</span>
              <kbd>LT</kbd>
            </div>
            <div className="control-line">
              <span>Camera</span>
              <kbd>Y</kbd>
            </div>
          </div>

          <div className="control-card">
            <h3>Phone / Gyro tilt</h3>
            <div className="control-line">
              <span>Turn right / left</span>
              <kbd>Tilt right / left</kbd>
            </div>
            <div className="control-line">
              <span>Pitch up (climb)</span>
              <kbd>Tilt top toward you</kbd>
            </div>
            <div className="control-line">
              <span>Dive down</span>
              <kbd>Tilt bottom up</kbd>
            </div>
            <div className="control-line">
              <span>Touch fire / boost</span>
              <kbd>On-screen buttons</kbd>
            </div>
            <div className="control-line">
              <span>Zero tilt angle</span>
              <kbd>Tap “CALIB TILT”</kbd>
            </div>
          </div>
        </div>

        <div className="pause-actions">
          {onOpenMobileGuide && (
            <button className="secondary-btn" onClick={onOpenMobileGuide}>
              iPhone Setup Guide
            </button>
          )}
          <button className="primary-btn" onClick={onClose}>
            Return
          </button>
        </div>
      </section>
    </div>
  );
}

function GameHud({ hud }: { hud: HudSnapshot }) {
  const contactColor = (kind: EnemyKind) =>
    kind === "bomber" ? "#72e9ff" : kind === "interceptor" ? "#ffb54a" : "#ff5c55";
  return (
    <div className={`hud ${
      hud.isTouchDevice ? "is-touch" : ""
    }`} aria-live="off">
      <div className="hud-top">
        <div className="hud-stat">
          Wave<strong>{String(hud.wave).padStart(2, "0")}</strong>
        </div>
        <div className="hud-stat">
          Hostiles<strong>{String(hud.enemies).padStart(2, "0")}</strong>
        </div>
        <div className="hud-stat">
          Score<strong>{hud.score.toLocaleString()}</strong>
        </div>
      </div>

      <div className="status-stack">
        <div className="system-label">
          <span>Deflector shields</span>
          <strong>{Math.round(hud.shields)}%</strong>
        </div>
        <div className="meter" style={{ "--bar": "#72e9ff" } as React.CSSProperties}>
          <span
            style={{ "--value": `${hud.shields}%` } as React.CSSProperties}
          />
        </div>
        <div className="system-label">
          <span>Hull integrity</span>
          <strong>{Math.round(hud.hull)}%</strong>
        </div>
        <div className="meter" style={{ "--bar": "#ffb54a" } as React.CSSProperties}>
          <span style={{ "--value": `${hud.hull}%` } as React.CSSProperties} />
        </div>
        <div className="system-label">
          <span>Engine ramp</span>
          <strong>{Math.round(hud.engineRamp)}%</strong>
        </div>
        <div className="meter">
          <span
            style={{ "--value": `${hud.engineRamp}%` } as React.CSSProperties}
          />
        </div>
        <div className="system-label">
          <span>Afterburner</span>
          <strong>{(hud.boost * 0.1).toFixed(1)}s</strong>
        </div>
        <div
          className={`meter${hud.boostActive ? " meter-active" : ""}`}
          style={{ "--bar": "#ff6b3d" } as React.CSSProperties}
        >
          <span style={{ "--value": `${hud.boost}%` } as React.CSSProperties} />
        </div>
        <div className="system-label">
          <span>Velocity</span>
          <strong>{Math.round(hud.speed)} M/S</strong>
        </div>
      </div>

      <div className="reticle" />

      <div
        className="target-lock"
        style={
          {
            "--target-x": `${hud.targetX}%`,
            "--target-y": `${hud.targetY}%`,
            "--target-visible": hud.targetVisible ? 1 : 0,
          } as React.CSSProperties
        }
      >
        <span>
          {hud.targetLabel}
          {" // "}
          {Math.round(hud.targetDistance)}M
        </span>
      </div>

      <div className="camera-mode">
        {hud.camera} CAM // {hud.input}
      </div>
      {hud.boundary && (
        <div className="boundary-warning">Warning // combat boundary</div>
      )}

      <span className="radar-label">Tactical proximity</span>
      <div className="radar">
        {hud.radar.map((contact) => (
          <i
            className="radar-dot"
            key={contact.id}
            style={
              {
                "--x": contact.x,
                "--y": contact.y,
                "--dot": contactColor(contact.kind),
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {hud.isTouchDevice && (
        <div className="touch-overlay">
        <div className="touch-top-bar">
          {/* Only worth the room while motion
          needs the player's attention. */}
          {hud.gyroPermission !== "granted" && (
            <span className="touch-motion-status">
              MOTION {hud.gyroPermission}
            </span>
          )}
          <button
            className="touch-btn touch-btn-util"
            onPointerDown={(e) => {
              e.preventDefault();
              hud.onCalibrateGyro?.();
            }}
          >
            <span>CALIB TILT</span>
          </button>
          <button
            className="touch-btn touch-btn-util"
            onPointerDown={(e) => {
              e.preventDefault();
              hud.onToggleCamera?.();
            }}
          >
            <span>CAM ({hud.camera})</span>
          </button>
        </div>

        <div className="touch-left-cluster">
          <button
            className={`touch-btn touch-btn-boost ${hud.boostActive ? "active" : ""}`}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              hud.onBoostStart?.();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.currentTarget.releasePointerCapture(e.pointerId);
              hud.onBoostEnd?.();
            }}
            onPointerCancel={(e) => {
              e.preventDefault();
              hud.onBoostEnd?.();
            }}
            onLostPointerCapture={() => hud.onBoostEnd?.()}
          >
            <span>BOOST</span>
          </button>
        </div>

        <div className="touch-right-cluster">
          <button
            className="touch-btn touch-btn-fire"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              hud.onFireStart?.();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.currentTarget.releasePointerCapture(e.pointerId);
              hud.onFireEnd?.();
            }}
            onPointerCancel={(e) => {
              e.preventDefault();
              hud.onFireEnd?.();
            }}
            onLostPointerCapture={() => hud.onFireEnd?.()}
          >
            <span>FIRE</span>
          </button>
        </div>
        </div>
      )}

      {hud.diagnostics && (
        <div className="perf-panel">
          <div>
            <span>FPS</span>
            <b>{hud.fps.toFixed(0)}</b>
          </div>
          <div>
            <span>Frame</span>
            <b>{hud.frameMs.toFixed(1)} ms</b>
          </div>
          <div>
            <span>Draw calls</span>
            <b>{hud.drawCalls}</b>
          </div>
          <div>
            <span>Triangles</span>
            <b>{Math.round(hud.triangles / 1000)}K</b>
          </div>
          <div>
            <span>Render scale</span>
            <b>{Math.round(hud.renderScale * 100)}%</b>
          </div>
        </div>
      )}
    </div>
  );
}

export function StarfighterGame() {
  const engineRef = useRef<DogfightEngine | null>(null);
  const [status, setStatus] = useState<GameStatus>("loading");
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);
  const [settings, setSettings] = useState<GraphicsSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showMobileGuide, setShowMobileGuide] = useState(false);
  const [highScore, setHighScore] = useState(loadHighScore);
  const [isPortrait, setIsPortrait] = useState(false);

  const callbacks = useMemo<GameCallbacks>(
    () => ({
      onHud: setHud,
      onStatus: setStatus,
      onHighScore: setHighScore,
    }),
    [],
  );
  const createRenderer = useMemo(
    () => createRendererFactory(() => setStatus("unsupported")),
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing may disable storage.
    }
  }, [settings]);

  useEffect(() => {
    const updateOrientation = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    updateOrientation();
    window.addEventListener("resize", updateOrientation, { passive: true });
    window.addEventListener("orientationchange", updateOrientation, {
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", updateOrientation);
      window.removeEventListener("orientationchange", updateOrientation);
    };
  }, []);

  useEffect(() => {
    // Publish the visual viewport - the part of the page the browser's own
    // chrome is not covering. Fixed elements are positioned against the
    // layout viewport, which on iOS Safari with `viewport-fit=cover` runs the
    // full height of the screen and therefore continues behind the tab bar,
    // so a height alone is not enough: the offset has to move with it or the
    // whole shell sits shifted off the visible area.
    const updateViewport = () => {
      const visual = window.visualViewport;
      const style = document.documentElement.style;
      style.setProperty(
        "--viewport-width",
        `${visual?.width ?? window.innerWidth}px`,
      );
      style.setProperty(
        "--viewport-height",
        `${visual?.height ?? window.innerHeight}px`,
      );
      style.setProperty("--viewport-offset-top", `${visual?.offsetTop ?? 0}px`);
      style.setProperty("--viewport-offset-left", `${visual?.offsetLeft ?? 0}px`);
    };
    updateViewport();
    window.addEventListener("resize", updateViewport, { passive: true });
    window.addEventListener("orientationchange", updateViewport, {
      passive: true,
    });
    window.visualViewport?.addEventListener("resize", updateViewport, {
      passive: true,
    });
    window.visualViewport?.addEventListener("scroll", updateViewport, {
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  const begin = useCallback(() => {
    setShowSettings(false);
    setShowControls(false);
    setShowMobileGuide(false);
    requestLandscapeLock();
    engineRef.current?.requestGyroPermission();
    engineRef.current?.begin();
  }, []);

  const openSettings = useCallback(() => {
    if (status === "playing") engineRef.current?.pause();
    setShowSettings(true);
  }, [status]);

  const openControls = useCallback(() => {
    if (status === "playing") engineRef.current?.pause();
    setShowControls(true);
  }, [status]);

  const openMobileGuide = useCallback(() => {
    if (status === "playing") engineRef.current?.pause();
    setShowControls(false);
    setShowMobileGuide(true);
  }, [status]);

  const closePanel = useCallback(() => {
    setShowSettings(false);
    setShowControls(false);
    setShowMobileGuide(false);
  }, []);

  const scoreLine = useMemo(
    () => `High score // ${highScore.toLocaleString()}`,
    [highScore],
  );

  return (
    <main className="game-shell">
      <div
        className={`game-canvas ${status !== "playing" ? "is-paused" : ""}`}
        aria-label="Rogue Vector 3D starfighter combat"
      >
        <Canvas
          camera={{ fov: 67, near: 0.1, far: 2200 }}
          dpr={1}
          frameloop="never"
          gl={createRenderer}
        >
          <GameRuntime
            settings={settings}
            callbacks={callbacks}
            engineRef={engineRef}
          />
        </Canvas>
      </div>
      <div className="vignette" />
      <div className="scanlines" />
      <div
        className="damage-flash"
        style={{ "--damage": hud.damage } as React.CSSProperties}
      />

      {hud.isTouchDevice && isPortrait && (
        <div className="orientation-gate">
          <section className="orientation-card" aria-label="Rotate phone">
            <span className="menu-kicker">Flight orientation</span>
            <h2>Turn your phone sideways</h2>
            <p>Rogue Vector plays in landscape mode.</p>
          </section>
        </div>
      )}

      {status === "loading" && (
        <div className="overlay">
          <section className="pause-card">
            <span className="menu-kicker">Loading glTF flight assets</span>
            <h2>Preparing hangar</h2>
            <p>
              Loading detailed fighter, interceptor, and bomber geometry…
            </p>
          </section>
        </div>
      )}

      {status === "playing" && <GameHud hud={hud} />}

      {status === "menu" && !showSettings && !showControls && !showMobileGuide && (
        <div className="overlay">
          <section className="menu">
            <span className="menu-kicker">XW / 77 combat simulator</span>
            <h1>
              Rogue <em>Vector</em>
            </h1>
            <p className="menu-copy">
              Break formation. Survive escalating Imperial attack waves through a
              live asteroid field. Three hostile signatures detected—each with a
              different flight doctrine.
            </p>
            <div className="threat-row">
              <span className="threat-chip">TIE fighter // pursuit</span>
              <span className="threat-chip">TIE interceptor // flanker</span>
              <span className="threat-chip">Stealth bomber // heavy</span>
            </div>
            <div className="menu-actions">
              <button className="primary-btn" onClick={begin}>
                Launch fighter
              </button>
              <button className="secondary-btn" onClick={openSettings}>
                Graphics
              </button>
              <button className="secondary-btn" onClick={openControls}>
                Controls
              </button>
              <button className="secondary-btn" onClick={openMobileGuide}>
                Phone Setup
              </button>
            </div>
            <footer className="menu-footer">
              <span>WebGPU // Desktop & Mobile gyro flight system</span>
              <span>{scoreLine}</span>
            </footer>
          </section>
        </div>
      )}

      {status === "paused" && !showSettings && !showControls && !showMobileGuide && (
        <div className="overlay">
          <section className="pause-card">
            <span className="menu-kicker">Flight suspended</span>
            <h2>Paused</h2>
            <p>Simulation held. Resume when your flight controls are ready.</p>
            <div className="pause-actions">
              <button
                className="primary-btn"
                onClick={() => engineRef.current?.resume()}
              >
                Resume
              </button>
              <button className="secondary-btn" onClick={openSettings}>
                Graphics
              </button>
              <button className="secondary-btn" onClick={openControls}>
                Controls
              </button>
              <button className="secondary-btn" onClick={openMobileGuide}>
                Phone Setup
              </button>
              <button
                className="secondary-btn"
                onClick={() => engineRef.current?.showMenu()}
              >
                Abort sortie
              </button>
            </div>
          </section>
        </div>
      )}

      {status === "gameover" && (
        <div className="overlay">
          <section className="pause-card">
            <span className="menu-kicker">Signal lost</span>
            <h2>Fighter destroyed</h2>
            <div className="score-large">{hud.score.toLocaleString()}</div>
            <p>
              Wave {hud.wave} reached // {scoreLine}
            </p>
            <div className="pause-actions">
              <button
                className="primary-btn"
                onClick={() => engineRef.current?.restart()}
              >
                Fly again
              </button>
              <button
                className="secondary-btn"
                onClick={() => engineRef.current?.showMenu()}
              >
                Main menu
              </button>
            </div>
          </section>
        </div>
      )}

      {status === "unsupported" && (
        <div className="overlay">
          <section className="pause-card unsupported">
            <span className="menu-kicker">Renderer unavailable</span>
            <h2>WebGPU or WebGL2 required</h2>
            <p>
              Rogue Vector renders with WebGPU and falls back to WebGL2 on
              desktop and mobile browsers (Chrome, Edge, Firefox, and Safari)
              with hardware acceleration enabled.
            </p>
          </section>
        </div>
      )}

      {status === "asseterror" && (
        <div className="overlay">
          <section className="pause-card unsupported">
            <span className="menu-kicker">Asset loading interrupted</span>
            <h2>Hangar unavailable</h2>
            <p>
              One or more local glTF ship assets could not be loaded. Refresh the
              page after confirming the development server is running.
            </p>
          </section>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={closePanel}
        />
      )}
      {showControls && (
        <ControlsPanel
          onClose={closePanel}
          onOpenMobileGuide={openMobileGuide}
        />
      )}
      {showMobileGuide && <MobileGuidePanel onClose={closePanel} />}
    </main>
  );
}
