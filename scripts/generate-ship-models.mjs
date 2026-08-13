import { mkdir, writeFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

class NodeFileReader {
  result = null;
  onloadend = null;
  onerror = null;

  readAsArrayBuffer(blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }

  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }
}

globalThis.FileReader = NodeFileReader;

const outputDirectory = new URL("../public/models/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });

const materials = {
  rebelHull: new THREE.MeshStandardMaterial({
    name: "Rebel Hull Ceramic",
    color: 0xb9beb9,
    roughness: 0.52,
    metalness: 0.42,
  }),
  rebelDark: new THREE.MeshStandardMaterial({
    name: "Rebel Mechanical",
    color: 0x35434a,
    roughness: 0.4,
    metalness: 0.72,
  }),
  rebelAccent: new THREE.MeshStandardMaterial({
    name: "Squadron Red",
    color: 0x8e271f,
    roughness: 0.58,
    metalness: 0.3,
  }),
  canopy: new THREE.MeshStandardMaterial({
    name: "Canopy Glass",
    color: 0x132a36,
    roughness: 0.12,
    metalness: 0.86,
    emissive: 0x06131a,
    emissiveIntensity: 0.55,
  }),
  engineBlue: new THREE.MeshStandardMaterial({
    name: "Ion Engine Blue",
    color: 0x8de9ff,
    roughness: 0.18,
    metalness: 0.18,
    emissive: 0x159fd8,
    emissiveIntensity: 5,
  }),
  imperialHull: new THREE.MeshStandardMaterial({
    name: "Imperial Alloy",
    color: 0x707a7d,
    roughness: 0.4,
    metalness: 0.75,
  }),
  imperialPanel: new THREE.MeshStandardMaterial({
    name: "Solar Array",
    color: 0x070b10,
    roughness: 0.68,
    metalness: 0.4,
    emissive: 0x040a11,
    emissiveIntensity: 0.35,
  }),
  interceptorPanel: new THREE.MeshStandardMaterial({
    name: "Interceptor Solar Array",
    color: 0x120b0d,
    roughness: 0.55,
    metalness: 0.48,
    emissive: 0x250302,
    emissiveIntensity: 0.55,
  }),
  engineRed: new THREE.MeshStandardMaterial({
    name: "Imperial Engine",
    color: 0xff6b48,
    roughness: 0.2,
    metalness: 0.15,
    emissive: 0xff2a12,
    emissiveIntensity: 4,
  }),
  stealthHull: new THREE.MeshStandardMaterial({
    name: "Radar Absorbent Hull",
    color: 0x101a1f,
    roughness: 0.26,
    metalness: 0.88,
  }),
  stealthEdge: new THREE.MeshStandardMaterial({
    name: "Stealth Edge Lighting",
    color: 0x365c64,
    roughness: 0.22,
    metalness: 0.75,
    emissive: 0x0a7a8b,
    emissiveIntensity: 2.2,
  }),
};

function mesh(
  geometry,
  material,
  name,
  position = [0, 0, 0],
  scale = [1, 1, 1],
  rotation = [0, 0, 0],
) {
  const value = new THREE.Mesh(geometry, material);
  value.name = name;
  value.position.set(...position);
  value.scale.set(...scale);
  value.rotation.set(...rotation);
  value.castShadow = true;
  value.receiveShadow = true;
  return value;
}

function detailBox(root, name, position, scale, material = materials.rebelDark) {
  root.add(
    mesh(
      new THREE.BoxGeometry(1, 1, 1),
      material,
      name,
      position,
      scale,
    ),
  );
}

function createXWing(detail) {
  const high = detail === "high";
  const radial = high ? 24 : 8;
  const root = new THREE.Group();
  root.name = `RV-X77-${detail}`;
  root.userData = { role: "player", detail, format: "glTF 2.0" };

  root.add(
    mesh(
      new THREE.CylinderGeometry(0.43, 0.34, 5.15, radial),
      materials.rebelHull,
      "Main fuselage",
      [0, 0, 0.15],
      [1, 1, 1],
      [Math.PI / 2, 0, 0],
    ),
    mesh(
      new THREE.ConeGeometry(0.42, 1.95, radial),
      materials.rebelHull,
      "Armored nose",
      [0, 0, -3.35],
      [1, 1, 1],
      [-Math.PI / 2, 0, 0],
    ),
    mesh(
      new THREE.SphereGeometry(1, high ? 24 : 8, high ? 14 : 6),
      materials.canopy,
      "Pilot canopy",
      [0, 0.4, -0.62],
      [0.54, 0.34, 0.82],
    ),
  );

  if (high) {
    root.add(
      mesh(
        new THREE.SphereGeometry(1, 16, 10),
        materials.rebelHull,
        "Astromech socket",
        [0, 0.48, 0.75],
        [0.3, 0.26, 0.3],
      ),
    );
    for (let index = 0; index < 8; index += 1) {
      detailBox(
        root,
        `Fuselage service panel ${index + 1}`,
        [
          (index % 2 ? 1 : -1) * 0.37,
          0.1 + (index % 3) * 0.08,
          -1.7 + index * 0.48,
        ],
        [0.035, 0.19, 0.28],
        index % 3 === 0 ? materials.rebelAccent : materials.rebelDark,
      );
    }
  }

  const wingData = [
    [-1, 1, 1],
    [1, 1, -1],
    [-1, -1, -1],
    [1, -1, 1],
  ];
  wingData.forEach(([side, vertical, cant], wingIndex) => {
    const wing = new THREE.Group();
    wing.name = `S-foil ${wingIndex + 1}`;
    wing.position.set(side * 1.38, vertical * 0.34, 0.28);
    wing.rotation.z = cant * 0.145;
    wing.add(
      mesh(
        new THREE.BoxGeometry(1, 1, 1),
        materials.rebelHull,
        "Wing armor",
        [0, 0, 0],
        [2.75, 0.11, 1.15],
      ),
      mesh(
        new THREE.BoxGeometry(1, 1, 1),
        materials.rebelAccent,
        "Wing squadron stripe",
        [side * 0.22, vertical * 0.07, -0.15],
        [1.72, 0.035, 0.13],
      ),
      mesh(
        new THREE.CylinderGeometry(0.11, 0.09, 2.25, radial),
        materials.rebelDark,
        "Laser cannon",
        [side * 1.22, vertical * 0.05, -0.2],
        [1, 1, 1],
        [Math.PI / 2, 0, 0],
      ),
      mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.42, radial),
        materials.rebelHull,
        "Cannon emitter",
        [side * 1.22, vertical * 0.05, -1.48],
        [1, 1, 1],
        [Math.PI / 2, 0, 0],
      ),
    );
    if (high) {
      for (let rib = 0; rib < 4; rib += 1) {
        detailBox(
          wing,
          `Wing structural rib ${rib + 1}`,
          [side * (-0.95 + rib * 0.56), vertical * 0.076, 0.18],
          [0.055, 0.024, 0.72],
        );
      }
    }
    root.add(wing);
  });

  [-0.64, 0.64].forEach((x, engineIndex) => {
    root.add(
      mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 1.45, radial),
        materials.rebelDark,
        `Engine housing ${engineIndex + 1}`,
        [x, -0.04, 0.78],
        [1, 1, 1],
        [Math.PI / 2, 0, 0],
      ),
      mesh(
        new THREE.CylinderGeometry(0.22, 0.22, 0.09, radial),
        materials.engineBlue,
        `Engine emitter ${engineIndex + 1}`,
        [x, -0.04, 1.54],
        [1, 1, 1],
        [Math.PI / 2, 0, 0],
      ),
    );
  });
  root.scale.setScalar(1.15);
  return root;
}

function createTieFighter(detail) {
  const high = detail === "high";
  const radial = high ? 24 : 8;
  const root = new THREE.Group();
  root.name = `TIE-LN-${detail}`;
  root.userData = { role: "fighter", detail, format: "glTF 2.0" };
  root.add(
    mesh(
      new THREE.SphereGeometry(0.82, radial, high ? 16 : 6),
      materials.imperialHull,
      "Armored cockpit",
    ),
    mesh(
      new THREE.SphereGeometry(1, radial, high ? 12 : 6),
      materials.canopy,
      "Forward viewport",
      [0, 0, -0.69],
      [0.48, 0.43, 0.18],
    ),
    mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.1, radial),
      materials.engineRed,
      "Ion engine",
      [0, 0, 0.82],
      [1, 1, 1],
      [Math.PI / 2, 0, 0],
    ),
  );

  [-1, 1].forEach((side, panelIndex) => {
    root.add(
      mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 1.7, radial),
        materials.imperialHull,
        `Panel strut ${panelIndex + 1}`,
        [side * 0.98, 0, 0],
        [1, 1, 1],
        [0, 0, Math.PI / 2],
      ),
      mesh(
        new THREE.CylinderGeometry(1.65, 1.65, 0.13, 6),
        materials.imperialPanel,
        `Hexagonal solar panel ${panelIndex + 1}`,
        [side * 1.84, 0, 0],
        [1, 1, 1],
        [0, 0, Math.PI / 2],
      ),
      mesh(
        new THREE.TorusGeometry(1.18, 0.045, high ? 8 : 4, high ? 24 : 8),
        materials.imperialHull,
        `Solar panel frame ${panelIndex + 1}`,
        [side * 1.92, 0, 0],
        [1, 1, 1],
        [0, Math.PI / 2, 0],
      ),
    );
    if (high) {
      for (let rib = 0; rib < 6; rib += 1) {
        const angle = (rib / 6) * Math.PI * 2;
        root.add(
          mesh(
            new THREE.BoxGeometry(1, 1, 1),
            materials.imperialHull,
            `Solar rib ${panelIndex + 1}.${rib + 1}`,
            [side * 1.92, Math.sin(angle) * 0.76, Math.cos(angle) * 0.76],
            [0.04, 1.55, 0.045],
            [angle, 0, 0],
          ),
        );
      }
    }
  });
  return root;
}

function createTieInterceptor(detail) {
  const high = detail === "high";
  const radial = high ? 24 : 8;
  const root = new THREE.Group();
  root.name = `TIE-IN-${detail}`;
  root.userData = { role: "interceptor", detail, format: "glTF 2.0" };
  root.add(
    mesh(
      new THREE.SphereGeometry(0.72, radial, high ? 14 : 6),
      materials.imperialHull,
      "Interceptor cockpit",
    ),
    mesh(
      new THREE.SphereGeometry(1, radial, high ? 12 : 6),
      materials.canopy,
      "Forward viewport",
      [0, 0, -0.66],
      [0.44, 0.38, 0.16],
    ),
    mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.08, radial),
      materials.engineRed,
      "High-output ion engine",
      [0, 0, 0.74],
      [1, 1, 1],
      [Math.PI / 2, 0, 0],
    ),
  );

  [-1, 1].forEach((side, sideIndex) => {
    root.add(
      mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 1.5, radial),
        materials.imperialHull,
        `Wing strut ${sideIndex + 1}`,
        [side * 0.86, 0, 0],
        [1, 1, 1],
        [0, 0, Math.PI / 2],
      ),
    );
    [-1, 1].forEach((vertical, bladeIndex) => {
      root.add(
        mesh(
          new THREE.BoxGeometry(1, 1, 1),
          materials.interceptorPanel,
          `Dagger solar wing ${sideIndex + 1}.${bladeIndex + 1}`,
          [side * 1.72, vertical * 0.58, 0.22],
          [0.12, 2.15, 1.76],
          [0, side * vertical * -0.12, side * vertical * 0.19],
        ),
        mesh(
          new THREE.CylinderGeometry(0.07, 0.055, 1.9, radial),
          materials.imperialHull,
          `Wingtip cannon ${sideIndex + 1}.${bladeIndex + 1}`,
          [side * 1.94, vertical * 0.82, -1.25],
          [1, 1, 1],
          [Math.PI / 2, 0, 0],
        ),
      );
      if (high) {
        for (let rib = 0; rib < 3; rib += 1) {
          detailBox(
            root,
            `Interceptor rib ${sideIndex + 1}.${bladeIndex + 1}.${rib + 1}`,
            [side * 1.81, vertical * (0.18 + rib * 0.46), 0.22],
            [0.045, 0.055, 1.48],
            materials.imperialHull,
          );
        }
      }
    });
  });
  root.scale.setScalar(0.94);
  return root;
}

function createStealthBomber(detail) {
  const high = detail === "high";
  const root = new THREE.Group();
  root.name = `Specter-Bomber-${detail}`;
  root.userData = { role: "bomber", detail, format: "glTF 2.0" };

  const wingShape = new THREE.Shape();
  wingShape.moveTo(-4.7, 1.8);
  wingShape.lineTo(0, -3.25);
  wingShape.lineTo(4.7, 1.8);
  wingShape.lineTo(2.2, 1.15);
  wingShape.lineTo(0, -0.35);
  wingShape.lineTo(-2.2, 1.15);
  wingShape.closePath();
  const wingGeometry = new THREE.ExtrudeGeometry(wingShape, {
    depth: high ? 0.42 : 0.28,
    bevelEnabled: high,
    bevelSegments: high ? 3 : 0,
    bevelSize: high ? 0.08 : 0,
    bevelThickness: high ? 0.08 : 0,
    curveSegments: high ? 8 : 2,
  });
  wingGeometry.center();
  wingGeometry.rotateX(Math.PI / 2);
  root.add(
    mesh(
      wingGeometry,
      materials.stealthHull,
      "Radar absorbent flying wing",
      [0, 0, 0.15],
    ),
    mesh(
      new THREE.SphereGeometry(1, high ? 24 : 8, high ? 14 : 6),
      materials.canopy,
      "Low-profile cockpit",
      [0, 0.32, -1.45],
      [0.7, 0.24, 0.86],
    ),
    mesh(
      new THREE.BoxGeometry(1, 1, 1),
      materials.stealthEdge,
      "Forward signature strip",
      [0, -0.24, -1.22],
      [4.7, 0.045, 0.085],
    ),
  );

  [-1.52, 1.52].forEach((x, engineIndex) => {
    root.add(
      mesh(
        new THREE.BoxGeometry(1, 1, 1),
        materials.stealthEdge,
        `Buried engine ${engineIndex + 1}`,
        [x, 0, 1.52],
        [0.74, 0.1, 0.08],
      ),
    );
  });
  if (high) {
    for (let index = 0; index < 12; index += 1) {
      const side = index % 2 ? 1 : -1;
      detailBox(
        root,
        `Stealth access panel ${index + 1}`,
        [side * (0.55 + (index % 4) * 0.62), 0.25, -0.55 + Math.floor(index / 4) * 0.72],
        [0.42, 0.025, 0.28],
        index % 5 === 0 ? materials.stealthEdge : materials.stealthHull,
      );
    }
  }
  root.scale.setScalar(1.12);
  return root;
}

function createAsteroid() {
  const geometry = new THREE.IcosahedronGeometry(1, 12);
  const positions = geometry.getAttribute("position");
  const vertex = new THREE.Vector3();
  const craterDirection = new THREE.Vector3(0.62, 0.48, -0.62).normalize();
  const surfaceDirection = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    vertex.fromBufferAttribute(positions, index);
    const noise =
      Math.sin(vertex.x * 9.7 + vertex.y * 4.3) * 0.075 +
      Math.sin(vertex.y * 13.1 + vertex.z * 7.9) * 0.055 +
      Math.sin(vertex.z * 17.3 + vertex.x * 5.1) * 0.035;
    const crater =
      surfaceDirection.copy(vertex).normalize().dot(craterDirection) > 0.92
        ? -0.13
        : 0;
    vertex.multiplyScalar(1 + noise + crater);
    positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    name: "Carbonaceous Rock",
    color: 0x394044,
    roughness: 0.96,
    metalness: 0.06,
  });
  const asteroid = new THREE.Group();
  asteroid.name = "High-detail asteroid";
  asteroid.userData = {
    role: "asteroid",
    detail: "high",
    format: "glTF 2.0",
  };
  asteroid.add(
    mesh(geometry, material, "Displaced high-detail rock geometry"),
  );
  return asteroid;
}

async function exportModel(name, model) {
  const exporter = new GLTFExporter();
  model.updateMatrixWorld(true);
  const data = await exporter.parseAsync(model, {
    binary: true,
    onlyVisible: true,
    trs: false,
    maxTextureSize: 1024,
  });
  const output = new URL(`${name}.glb`, outputDirectory);
  await writeFile(output, Buffer.from(data));
  return { name, bytes: data.byteLength };
}

const definitions = [
  ["xwing-high", createXWing("high")],
  ["xwing-low", createXWing("low")],
  ["tie-fighter-high", createTieFighter("high")],
  ["tie-fighter-low", createTieFighter("low")],
  ["tie-interceptor-high", createTieInterceptor("high")],
  ["tie-interceptor-low", createTieInterceptor("low")],
  ["stealth-bomber-high", createStealthBomber("high")],
  ["stealth-bomber-low", createStealthBomber("low")],
  ["asteroid-high", createAsteroid()],
];

const results = [];
for (const [name, model] of definitions) {
  results.push(await exportModel(name, model));
}

for (const result of results) {
  console.log(`${result.name}: ${(result.bytes / 1024).toFixed(1)} KiB`);
}
