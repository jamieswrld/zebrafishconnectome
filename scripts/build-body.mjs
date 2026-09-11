/**
 * Builds the reference body mesh artifact.
 *
 * The generator itself lives in src/body/larva.ts so the application and this
 * script cannot drift. Run:
 *
 *   npm run build:body
 *
 * Output:
 *   public/body/manifest.json
 *   public/body/v1/larva.meshbin
 *
 * The runtime fetches the binary and never parses an authoring format. If a
 * real GLB/glTF body is sourced later, convert it here and emit the same
 * container; nothing downstream changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildLarvaModel, EYES, LARVA_ATTRIBUTION, LARVA_LICENSE } from '@/body/larva';
import { encodeMesh, decodeMesh, meshTriangleCount } from '@/core/mesh';
import { BODY_LENGTH_UM } from '@/core/transforms';

const VERSION = 'v1';
const OUT_DIR = path.resolve(process.cwd(), 'public', 'body');

const model = buildLarvaModel();

const buffer = encodeMesh({
  name: 'larval-zebrafish-reference',
  positions: model.positions,
  normals: model.normals,
  indices: model.indices,
  boneIndices: model.boneIndices,
  boneWeights: model.boneWeights,
  subMeshes: model.subMeshes,
  bones: model.bones,
  space: 'body-rest',
  sourceAttribution: LARVA_ATTRIBUTION,
  license: LARVA_LICENSE,
});

// Round-trip before writing: a mesh that fails validation must never ship.
const decoded = decodeMesh(buffer);
if (decoded.vertexCount !== model.vertexCount) {
  throw new Error(
    `Round-trip mismatch: encoded ${model.vertexCount} vertices, decoded ${decoded.vertexCount}.`,
  );
}
if (decoded.bones.length !== model.bones.length) {
  throw new Error('Round-trip lost the rig.');
}

mkdirSync(path.join(OUT_DIR, VERSION), { recursive: true });
const binPath = path.join(OUT_DIR, VERSION, 'larva.meshbin');
writeFileSync(binPath, Buffer.from(buffer));

const manifest = {
  asset: 'larval-zebrafish-reference',
  version: VERSION,
  generatedAt: new Date().toISOString(),
  provenance: 'modeled-reference',
  attribution: LARVA_ATTRIBUTION,
  license: LARVA_LICENSE,
  space: 'body-rest',
  units: 'um',
  bodyLengthUm: BODY_LENGTH_UM,
  vertexCount: model.vertexCount,
  triangleCount: meshTriangleCount({ indexCount: model.indices.length }),
  boneCount: model.bones.length,
  bytes: buffer.byteLength,
  eyes: EYES,
  files: { mesh: `/body/${VERSION}/larva.meshbin` },
};
writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('reference body mesh');
console.log(`  vertices   ${model.vertexCount.toLocaleString()}`);
console.log(`  triangles  ${manifest.triangleCount.toLocaleString()}`);
console.log(`  bones      ${model.bones.length}`);
console.log(
  `  bytes      ${buffer.byteLength.toLocaleString()} (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
);
console.log(`  wrote ${binPath}`);
console.log(`  wrote ${path.join(OUT_DIR, 'manifest.json')}`);
