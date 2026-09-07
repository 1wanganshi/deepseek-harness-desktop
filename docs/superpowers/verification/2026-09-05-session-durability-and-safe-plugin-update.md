# Session Durability and Safe Plugin Update Verification

Date: 2026-09-05 (Asia/Shanghai)

## Automated checks

- `pnpm vitest run tests/compatibility.test.ts --no-file-parallelism` — PASS, 11/11 tests.
- `pnpm test -- --no-file-parallelism` — PASS, 35/35 files and 113/113 tests.
- `pnpm run typecheck` — PASS (both TypeScript projects).
- `pnpm run build` — PASS (Vite renderer build and Electron TypeScript build).
- `pnpm run pack:dir` — PASS, generated `release/win-unpacked`.
- `pnpm run pack` — PASS, generated `release/DeepSeek Harness Desktop-0.2.16-Setup.exe`.
- The installer is copied to `C:\\Users\\Lenovo\\Desktop\\DeepSeek Harness Desktop-0.2.16-Setup.exe` after each release build; the desktop copy is verified against the release artifact with SHA-256.

## Runtime checks

- Development/runtime cold start on an isolated DSH home (`.cold-start-final-0.2.16c`, port 29202) reached the complete Harness UI after the compatibility bridge was changed to a callable browser plugin. No `invalid plugin` or `missed the module table` error was present.
- Packaged runtime cold start using `release/win-unpacked/resources/node/node.exe` and the packaged DHS node modules (isolated DSH home, port 29203) reached the complete Harness UI. Browser logs contained only the existing non-blocking imagegen locale warning.
- Packaged Electron smoke test with an isolated `--user-data-dir` (`.electron-smoke-final3-0.2.16`) reached the Harness UI on port 48077; the log recorded `rootChildren:1` and normal Chinese UI text, with no white-screen/plugin-load failure.
- Existing user data under `%APPDATA%\\deepseek-harness-desktop` was not deleted or rewritten by these checks.

## Root-cause fix

The desktop compatibility bridge previously registered a plain object from its browser factory. The browser Cordis loader received that object without a mountable plugin shape and reported `invalid plugin`. The bridge now returns a callable plugin facade with `apply`, `createSnapshotStore`, `defineStore`, and `shallowEqual` properties. Official runtime candidate validation now prepares an isolated profile for the target DHS version, removing the legacy `dsh-client-store` bundle before health checking. The regression tests cover both the callable bridge and this update boundary.
