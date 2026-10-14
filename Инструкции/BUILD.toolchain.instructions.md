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

Document only commands that exist. Future test:live/bench tasks stay unavailable
until implemented, never empty successful scripts. Build/check/install/status may
not dispatch a public-provider request. Real Pi and pack/install tests use disposable
configuration and an allowlisted environment; they never touch personal Pi settings.
