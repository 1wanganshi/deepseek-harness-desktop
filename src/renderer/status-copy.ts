import type { RuntimeState, UpdateStatus } from '../shared/types.js'

export function updateBadgeLabel(status: UpdateStatus | null): string {
  if (status === null) return '检查更新中'
  return status.updateAvailable ? '有更新' : '已是最新'
}

/**
 * Whether the shell should take over the content area with the placeholder
 * card.
 *
 * It must *not*: a transient recovery used to hide the official page and paint
 * a full-screen "正在重新建立本机连接", which is what made a few seconds of
 * reconnect look like the whole app restarting. The page stays; only the
 * control bar reports trouble. The card appears only when the runtime is not
 * coming back on its own — a latched `error`, a user stop, or a runtime that
 * has never started.
 */
export function shouldShowPlaceholder(state: RuntimeState): boolean {
  if (state.status === 'running' || state.status === 'recovering') return false
  if (state.status === 'error' || state.status === 'stopped') return true
  // 'starting': with attention raised the user asked for (or just lost) a
  // runtime, so show it; an initial silent boot keeps the page.
  return state.harnessAttention
}

/**
 * Whether the floating status pill should be rendered. Collapsed, it is the
 * only place the runtime status is visible.
 */
export function shouldShowStatusLauncher(state: RuntimeState, panelExpanded: boolean): boolean {
  return !panelExpanded || state.harnessAttention
}

export function placeholderTitle(state: RuntimeState): string {
  if (state.status === 'error') return state.restartPaused ? '需要诊断' : '运行时未启动'
  if (state.status === 'stopped') return '运行时已停止'
  return '正在启动'
}

export function placeholderMessage(state: RuntimeState): string {
  if (state.status === 'stopped') {
    return '官方 Harness 当前没有运行。你的模型、凭据和会话仍保存在本机。'
  }
  // The old copy promised an automatic reconnect; say what is actually true.
  const base = '官方页面暂时无法重新连接。你的模型、凭据和会话仍保存在本机，其他会话不受影响。'
  return state.restartPaused ? `${base}自动重试已暂停，请点「维修」或「重启」。` : base
}
