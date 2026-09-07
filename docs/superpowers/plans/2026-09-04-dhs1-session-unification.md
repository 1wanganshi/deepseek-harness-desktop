# DHS1 Project Session Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed `DeepSeek Harness Desktop 0.2.3` use one canonical session store for `D:\vibecoding\DHS1`, so reopening that project always shows its complete previous history without requiring the old Web entry.

**Architecture:** Keep `%APPDATA%\deepseek-harness-desktop\dsh-home` as the only writable runtime home. Add an idempotent, atomic project-scoped merge from `%USERPROFILE%\.dsh` that selects sessions by their stored `identity.cwd`, copies missing session blobs plus their metadata/index records, and preserves both sides in a timestamped backup. Quarantine the legacy Web desktop/startup shortcuts after the merge so they cannot create a second live DHS1 history.

**Tech Stack:** Electron main process, TypeScript, Node.js `fs/promises`, existing Vitest suite, Windows `.lnk`/Task Scheduler inspection.

**Spec:** User request in the current conversation: unify the `D:\vibecoding\DHS1` project session/chat history inside the installed 0.2.3 desktop app and make reopening that project show prior records.

## Global Constraints

- Canonical DSH home is `%APPDATA%\deepseek-harness-desktop\dsh-home`.
- Source legacy home is `%USERPROFILE%\.dsh`; it must remain recoverable after migration.
- Only records whose persisted session identity has `cwd` equal to `D:\vibecoding\DHS1` are in scope.
- Never delete or overwrite a source session; all writes must be atomic and idempotent.
- Do not merge sessions from other projects such as `D:\vibecoding\deep测试` or `C:\Users\Lenovo\Desktop\知识库`.
- Do not change the official DHS runtime version (`0.1.1-rc.2`) or desktop version (`0.2.3`) as part of this work.

---

### Task 1: Add a project-scoped session merge module

**Files:**
- Create: `src/main/session-merge.ts`
- Test: `tests/session-merge.test.ts`

**Interfaces:**
- Consumes: `legacyHome`, `targetHome`, `projectCwd`, `backupRoot`.
- Produces: `mergeLegacyProjectSessions(options): Promise<ProjectSessionMergeStatus>` with `status`, `projectCwd`, `sourceSessionIds`, `copiedSessionIds`, `skippedSessionIds`, `copiedPaths`, `backupPath`, and `error`.

- [ ] **Step 1: Write failing tests for exact project selection and idempotence.**

  Build a temporary legacy and target DSH home. Put one source session whose `storages/session_projcache/sessions/<id>.json` has `record.identity.cwd === 'D:\\\\vibecoding\\\\DHS1'`, one source session for another cwd, and one already-present target session. Assert that only the DHS1 session is selected, missing blob/index/aggregate records are copied, the other cwd is untouched, existing target content is not overwritten, and a second call reports no duplicate copy.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `pnpm vitest run tests/session-merge.test.ts`

  Expected: FAIL because `session-merge.ts` and `mergeLegacyProjectSessions` do not exist.

- [ ] **Step 3: Implement the discovery and merge algorithm.**

  `discoverProjectSessionIds` must read only `legacyHome/storages/session_projcache/sessions/*.json`, parse each JSON record, and select records where `record.identity.cwd` equals the requested project cwd after `path.resolve` normalization. For each selected id, resolve the matching blob under `legacyHome/sessions/**/session-<id>/session.jsonl.zstd` by filename rather than assuming a path-key encoding. Merge these artifacts:

  ```ts
  export interface ProjectSessionMergeOptions {
    legacyHome: string
    targetHome: string
    projectCwd: string
    backupRoot: string
  }

  export interface ProjectSessionMergeStatus {
    status: 'not-found' | 'merged' | 'already-merged' | 'failed'
    projectCwd: string
    sourceSessionIds: string[]
    copiedSessionIds: string[]
    skippedSessionIds: string[]
    copiedPaths: string[]
    backupPath: string | null
    error: string | null
  }

  export async function mergeLegacyProjectSessions(
    options: ProjectSessionMergeOptions,
  ): Promise<ProjectSessionMergeStatus>
  ```

  Before the first write, create `backupRoot/<timestamp>/legacy-dhs1` and copy every selected source index/blob plus the target files that may be changed. Write target files through temporary files followed by `rename`. For an index or aggregate record already present in the target, preserve the target record and only add a missing session id; never replace a target record with older source data. Copy a blob only when the target blob is absent. Return `already-merged` when all selected ids and artifacts are already present.

- [ ] **Step 4: Run the focused test and verify it passes.**

  Run: `pnpm vitest run tests/session-merge.test.ts`

  Expected: PASS, including the non-DHS1 exclusion, preservation, atomic/idempotent behavior, and failure rollback cases.

- [ ] **Step 5: Commit the isolated data-merge change.**

  ```powershell
  git add src/main/session-merge.ts tests/session-merge.test.ts
  git commit -m "feat: merge DHS1 sessions into desktop store"
  ```

### Task 2: Run the merge during 0.2.3 startup and expose its result

**Files:**
- Modify: `src/main/main.ts:83-165`
- Modify: `src/main/diagnostics.ts:7-70`
- Modify: `src/shared/types.ts`
- Test: `tests/main-session-merge.test.ts`

**Interfaces:**
- Consumes: `mergeLegacyProjectSessions` from Task 1.
- Produces: startup merge status in diagnostics and a log line that identifies the project cwd, copied count, skipped count, and backup path.

- [ ] **Step 1: Write failing integration tests.**

  Test that `createServices` invokes the merge after the existing one-time profile migration, passes `D:\\\\vibecoding\\\\DHS1`, and does not invoke a whole-home copy. Test that a merge failure leaves runtime startup allowed to continue but records a failed merge status and a diagnostic log entry; the UI must not claim the records were merged.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `pnpm vitest run tests/main-session-merge.test.ts`

  Expected: FAIL because startup diagnostics have no project merge status.

- [ ] **Step 3: Integrate the merge before `startRuntime`.**

  In `createServices`, after `migrateLegacyDsh` returns and before profile preparation/runtime start, call `mergeLegacyProjectSessions` with `join(app.getPath('home'), '.dsh')`, `paths.dshHome`, the exact project cwd, and `join(app.getPath('userData'), 'migration-backups')`. Store the returned status in a module variable. Do not block the app forever on a failed merge: log the failure, keep the source intact, and continue startup so the repair UI can report it.

- [ ] **Step 4: Add diagnostic fields and user-visible copy.**

  Extend `RuntimeDiagnostics` with `projectSessionMerge`. Include the status in `DiagnosticsStore.snapshot()` and display a concise status in the existing diagnostics/repair surface: `已统一 DHS1 会话：复制 N 条，已存在 M 条` or `DHS1 会话统一失败：源数据仍保留，备份路径为 ...`. Never present a failure as success.

- [ ] **Step 5: Run typecheck and focused tests.**

  Run: `pnpm run typecheck` and `pnpm vitest run tests/main-session-merge.test.ts tests/session-merge.test.ts tests/diagnostics.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit the startup integration.**

  ```powershell
  git add src/main/main.ts src/main/diagnostics.ts src/shared/types.ts tests/main-session-merge.test.ts
  git commit -m "feat: restore DHS1 history on desktop startup"
  ```

### Task 3: Prevent the legacy Web entry from creating a second DHS1 store

**Files:**
- Create: `src/main/legacy-launcher.ts`
- Modify: `src/main/main.ts:151-165`
- Test: `tests/legacy-launcher.test.ts`
- Operational files: `C:\Users\Lenovo\Desktop\DSH Web.lnk`, `C:\Users\Lenovo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\DSH Web 自启.lnk`

**Interfaces:**
- Consumes: the existing `.lnk` target/arguments and the canonical desktop executable path.
- Produces: a recoverable quarantine operation and a check that reports whether any legacy Web launcher remains enabled.

- [ ] **Step 1: Write failing tests for launcher detection and recoverable quarantine.**

  Assert that only shortcuts whose target/arguments contain `start-dsh-web.ps1` or the legacy `.dsh` root are selected. A quarantine operation must move selected shortcuts into `%APPDATA%\\deepseek-harness-desktop\\legacy-launcher-backup\\<timestamp>` and return their original and new paths. Unrelated shortcuts must be untouched, and repeating the operation must be a no-op.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `pnpm vitest run tests/legacy-launcher.test.ts`

  Expected: FAIL because launcher detection/quarantine does not exist.

- [ ] **Step 3: Implement recoverable quarantine and stale-process reporting.**

  Use Windows Shell shortcut inspection through Node/PowerShell-free filesystem APIs already permitted by the app process. Do not delete the old files. Before moving a shortcut, verify its resolved target is the known legacy script. Record the quarantine manifest and expose a diagnostic warning if a legacy `dsh web` process is still listening on port `39060`.

- [ ] **Step 4: Invoke quarantine once after a successful DHS1 merge.**

  Only quarantine when the merge status is `merged` or `already-merged`; on failure, leave launchers untouched for recovery. Log every moved shortcut and its backup location. Keep the canonical `DeepSeek Harness Desktop 0.2.3.lnk` unchanged.

- [ ] **Step 5: Run focused tests and commit.**

  Run: `pnpm vitest run tests/legacy-launcher.test.ts tests/main-session-merge.test.ts`.

  ```powershell
  git add src/main/legacy-launcher.ts src/main/main.ts tests/legacy-launcher.test.ts
  git commit -m "fix: stop legacy web launcher from splitting project history"
  ```

### Task 4: Add an explicit “DHS1 history” repair action

**Files:**
- Modify: `src/main/repair-window.ts`
- Modify: `src/renderer/repair-flow.ts`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/status-copy.ts`
- Test: `tests/repair-flow-session-merge.test.ts`

**Interfaces:**
- Consumes: the same `mergeLegacyProjectSessions` operation through a new IPC handler `desktop:merge-project-sessions`.
- Produces: a repair step with progress, result counts, backup path, and a “重新打开项目” action that reloads the canonical runtime view.

- [ ] **Step 1: Write failing renderer/main-process tests.**

  Assert that clicking the DHS1 history repair action invokes the IPC handler, renders progress states (`正在检查`, `正在合并`, `已完成`/`失败`), shows copied/skipped counts, and never hides a failure behind a generic success toast.

- [ ] **Step 2: Implement the IPC and progress events.**

  Add `desktop:merge-project-sessions` to call the queued maintenance path, send `desktop:project-session-merge-status` events, and return the persisted status. The repair window must remain usable while the operation runs.

- [ ] **Step 3: Implement the UI and reload behavior.**

  Add one clearly labeled action for `DHS1 会话统一/检查历史记录`. After success, close the repair window, restart only the Harness runtime if necessary, and reload the project session list from the canonical URL. Do not expose the old Web URL as an alternative action.

- [ ] **Step 4: Run focused tests and commit.**

  Run: `pnpm vitest run tests/repair-flow-session-merge.test.ts tests/repair-window.test.ts tests/status-panel-menu.test.ts`

  ```powershell
  git add src/main/repair-window.ts src/renderer/repair-flow.ts src/renderer/main.tsx src/renderer/status-copy.ts tests/repair-flow-session-merge.test.ts
  git commit -m "feat: add DHS1 history repair workflow"
  ```

### Task 5: Execute a production-data migration and verify persistence

**Files:**
- Modify only generated/runtime data under `%APPDATA%\\deepseek-harness-desktop` and the two identified legacy launcher locations; do not modify source chat files directly outside the merge module.
- Test/record: `docs/superpowers/verification/2026-09-04-dhs1-session-unification.md`

- [ ] **Step 1: Stop both running DHS services and create a full backup.**

  Record process ids and ports. Copy `%USERPROFILE%\\.dsh`, `%APPDATA%\\deepseek-harness-desktop\\dsh-home`, and the existing migration backup to a new timestamped backup directory. Verify the backup contains the four legacy-only DHS1 sessions discovered during diagnosis, including their `.jsonl.zstd` blobs and metadata JSON files.

- [ ] **Step 2: Run the project-scoped merge in dry-run mode.**

  Report selected session ids, source/target presence, and planned writes. Confirm every selected record has `identity.cwd === 'D:\\\\vibecoding\\\\DHS1'`; abort if any other cwd is selected.

- [ ] **Step 3: Apply the merge and quarantine old launchers.**

  Apply the atomic merge, verify the returned status is `merged` or `already-merged`, then move `DSH Web.lnk` and the Startup `DSH Web 自启.lnk` into the app’s recoverable legacy-launcher backup. Do not empty the Recycle Bin or delete the backup.

- [ ] **Step 4: Launch only the installed 0.2.3 shortcut.**

  Confirm the process command line uses `C:\\Program Files\\DeepSeek Harness Desktop\\DeepSeek Harness Desktop.exe` and `DSH_HOME=C:\\Users\\Lenovo\\AppData\\Roaming\\deepseek-harness-desktop\\dsh-home`. Confirm no node process remains on legacy port `39060`.

- [ ] **Step 5: Verify the exact user workflow.**

  Open the `DHS1` project in the desktop app and verify the previously missing sessions appear with their original titles/content. Close and reopen the desktop app, open `DHS1` again, and verify the same records remain. Create one new test message, restart the app through the real restart action, reopen `DHS1`, and verify that new message persists in the canonical store.

- [ ] **Step 6: Run the complete verification suite.**

  Run: `pnpm run typecheck`, `pnpm test -- --run`, `pnpm run pack`, then launch the newly packed/installable 0.2.3 build and repeat Step 5 against the installed executable.

- [ ] **Step 7: Record evidence and hand off.**

  Save the selected/copied/skipped session counts, canonical DSH home, backup locations, process/port checks, and reopen/restart screenshots in `docs/superpowers/verification/2026-09-04-dhs1-session-unification.md`. Keep the final installed 0.2.3 window open on the DHS1 project for user inspection.

---

## Self-review

- Project scope is enforced by persisted `identity.cwd`, not by fragile directory-name encoding.
- Existing source and target data are backed up and never destructively overwritten.
- Startup, manual repair, launcher isolation, and reopen/restart persistence are covered by separate testable tasks.
- The plan does not merge unrelated projects or change runtime versioning.
