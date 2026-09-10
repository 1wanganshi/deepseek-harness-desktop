import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import electron from 'electron'

// The Electron main process is CommonJS: named ESM imports only work when the
// bundler's static analysis can prove they exist. Resolve the namespace at
// runtime so this module stays loadable regardless of that interop heuristic.
const { dialog } = electron

export interface PickerBridge {
  port: number
  token: string
  close: () => void
}

/**
 * macOS refuses user-interaction (AppleScript error -1713) for the supervised
 * Harness server process, so the official "choose folder" picker can never
 * show its dialog. The bundled osascript shim intercepts that one call and
 * asks this loopback bridge to present Electron's native directory dialog
 * instead, which runs in the desktop shell's own GUI context.
 */
export function resolveMacOsBinDir(appRoot: string): string | null {
  const packaged = join(process.resourcesPath, 'macos-bin')
  if (existsSync(join(packaged, 'osascript'))) return packaged
  const repo = join(appRoot, 'resources', 'macos-bin')
  if (existsSync(join(repo, 'osascript'))) return repo
  return null
}

export async function startPickerBridge(): Promise<PickerBridge> {
  const token = randomUUID()
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (request.method === 'POST' && url === `/${token}/pick-directory`) {
      let raw = ''
      request.on('data', chunk => {
        raw += chunk.toString()
        if (raw.length > 8192) request.destroy()
      })
      request.on('end', () => {
        let prompt = 'Select Workspace Directory'
        try {
          const parsed = JSON.parse(raw) as { prompt?: unknown }
          if (typeof parsed.prompt === 'string' && parsed.prompt.trim() !== '') prompt = parsed.prompt
        } catch {
          // Malformed body keeps the default prompt; picking still works.
        }
        let requestDialog: Promise<Electron.OpenDialogReturnValue>
        try {
          requestDialog = dialog.showOpenDialog({
            title: prompt,
            message: prompt,
            properties: ['openDirectory', 'createDirectory'],
          })
        } catch (error) {
          response.statusCode = 500
          response.end()
          return
        }
        void requestDialog.then(result => {
          if (result.canceled || result.filePaths.length === 0) {
            response.statusCode = 204
            response.end()
            return
          }
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/plain; charset=utf-8')
          response.end(result.filePaths[0])
        }).catch(() => {
          response.statusCode = 500
          response.end()
        })
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, token, close: () => server.close() }
}
