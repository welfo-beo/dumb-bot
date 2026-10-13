# Dependency and license review

**Reviewed:** 2026-10-13
**Scope:** source and package manifests under `src/`, `packages/`, `test/`, and `tests/`; root `package.json` and `package-lock.json`; available Git metadata; upstream package and API declarations.

## Findings

- No third-party source tree or clearly copied upstream implementation was found in the reviewed source paths. Project code calls Node.js built-ins, Pi's SDK, and TypeBox. The security and Hindsight adapter packages have no declared package dependencies.
- `src/extensions/hindsight/extension.ts` imports `typebox` directly, but the root manifest originally relied on Pi's transitive copy. The root dependency is now declared explicitly at the already locked version, `typebox@1.3.27` (MIT), and the lockfile/SBOM should be regenerated with the commands below.
- The sole existing production dependency before that correction was `@earendil-works/pi-coding-agent@1.2.0` (MIT). The exact npm package page identifies the version, MIT license, and source repository. `@earendil-works/pi-coding-agent` owns the Pi runtime; this project implements its own extensions and adapters rather than vendoring Pi source.
- Direct development/test dependencies are `@types/node@26.6.5` (MIT), `tsx@4.23.15` (MIT), `typescript@7.0.2` (Apache-2.0), and `vitest@5.0.4` (MIT). Lockfile transitive licenses, optional platform packages, package URLs and integrity hashes are included in the SPDX files.
- The Hindsight adapter uses the public REST contract, not `@vectorize-io/hindsight-client`. Hindsight is therefore an upstream API/service, not a bundled dependency or a license for this repository's implementation. See `packages/memory-hindsight/docs/official-compatibility.md` for API sources and the exact deletion limitation.
- `src/skills/i-have-adhd/SKILL.md` is an exact copy of the canonical `skills/i-have-adhd/SKILL.md` at `ayghri/i-have-adhd` commit `1ecea1993b7fce257ffbd686c070948b5e07eda6` (2026-10-11). Local and upstream SHA-256 are both `88955c019bbb1419ff4b49dbb1f80a867467de6233d7865af2e06a7d7b76c7d3`. The upstream repository declares MIT, names `Ayoub Ghriss` in its LICENSE, and its Pi installation instructions point to that `skills/` path. `NOTICE` records the immutable source, commit, hash, and attribution.
- The project owner confirmed that project-original code should use MIT with `Copyright (c) 2026 Hazim`. The root `LICENSE` and `package.json` now reflect that choice, and the root `package-lock.json` / SPDX SBOM are regenerated from the declared metadata. This records the owner's licensing instruction; it is not an independent legal verification of title.
- The copied `i-have-adhd` skill remains separately attributed to Ayoub Ghriss under the upstream MIT grant. Its complete original license text is stored beside the skill at `src/skills/i-have-adhd/LICENSE`; `NOTICE` records the pinned source commit and SHA-256. The root license does not remove or overwrite this third-party notice.

## SBOM regeneration

Run from the repository root with npm 11 or later after any dependency or package license metadata change:

```sh
npm sbom --package-lock-only --sbom-format spdx > docs/sbom.spdx.json
npm sbom --package-lock-only --omit=dev --sbom-format spdx > docs/sbom.runtime.spdx.json
```

The first file covers the full locked dependency tree (including development/test and optional packages). The second omits development dependencies and describes the production dependency tree. Both are SPDX 2.3 JSON generated from the lockfile, not a source-code similarity or legal-ownership scan.
