# Third-party notices

This package contains original source code. No donor extension source code has
been copied into `src/`, `dist/` or `resources/`. Reference checkouts, when
needed, stay under the ignored `donors/` directory and are not shipped. The
`examples/independent-extension/` fixture is original project code and is not
part of the published package.

## Frozen baseline used for interface inspection

- `earendil-works/pi` — Coding Agent `1.1.0`, frozen commit
  `c661bc574f9e9713cc2af567fc1ac00621377a0c`. The pinned npm artifact
  `@earendil-works/pi-coding-agent@1.1.0` is the host package used for local
  development and probes. Version equality with the frozen tree is not claimed
  beyond this recorded version string.

## Host-provided peer packages (not bundled)

Declared in `peerDependencies` with range `"*"`, supplied by Pi at runtime:

- `@earendil-works/pi-coding-agent` — the extension API, agent directory
  resolution, host version and event surface used by this package. Pi supplies
  this package; see the upstream Pi package guide for its license.

## Runtime dependency

- `yaml` `2.9.0` — ISC License, Copyright Eemeli Aro `<eemeli@gmail.com>`.
  Used only for restricted configuration parsing. The npm package is fetched by
  the package manager, not vendored into this repository.

## Development dependencies

- `typescript` `7.0.2` — Apache-2.0.
- `@types/node` `26.6.5` — MIT.
- `@earendil-works/pi-coding-agent` `1.1.0` (exact development pin for isolated
  tests) — host package, see above.

The verification evidence under `verification/` records the actual installed
versions and SDK file digests used for each probe.
