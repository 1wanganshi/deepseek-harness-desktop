import { access, copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = process.execPath
const destination = join(projectRoot, 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node')

await mkdir(dirname(destination), { recursive: true })
try {
  await access(destination)
} catch {
  await copyFile(source, destination)
}
console.log(`Bundled Node runtime: ${destination}`)
