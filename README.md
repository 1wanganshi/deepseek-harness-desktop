# DeepSeek Harness Desktop

Windows 10/11 x64 desktop host for the official [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) Web UI.

The desktop shell does not reimplement the official Harness UI. It starts the official local Web runtime on a random loopback port and embeds it in an Electron `WebContentsView`, so official sessions, tools, models, settings, and plugin UI remain the source of truth.

## Stability features

- Bundled Node runtime for click-to-run installation.
- Separate `DSH_HOME` under Electron user data; the desktop shell never reads or logs API keys.
- Local-only navigation, isolated preload IPC, and a single-instance desktop lock.
- Startup health check, five-second heartbeat, child-process exit monitoring, bounded exponential recovery, and Windows process-tree cleanup.
- Official npm `latest` check at startup, once per day, and on demand. Installing an update is always a user-click action; the candidate is installed and health-checked before the active pointer changes.
- Community plugin sync backs up the Web profile, serializes concurrent requests, validates the profile, and restores the previous profile on failure.
- Diagnostics window with runtime paths, plugin names, update state, and recent lifecycle logs.
- First launch discovers the existing `%USERPROFILE%\\.dsh`, backs up both sides, and migrates model providers, credentials, Web plugins, sessions, attachments, and related user data into the isolated desktop `DSH_HOME`. The source directory is never deleted; old plugin `node_modules` is intentionally rebuilt from its lockfile.
- The NSIS installer creates a desktop shortcut and Start Menu shortcut. The installed app uses the same migrated data on later launches and never repeats the migration after its marker is written.

## First run

Open the installed app, then use the official Harness setup screen to configure the model API key and choose a workspace. Credentials and sessions remain owned by official DSH storage in the isolated `DSH_HOME` directory.

Remote model congestion cannot be eliminated by a desktop wrapper. The desktop improves local continuity and recovery; provider retries and alternate providers still depend on what is configured in the official Harness Settings → Models screen.

## Development

```powershell
pnpm install
pnpm test --run
pnpm typecheck
pnpm build
```

## Windows packaging

```powershell
pnpm run pack:dir
pnpm run pack
```

The NSIS installer is written to `release/`. The first build uses the Electron default icon and is unsigned, so Windows SmartScreen may show an unknown-publisher warning. Configure a Windows code-signing certificate and a HTTPS release source before distributing automatic desktop-shell updates.

Official references:

- <https://www.deepseek.com/harness/en/>
- <https://github.com/deepseek-ai/deepseek-harness>
- <https://www.npmjs.com/package/@deepseek-ai/dsh>
