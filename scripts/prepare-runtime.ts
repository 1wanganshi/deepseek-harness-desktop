import { access, copyFile, cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
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

const npmSource = join(projectRoot, 'node_modules', 'npm')
const npmDestination = join(projectRoot, 'resources', 'npm')
const npmDepsDestination = join(projectRoot, 'resources', 'npm-deps')
await rm(npmDestination, { recursive: true, force: true })
await cp(npmSource, npmDestination, { recursive: true, dereference: true })
await rm(npmDepsDestination, { recursive: true, force: true })
await cp(npmSource, npmDepsDestination, { recursive: true, dereference: true })

async function renameDependencyDirectories(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const sourcePath = join(root, entry.name)
    if (!entry.isDirectory()) continue
    await renameDependencyDirectories(sourcePath)
    if (entry.name === 'node_modules') {
      await rename(sourcePath, join(root, 'deps'))
    }
  }
}

await renameDependencyDirectories(npmDepsDestination)
await rm(join(npmDestination, 'node_modules'), { recursive: true, force: true })
console.log(`Bundled npm CLI: ${npmDestination}`)
