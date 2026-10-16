---
applyTo: "package*.json,tsconfig*.json,scripts/**"
name: "BUILD.Toolchain"
description: "Use when setting up Node/TypeScript, adding dependencies, building an extension or inspecting packed artifacts."
---

# BUILD — Local toolchain and package boundary

This project is a Node/TypeScript Pi extension, not a Python application. Local
`node_modules` and the committed npm lockfile provide dependency isolation; do not
create an unrelated Python virtual environment or modify global packages.
Use strict TypeScript, NodeNext ESM, one compiler and one test runner (`node:test`
with `node:assert/strict` on compiled JavaScript). Vite is not needed for the extension;
if a browser surface is added, prefer Vite for that surface only.

Pin direct development dependencies exactly. Inspect package metadata and lifecycle
scripts before installation. Use `npm install --ignore-scripts` to create/update the
lockfile and `npm ci --ignore-scripts` for a clean reproducible install. Do not run
third-party lifecycle scripts casually. Document any authorized exception.

Pi-supplied modules actually imported belong in peerDependencies, not dependencies
or bundles. Match the pinned host package guide and inspect installed declarations.
An exact host devDependency is allowed for isolated tests. Version equality does not
prove npm bytes equal the frozen Git tree; record both identities separately.

Build with tsc; test compiled output. An explicit package `files` allowlist and `pi`
manifest must resolve after packing, outside this checkout. Exclude source donors,
fixtures, docs unless intentionally shipped, logs, credentials and test build output.
Keep public contracts imports separate from the extension entry and inert.

Active gates are `npm run build`, `npm test`, `npm run evidence:routing`,
`npm run test:pi`, `npm run test:package` and full aggregate `npm run check`;
see [README](../README.md). Package/evidence helpers accept `QE_EVIDENCE_DIR`;
pass a fresh absolute native path before execution. Without it, routing uses
`verification/<QE_CHECKPOINT>/<QE_EVIDENCE_ROLE>/<unique-run>`; the implemented
fallbacks remain K03/author. Set the actual checkpoint deliberately. A fallback
is not permission to write a historical bundle. Exercise automatic routing only
inside a fresh owned candidate mirror, trace nested producers and preserve real
prior-stage byte controls. Keep prior results immutable and retain the actual
installed/tested tarball; compare payload bytes, not version strings alone.
Avoid composing Windows paths from POSIX `$PWD`.
`node scripts/collect-evidence.mjs` collects identities, not proof of passing gates;
independently bind all packed payloads/resources to actual commit/build bytes.
When Git EOL normalization changes bytes, build/test/pack exact committed source
in disposable state; working-tree text equivalence is not exact-artifact evidence.
Document only commands that exist. Future test:live/bench tasks stay unavailable
until implemented, never empty successful scripts. Build/check/install/status may
not dispatch a public-provider request. Real Pi and pack/install tests use disposable
configuration and an allowlisted environment; they never touch personal Pi settings.
