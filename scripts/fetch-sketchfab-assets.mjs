import { execFileSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelDirectory = join(projectRoot, "public", "models");
const token = process.env.SKETCHFAB_API_TOKEN;

const assets = [
  {
    role: "player",
    uid: "a185c8bb6e9d43e4b597b856b176d768",
    expectedCreator: "chris_warstat",
    high: "xwing-high.glb",
    low: "xwing-low.glb",
  },
  {
    role: "fighter",
    uid: "722a39247ee84ed892bdc01e22bfbc36",
    expectedCreator: "Cristianolop",
    high: "tie-fighter-high.glb",
    low: "tie-fighter-low.glb",
  },
  {
    role: "interceptor",
    uid: "47222ad5bcff43fe868b65a06009e870",
    expectedCreator: "DanielAndersson",
    high: "tie-interceptor-high.glb",
    low: "tie-interceptor-low.glb",
  },
  {
    role: "bomber",
    uid: "9f7e360e2c074db1b9ccabd5dc4b8302",
    expectedCreator: "hilosrun",
    high: "stealth-bomber-high.glb",
    low: "stealth-bomber-low.glb",
  },
  {
    role: "asteroid",
    uid: "adde1ecf129e4509be8af61b84bafa85",
    expectedCreator: "SebastianSosnowski",
    high: "asteroid-high.glb",
  },
];

if (!token) {
  console.error(
    [
      "Sketchfab authentication is required to download these licensed models.",
      "Create an API token at https://sketchfab.com/settings/password and run:",
      "  SKETCHFAB_API_TOKEN=... npm run assets:sketchfab",
      "Keep the token in your shell environment; do not commit it.",
    ].join("\n"),
  );
  process.exit(1);
}

async function fetchJson(url, authenticated = false) {
  const response = await fetch(url, {
    headers: authenticated ? { Authorization: `Token ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

async function downloadFile(url, path) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function findModelFile(directory) {
  const candidates = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.toLowerCase().endsWith(".glb")) candidates.unshift(path);
      else if (entry.name.toLowerCase().endsWith(".gltf")) candidates.push(path);
    }
  };
  await visit(directory);
  return candidates[0];
}

function gltfTransform(...arguments_) {
  execFileSync("npm", ["exec", "--", "gltf-transform", ...arguments_], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function prepareStaticModel(input, output) {
  execFileSync(
    process.execPath,
    [join(projectRoot, "scripts", "prepare-static-gltf.mjs"), input, output],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );
}

async function unpackDownload(archivePath, outputDirectory) {
  const header = await readFile(archivePath);
  if (header.subarray(0, 4).toString("ascii") === "glTF") {
    const path = join(outputDirectory, "source.glb");
    await copyFile(archivePath, path);
    return path;
  }
  if (header[0] !== 0x50 || header[1] !== 0x4b) {
    throw new Error("Sketchfab returned an unsupported download format.");
  }
  execFileSync("unzip", ["-q", archivePath, "-d", outputDirectory], {
    stdio: "inherit",
  });
  const path = await findModelFile(outputDirectory);
  if (!path) throw new Error("The Sketchfab archive contains no glTF asset.");
  return path;
}

const tempRoot = await mkdtemp(join(tmpdir(), "rogue-vector-sketchfab-"));
const stagedModels = join(tempRoot, "models");
await mkdir(stagedModels, { recursive: true });
const attribution = [];

try {
  for (const asset of assets) {
    const modelUrl = `https://api.sketchfab.com/v3/models/${asset.uid}`;
    const metadata = await fetchJson(modelUrl);
    if (!metadata.isDownloadable) {
      throw new Error(`${metadata.name} is no longer downloadable.`);
    }
    if (metadata.user?.username !== asset.expectedCreator) {
      throw new Error(
        `Creator mismatch for ${asset.uid}; refusing an unreviewed replacement.`,
      );
    }
    if (metadata.license?.slug !== "by") {
      throw new Error(
        `${metadata.name} is no longer licensed CC Attribution; refusing download.`,
      );
    }

    console.log(`Downloading ${metadata.name} by ${metadata.user.username}…`);
    const downloads = await fetchJson(`${modelUrl}/download`, true);
    const converted = downloads.gltf ?? downloads.glb;
    if (!converted?.url) {
      throw new Error(`${metadata.name} has no converted glTF download.`);
    }

    const assetDirectory = join(tempRoot, asset.role);
    await mkdir(assetDirectory, { recursive: true });
    const archivePath = join(assetDirectory, "sketchfab-download");
    await downloadFile(converted.url, archivePath);
    const sourcePath = await unpackDownload(archivePath, assetDirectory);
    const highPath = join(stagedModels, asset.high);
    const copiedPath = join(assetDirectory, "copied.glb");
    const staticPath = join(assetDirectory, "static.glb");
    const deduplicatedPath = join(assetDirectory, "deduplicated.glb");
    const joinedPath = join(assetDirectory, "joined.glb");
    const geometryOptimizedPath = join(assetDirectory, "geometry-optimized.glb");
    const highResizedPath = join(assetDirectory, "high-resized.glb");
    gltfTransform("copy", sourcePath, copiedPath);
    prepareStaticModel(copiedPath, staticPath);
    gltfTransform("dedup", staticPath, deduplicatedPath);
    if (asset.role === "asteroid") {
      await copyFile(deduplicatedPath, joinedPath);
    } else {
      gltfTransform("join", deduplicatedPath, joinedPath);
    }
    gltfTransform(
      "reorder",
      joinedPath,
      geometryOptimizedPath,
      "--target",
      "performance",
    );
    gltfTransform(
      "resize",
      geometryOptimizedPath,
      highResizedPath,
      "--width",
      "2048",
      "--height",
      "2048",
    );
    gltfTransform(
      "webp",
      highResizedPath,
      highPath,
      "--quality",
      "92",
      "--effort",
      "85",
    );
    gltfTransform("validate", highPath);

    if (asset.low) {
      const weldedPath = join(assetDirectory, "welded.glb");
      gltfTransform("weld", geometryOptimizedPath, weldedPath);
      gltfTransform(
        "simplify",
        weldedPath,
        join(assetDirectory, "simplified.glb"),
        "--ratio",
        "0.18",
        "--error",
        "0.01",
      );
      const lowReorderedPath = join(assetDirectory, "low-reordered.glb");
      const lowResizedPath = join(assetDirectory, "low-resized.glb");
      gltfTransform(
        "reorder",
        join(assetDirectory, "simplified.glb"),
        lowReorderedPath,
        "--target",
        "performance",
      );
      gltfTransform(
        "resize",
        lowReorderedPath,
        lowResizedPath,
        "--width",
        "1024",
        "--height",
        "1024",
      );
      gltfTransform(
        "webp",
        lowResizedPath,
        join(stagedModels, asset.low),
        "--quality",
        "84",
        "--effort",
        "75",
      );
      gltfTransform("validate", join(stagedModels, asset.low));
    }

    attribution.push({
      role: asset.role,
      uid: metadata.uid,
      name: metadata.name,
      creator: metadata.user.username,
      modelUrl: metadata.viewerUrl,
      triangles: metadata.faceCount,
      vertices: metadata.vertexCount,
      license: metadata.license.label,
      licenseUrl: metadata.license.url,
      importedAt: new Date().toISOString(),
    });
  }

  await writeFile(
    join(stagedModels, "sketchfab-attribution.json"),
    `${JSON.stringify(attribution, null, 2)}\n`,
  );
  await mkdir(modelDirectory, { recursive: true });
  await cp(stagedModels, modelDirectory, { recursive: true, force: true });
  console.log(
    `Installed ${assets.length} reviewed Sketchfab sources in ${modelDirectory}.`,
  );
} finally {
  if (tempRoot.startsWith(tmpdir())) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
