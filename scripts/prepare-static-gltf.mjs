import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error("Usage: node prepare-static-gltf.mjs input.glb output.glb");
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(input);
const root = document.getRoot();

for (const animation of root.listAnimations()) animation.dispose();
for (const camera of root.listCameras()) camera.dispose();

await io.write(output, document);

