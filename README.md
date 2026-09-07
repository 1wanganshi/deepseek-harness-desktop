# DeepSeek Harness Desktop

Windows 10/11 x64 desktop host for the official [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) Web UI.

The desktop shell does not reimplement the official Harness UI. It starts the official local Web runtime on a random loopback port and embeds it in an Electron `WebContentsView`, so official sessions, tools, models, settings, and plugin UI remain the source of truth.

## Stability features

- Bundled Node runtime for click-to-run installation.
- Separate `DSH_HOME` under Electron user data; the desktop shell never reads or logs API keys.
- Local-only navigation, isolated preload IPC, and a single-instance desktop lock.
- Windows notification-area tray icon: window close hides the app while the Harness keeps running; minimize keeps the window on the taskbar; the tray menu can reopen the window or exit cleanly.
- Windows AppUserModelId, branded `.ico`, NSIS registration, and desktop/Start Menu shortcuts make the package a normal identifiable Windows application.
- Startup health check, five-second heartbeat, child-process exit monitoring, bounded exponential recovery, and Windows process-tree cleanup.
- Immutable bundled DSH runtime: the desktop never switches to an online candidate at startup or in the background. A new DSH version is delivered as a newly built installer, so every user runs the exact tested bundle.
- Community plugin sync backs up the Web profile, serializes concurrent requests, validates the profile, and restores the previous profile on failure.
- Diagnostics window with runtime paths, plugin names, bundled-version state, and recent lifecycle logs.
- Startup preflight and manual repair detect reasoning models behind OpenAI-compatible Providers and write `compat.supportsDeveloperRole: false` for the affected Provider, keeping `reasoningEfforts` enabled and avoiding the 400 error caused by unsupported `developer` roles.
- Desktop release `0.2.4` includes the executable repair-button flow for this 400 compatibility error; the repair window reports the Provider it changed and keeps the setting across restarts.
- First launch discovers the existing `%USERPROFILE%\\.dsh`, backs up both sides, and migrates model providers, credentials, Web plugins, sessions, attachments, and related user data into the isolated desktop `DSH_HOME`. The source directory is never deleted; old plugin `node_modules` is intentionally rebuilt from its lockfile.
- The NSIS installer creates a desktop shortcut and Start Menu shortcut. The installed app uses the same migrated data on later launches and never repeats the migration after its marker is written.

## First run

Open the installed app, then use the official Harness setup screen to configure the model API key and choose a workspace. Credentials and sessions remain owned by official DSH storage in the isolated `DSH_HOME` directory.

Remote model congestion cannot be eliminated by a desktop wrapper. The desktop improves local continuity and recovery; provider retries and alternate providers still depend on what is configured in the official Harness Settings → Models screen.

## 0.2.24 版本介绍

- **会话持久化加固**：新增 `session-durability` 模块，启动时自动恢复丢失的会话索引，把"孤儿会话"重新挂回所属工作区，并按日期保留安全快照，历史会话不会因索引损坏而消失。
- **配置持久化保护**：新增 `configuration-durability` 模块，对 `settings.yaml`、`.credentials.yaml` 和 Web profile 依赖清单做快照保护，模型 Provider 与密钥配置异常时可从本地安全快照自动恢复。
- **启动恢复强化**：启动预检自动清理任务板陈旧进程锁、过期 Harness 认证 Cookie 与失效的 profile 回退链接；缺失的 profile 依赖会自动重建；当官方 Harness 版本低于任务板插件要求时自动禁用不兼容入口（插件文件与配置保留）。
- **最小化行为修复**：最小化时窗口正常保留在任务栏（与普通 Windows 应用一致）；仅点击关闭按钮时收进系统托盘，后台 Harness 继续运行。
- **打包完整性补丁**：新增 `scripts/patch-bundled-runtime.mjs`，打包后自动补全被依赖收集器遗漏的官方运行时包（`dsh-jobs`、`dsh-settings`、`dsh-bash-local`、`dsh-client-runtime`、`dsh-host-apiproxy`、`dsh-tool-subagent-report`、`dsh-authorization`），修复独立安装后设置页无法加载大模型配置的问题。
- **插件加载器**：新增 `resources/npm-loader.cjs`，为 Web profile 插件提供统一的模块解析入口，降低第三方插件因依赖解析失败导致的加载降级。
- **质量基线**：37 个测试文件、135 个用例全部通过，`pnpm typecheck` 无错误。

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

The NSIS installer is written to `release/` and includes the branded icon plus the bundled Node runtime. The package is currently unsigned, so Windows SmartScreen may show an unknown-publisher warning. Desktop upgrades are distributed as new installers; the installed app intentionally has no online update button.

Official references:

- <https://www.deepseek.com/harness/en/>
- <https://github.com/deepseek-ai/deepseek-harness>
- <https://www.npmjs.com/package/@deepseek-ai/dsh>
