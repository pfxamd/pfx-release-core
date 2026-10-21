# PFx Release Core

![Version](./version-badge.svg)

Framework-independent, dependency-free release versioning for PFx projects.

## What it provides

PFx Release Core derives one version from Git source commits, then generates synchronized `version.json`, a locally rendered `version-badge.svg`, grouped `CHANGELOG.md` and configured JSON manifest versions. It does not control package publication, deployments, or major/minor release decisions.

Each first-parent commit touching configured source paths increments a prerelease number (or stable patch number). Generated metadata commits and unrelated files do not increment the version. A source release is **not** automatically the same as a package installed by another project.

## Requirements

Node.js 20+, Git with complete history. Zero runtime dependencies. No hosted services.

## Quick start

```sh
npm install --save-dev github:pfxamd/pfx-release-core
npx pfx-release init --product "My Project" --channel Alpha --base 0.1.0-alpha.0 --source src,app
npx pfx-release resolve
npx pfx-release sync
npx pfx-release check
npx pfx-release changelog
```

Run `init` after a Git commit has been created. The command sets the current HEAD as the initial baseline and never overwrites an existing config.

## Design principles

- Source-derived versions are stable when rebuilding identical source.
- The baseline and `baseVersion` are explicit; raising major/minor or promoting to Stable is intentional.
- `sourcePaths` counts first-parent commits. Keep generated outputs outside these directories to avoid release loops.
- `jsonVersions` can include `package.json` or other versioned JSON manifests.
- `sync` is idempotent, writes only changed files, and never commits or pushes.
- `check` is read-only and exits nonzero if generated files are outdated.
- `version.json` carries the source commit SHA, channel, label and source date.
- `ignoreSubjects` excludes exact automated metadata subjects.
- A legacy project can opt into counting generated manifest paths by setting `allowGeneratedSourcePaths: true` while retaining the exact excluded sync commit subject.\n- Shallow Git history is rejected. CI clones should fetch full Git history (`fetch-depth: 0`).

See [example configuration](examples/release.config.json). All commands accept `--root PATH` and `--config PATH`; `init` also takes `--kind core|app|library`.

## Verification

```sh
npm run check
```

Release and deployment automation are **separate**: this core produces metadata and checks consistency without introducing GitHub Actions or rewriting existing project workflows.

Alpha foundation. Copyright 2026 PFxamd. Apache-2.0.

## Multi-package and Rust consumers

`jsonVersions` updates declared JSON manifests (including workspace packages). `npmLocks` updates root and named local workspace package versions without changing external `node_modules` entries. `cargoVersions` supports `[package]` and `[workspace.package]` versions in TOML, while `cargoNames` plus names discovered from listed manifests restrict `cargoLocks` updates to selected local crates. Lockfiles explicitly listed but absent are skipped. Set `changelogPath: false` to preserve an existing hand-maintained changelog. Configuration remains opt-in, so existing consumers are not rewritten implicitly.
