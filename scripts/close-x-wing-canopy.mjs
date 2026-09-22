import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

/*
 * The Sketchfab X-wing is authored with its canopy hinged open for a pilot to
 * climb in, which reads as a parked ship rather than one in flight. The hood is
 * baked into the cockpit-window mesh with no joint to animate, so the only way
 * to fly a sealed ship is to rotate those vertices back onto the coaming.
 *
 * The hinge line runs along the mesh's local X axis through its origin, and the
 * raised hood leans forward from it at this angle, so rotating by the same
 * angle lays it flat in the frame. Both numbers were read off the hood's own
 * vertices and confirmed by rendering the result from every side.
 */
const canopyOpenAngle = (53.7 * Math.PI) / 180;

/*
 * The mesh also holds the fixed windscreen and sill. Everything that swings
 * with the hood - the hood itself, its frame and the struts propping it up -
 * reaches far above the sill when open, so shell height separates the two
 * cleanly: the tallest fixed shell tops out well under this, the shortest
 * moving one well over.
 */
const minimumCanopyHeight = 15;
const [input, output = input] = process.argv.slice(2);

if (!input) {
  const script = basename(fileURLToPath(import.meta.url));
  throw new Error(`Usage: node ${script} input.glb [output.glb]`);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(input);
const node = document
  .getRoot()
  .listNodes()
  .find((candidate) => candidate.getName().startsWith("cockpit_windows"));

if (!node) {
  throw new Error(`${input} has no cockpit_windows node to close.`);
}

for (const primitive of node.getMesh().listPrimitives()) {
  const position = primitive.getAttribute("POSITION");
  const normal = primitive.getAttribute("NORMAL");
  const tangent = primitive.getAttribute("TANGENT");
  const indices = primitive.getIndices();
  const count = position.getCount();

  // Group vertices into connected shells, welding coincident positions first so
  // a seam in the UVs does not split a shell in two.
  const parent = new Int32Array(count).map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };

  const union = (left, right) => {
    left = find(left);
    right = find(right);

    if (left !== right) parent[left] = right;
  };

  const firstAtPosition = new Map();
  const vertex = [0, 0, 0];

  for (let index = 0; index < count; index += 1) {
    position.getElement(index, vertex);

    const key = vertex.map((value) => Math.round(value * 1000)).join(",");
    const seen = firstAtPosition.get(key);

    if (seen === undefined) firstAtPosition.set(key, index);
    else union(index, seen);
  }

  for (let index = 0; index < indices.getCount(); index += 3) {
    const a = indices.getScalar(index);
    const b = indices.getScalar(index + 1);
    const c = indices.getScalar(index + 2);

    union(a, b);
    union(b, c);
  }

  const shellHeight = new Map();

  for (let index = 0; index < count; index += 1) {
    position.getElement(index, vertex);

    const shell = find(index);

    shellHeight.set(shell, Math.max(shellHeight.get(shell) ?? -Infinity, vertex[1]));
  }

  const cosine = Math.cos(canopyOpenAngle);
  const sine = Math.sin(canopyOpenAngle);
  const rotate = (attribute, index) => {
    const element = new Array(attribute.getElementSize()).fill(0);

    attribute.getElement(index, element);

    const [, y, z] = element;

    element[1] = y * cosine - z * sine;
    element[2] = y * sine + z * cosine;

    attribute.setElement(index, element);
  };

  let closed = 0;

  for (let index = 0; index < count; index += 1) {
    if ((shellHeight.get(find(index)) ?? 0) <= minimumCanopyHeight) continue;

    closed += 1;

    rotate(position, index);

    if (normal) rotate(normal, index);
    if (tangent) rotate(tangent, index);
  }

  console.log(`${input}: closed ${closed} of ${count} canopy vertices.`);
}

await io.write(output, document);
