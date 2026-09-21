import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const controllerPath = fileURLToPath(new URL('../src/main/runtime-controller.ts', import.meta.url))

/**
 * The shutdown guarantee lives in statements, not in a return value, so it can
 * only be asserted against the source. The force kill must always come after a
 * graceful close request with a grace window in between: destroying the tree
 * outright is what lost in-flight sessions at exit.
 */
describe('runtime shutdown sequencing', () => {
  it('requests a graceful close and forces the tree down only after the grace window', async () => {
    const source = await readFile(controllerPath, 'utf8')
    const windowsBranch = /if \(process\.platform === 'win32' && child\.pid !== undefined\) \{([\s\S]*?)\n    \}/.exec(source)
    expect(windowsBranch).not.toBeNull()
    const body = windowsBranch![1]
    const gracefulAt = body.indexOf('await requestWindowsRuntimeShutdown(child.pid)')
    const graceAt = body.indexOf('await waitForChildExit(child, CHILD_SHUTDOWN_GRACE_MS)')
    const forceAt = body.indexOf('await terminateWindowsRuntimeTree(child.pid)')
    expect(gracefulAt).toBeGreaterThanOrEqual(0)
    expect(graceAt).toBeGreaterThan(gracefulAt)
    expect(forceAt).toBeGreaterThan(graceAt)
    expect(body).toContain('if (!exited)')
  })
})
