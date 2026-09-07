# Session Durability and Safe Plugin Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a confirmed desktop restart from losing newly created DHS sessions, and make a user-requested community-plugin update either start from a verified candidate profile or leave the last known working profile untouched.

**Architecture:** Treat each session as durable only when its compressed transcript, session index, and matching workspace `sessionIds` entry all exist. The main process snapshots that three-layer state before a restart, waits for the runtime to become quiescent, repairs only an unambiguous missing workspace reference with an atomic write and backup, and cancels the restart if any new session remains incomplete. Plugin sync becomes a transaction: copy the active `profiles/web` directory to a sibling candidate, update and validate that candidate, then atomically switch directories; a startup failure restores the preserved active profile.

**Tech Stack:** Electron main process, TypeScript, Node.js `fs/promises`, pnpm/npm, Vitest, existing DHS runtime health check.

**Spec:** Current user request: future DHS1 conversations must survive true desktop restarts in their own project workspace; plugin updates must never leave the desktop client unable to start.

## Global Constraints

- Never edit, delete, or retrospectively reconstruct a user's historical session transcript as part of the restart guard.
- Test storage only in operating-system temporary directories; never test against `%APPDATA%\\deepseek-harness-desktop`.
- A restart may proceed only after every session created or changed since the restart baseline has a transcript, parseable index, and workspace association.
- A missing workspace association may be repaired only when its indexed `identity.cwd` identifies exactly one existing workspace; all repair writes are atomic and backed up.
- A missing/invalid transcript or index cancels the restart and keeps both the Harness and the desktop window running.
- Community-plugin upgrades are manual only, preserve the active profile until a candidate passes validation, and retain the previous profile for automatic rollback.
- Official DHS runtime updates remain separate from community-plugin upgrades.
- Existing unrelated working-tree changes are user-owned; do not reset, stash, delete, or include them in a bulk commit.

---

### Task 1: Add a three-layer session durability guard

**Files:**
- Create: `src/main/session-durability.ts`
- Create: `tests/session-durability.test.ts`

**Interfaces:**
- Consumes: `SessionDurabilityOptions { dshHome: string; backupRoot: string; now?: () => Date }`.
- Produces: `SessionDurabilityGuard.captureBaseline(): Promise<void>` and `SessionDurabilityGuard.verifyForRestart(): Promise<SessionDurabilityReport>`.
- `SessionDurabilityReport` is `{ safe: boolean; checkedSessionIds: string[]; repairedSessionIds: string[]; blockers: SessionDurabilityBlocker[]; backupPath: string | null }`, where a blocker has `{ sessionId: string; reason: 'missing-transcript' | 'missing-index' | 'invalid-index' | 'missing-workspace' | 'ambiguous-workspace' }`.

- [x] **Step 1: Write failing durability tests.**

```ts
it('blocks restart when a session created after the baseline lacks its index', async () => {
  const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
  await guard.captureBaseline()
  await writeTranscript(dshHome, id)
  await expect(guard.verifyForRestart()).resolves.toMatchObject({
    safe: false,
    blockers: [{ sessionId: id, reason: 'missing-index' }],
  })
})

it('atomically adds an unambiguously owned session to its workspace before restart', async () => {
  await writeCompleteSession(dshHome, id, projectCwd, { includeWorkspaceReference: false })
  const guard = new SessionDurabilityGuard({ dshHome, backupRoot })
  await guard.captureBaseline()
  await writeCompleteSession(dshHome, laterId, projectCwd, { includeWorkspaceReference: false })
  await expect(guard.verifyForRestart()).resolves.toMatchObject({
    safe: true,
    repairedSessionIds: [laterId],
  })
  await expect(readWorkspaceSessionIds(dshHome, projectCwd)).resolves.toContain(`session-${laterId}`)
})
```

- [x] **Step 2: Run the focused test and verify it fails because the guard does not exist.**

Run: `pnpm vitest run tests/session-durability.test.ts`

Expected: FAIL with an unresolved `../src/main/session-durability.js` import.

- [x] **Step 3: Implement the minimal scan and repair.**

```ts
export class SessionDurabilityGuard {
  async captureBaseline(): Promise<void>
  async verifyForRestart(): Promise<SessionDurabilityReport>
}
```

Scan `sessions/**/session-*/session.jsonl.zstd` and `storages/session_projcache/sessions/session-*.json`; derive IDs from names, not directory encoding. Diff the scan against `captureBaseline()`. For each new or changed ID, parse the index's `record.identity.cwd`, check the exact `workspace.json` workspace whose normalized `path` matches it, and require `session-${id}` in its `sessionIds`. If exactly one existing workspace matches, create `session-durability-backups/<timestamp>/workspace.json`, write the amended JSON to a same-directory temporary file, and `rename` it. Return a blocker instead of writing whenever data is missing, malformed, or ambiguous.

- [x] **Step 4: Run focused tests and keep only the minimal implementation needed for green.**

Run: `pnpm vitest run tests/session-durability.test.ts`

Expected: PASS for complete sessions, missing transcript/index, invalid index, missing workspace, ambiguous workspace, and atomic workspace-reference repair.

### Task 2: Gate desktop restart and prefer graceful runtime shutdown

**Files:**
- Modify: `src/main/desktop-restart.ts`
- Modify: `src/main/runtime-controller.ts`
- Modify: `src/main/main.ts`
- Modify: `tests/desktop-restart.test.ts`
- Modify: `tests/runtime-launch.test.ts`

**Interfaces:**
- Consumes: `restartDesktop({ verifyBeforeStop, stop, relaunch, exit })` where `verifyBeforeStop` resolves to `SessionDurabilityReport`.
- Produces: `DesktopRestartResult { restarted: boolean; report: SessionDurabilityReport | null }`.
- `RuntimeController.stop()` sends a normal child termination signal and waits for exit before the Windows `taskkill /T /F` fallback.

- [x] **Step 1: Write failing restart and shutdown tests.**

```ts
it('does not relaunch or exit when persistence verification blocks restart', async () => {
  const result = await restartDesktop({
    verifyBeforeStop: async () => unsafeReport,
    stop: vi.fn(), relaunch: vi.fn(), exit: vi.fn(),
  })
  expect(result).toEqual({ restarted: false, report: unsafeReport })
})

it('waits for graceful child exit before using forced Windows termination', async () => {
  const controller = createControllerWithChildThatExitsAfterKill()
  await controller.stop()
  expect(taskkill).not.toHaveBeenCalled()
})
```

- [x] **Step 2: Run the focused tests and verify they fail for the absent restart gate/graceful-wait behavior.**

Run: `pnpm vitest run tests/desktop-restart.test.ts tests/runtime-launch.test.ts`

Expected: FAIL because restart currently always relaunches and Windows shutdown immediately invokes forced `taskkill`.

- [x] **Step 3: Implement condition-based shutdown and cancellation.**

Make `restartDesktop` call `verifyBeforeStop` before `stop`. When `safe` is false, return without calling `stop`, `relaunch`, or `exit`; do not turn a persistence error into a successful restart. In `RuntimeController.terminateChild`, call `child.kill()`, await its `exit`/`close` event for a bounded grace interval, and use `taskkill /T /F` only if that condition has not become true. Preserve the forced termination fallback for stuck child trees.

- [x] **Step 4: Wire the guard through the IPC handler.**

In `createServices`, instantiate the guard with `paths.dshHome` and `join(app.getPath('userData'), 'session-durability-backups')`, then call `captureBaseline()` after the runtime is ready. In `desktop:restart-desktop`, pass `verifyBeforeStop: () => guard.verifyForRestart()`. If it returns `restarted: false`, log every blocker and return `false` so the existing renderer retains the visible desktop UI and can show a Chinese reason instead of claiming a restart.

- [x] **Step 5: Run the focused tests.**

Run: `pnpm vitest run tests/desktop-restart.test.ts tests/runtime-launch.test.ts tests/session-durability.test.ts`

Expected: PASS with restart cancellation proven before runtime stop and graceful shutdown proven before force-kill fallback.

### Task 3: Make plugin synchronization a candidate-profile transaction

**Files:**
- Modify: `src/main/plugin-manager.ts`
- Modify: `tests/plugin-manager.test.ts`

**Interfaces:**
- Consumes: `PluginManagerOptions { dshHome; runPnpm; validateCandidate?: (candidatePath: string) => Promise<void>; now?: () => Date }`.
- Produces: `PluginStatus` extended with `activeProfilePath`, `lastKnownGoodProfilePath`, `phase: 'idle' | 'updating' | 'validated' | 'rolled-back' | 'failed'`, and a truthful `error`.
- The active profile remains `dshHome/profiles/web`; candidate and rollback directories are sibling timestamped paths under `dshHome/profiles`.

- [x] **Step 1: Write failing transaction tests.**

```ts
it('updates only a candidate profile until candidate validation succeeds', async () => {
  const status = await manager.sync()
  expect(updateCwds).toEqual([expect.stringMatching(/web\.candidate-/)])
  await expect(readFile(join(active, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
  expect(status.phase).toBe('validated')
})

it('keeps the active profile unchanged and reports rollback when candidate validation fails', async () => {
  const status = await failingManager.sync()
  await expect(readFile(join(active, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
  expect(status.phase).toBe('rolled-back')
  expect(status.error).toContain('validation failed')
})
```

- [x] **Step 2: Run the focused test and verify it fails because sync still updates the active directory.**

Run: `pnpm vitest run tests/plugin-manager.test.ts`

Expected: FAIL because the current `runPnpm` cwd is `profiles/web` and validation is not run against a candidate path.

- [x] **Step 3: Implement candidate update, validation, and atomic switch.**

Copy active `profiles/web` to `profiles/web.candidate-<timestamp>`, run `pnpm update` only in that candidate, and call `validateCandidate(candidatePath)`. On success: rename active to `profiles/web.last-known-good-<timestamp>`, rename candidate to active, retain the last-known-good directory, then report `phase: 'validated'`. On every candidate/update/validation failure: remove only the candidate, retain active without modification, report `phase: 'rolled-back'` and the actual error. Never delete active before a validated candidate exists.

- [x] **Step 4: Run focused tests.**

Run: `pnpm vitest run tests/plugin-manager.test.ts`

Expected: PASS for success, install failure, validation failure, concurrent coalescing, active-profile preservation, and truthful failure status.

### Task 4: Validate candidate plugins through the actual runtime and roll back a failed launch

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/runtime-paths.ts`
- Modify: `src/main/runtime-health.ts`
- Modify: `tests/plugin-manager.test.ts`
- Modify: `tests/runtime-launch.test.ts`

**Interfaces:**
- Consumes: a candidate profile path from `PluginManager`.
- Produces: candidate validation that runs DHS against an isolated temporary `DSH_HOME`, verifies a local health response, and returns without changing canonical user sessions or the active profile.

- [x] **Step 1: Write failing isolation and automatic-rollback tests.**

```ts
it('validates candidate plugins with a temporary DSH home rather than user sessions', async () => {
  await validateCandidate(candidate)
  expect(validationDshHome).toMatch(/plugin-validation-/)
  expect(validationDshHome).not.toBe(paths.dshHome)
})

it('restores last-known-good profile when the first post-switch runtime start fails', async () => {
  await expect(syncThenStart()).rejects.toThrow('candidate startup failed')
  await expect(readFile(join(active, 'package.json'), 'utf8')).resolves.toContain('1.0.0')
})
```

- [x] **Step 2: Run the focused tests and verify they fail because validation only checks file existence.**

Run: `pnpm vitest run tests/plugin-manager.test.ts tests/runtime-launch.test.ts`

Expected: FAIL because the existing `validateProfile` only checks `package.json` and the main process stops the active runtime before sync.

- [x] **Step 3: Implement isolated validation and runtime rollback.**

Build a temporary validation `DSH_HOME` with a copied candidate profile, start the same official DHS executable on a free local port, require the existing health validation to succeed, and stop the validator cleanly. In `desktop:sync-plugins`, keep the current Harness running while candidate files update and validate. Only after `PluginManager.sync()` returns `phase: 'validated'` should the main runtime be stopped and restarted. If the first restart throws, atomically restore `lastKnownGoodProfilePath`, prepare that restored profile, restart it, log the rollback, and return a failed/rolled-back `PluginStatus` rather than a generic success.

- [x] **Step 4: Run focused tests.**

Run: `pnpm vitest run tests/plugin-manager.test.ts tests/runtime-launch.test.ts`

Expected: PASS for isolated candidate startup validation and post-switch automatic rollback.

### Task 5: Present truthful restart/plugin status and complete verification

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/main.tsx`
- Modify: `tests/desktop-restart.test.ts`
- Modify: `tests/plugin-manager.test.ts`

**Interfaces:**
- Consumes: the restart result and extended `PluginStatus` from Tasks 2–4.
- Produces: visible Chinese messages: restart cancellation identifies persistence blockers; plugin action distinguishes `正在验证候选插件`, `升级完成`, and `升级未应用，已保留当前稳定版本`.

- [x] **Step 1: Write failing UI/API contract tests.**

```ts
expect(restartMessage(unsafeReport)).toContain('会话尚未完整保存，已取消重启')
expect(pluginMessage({ ...failedStatus, phase: 'rolled-back' })).toContain('已保留当前稳定版本')
```

- [x] **Step 2: Run focused tests and verify they fail for missing status mapping.**

Run: `pnpm vitest run tests/desktop-restart.test.ts tests/plugin-manager.test.ts`

Expected: FAIL because the current renderer maps any returned plugin status to a generic completion message.

- [x] **Step 3: Implement only the required copy and API propagation.**

Extend `DesktopApi.restartDesktop` to return `DesktopRestartResult`, propagate it through `src/main/preload.ts`, and render the report's real blockers. Extend `PluginStatus` with the phase fields from Task 3 and render success only for `validated`; all other terminal phases must say no update was applied or that rollback succeeded. Keep official-update controls separate and unchanged.

- [x] **Step 4: Run the full automated verification.**

Run: `pnpm test -- --run`

Run: `pnpm run typecheck`

Run: `pnpm run build`

Expected: each command exits `0`. If a packaging command exists in `package.json`, run it after build and launch the packaged executable once with a fresh temporary `--user-data-dir` to ensure it reaches the Harness UI without a white screen.

- [x] **Step 5: Record outcome without changing real chat data.**

Record the exact command exit codes and test totals in `docs/superpowers/verification/2026-09-05-session-durability-and-safe-plugin-update.md`. Do not state that the release is stable until the clean build, complete test run, and packaged cold-start check have all produced fresh evidence.

## Self-review

- The plan prevents future missing records at the persistence boundary rather than attempting to rediscover old hidden sessions.
- Every restart path verifies the transcript, index, and workspace mapping before it can stop DHS.
- Candidate plugin validation never writes into the canonical profile or user session store, and failed candidates cannot replace the active profile.
- The plan keeps an automatic rollback path even after a candidate has been selected.
- The only destructive cleanup is removal of a failed candidate directory, never of the active profile, user data, or historical sessions.
