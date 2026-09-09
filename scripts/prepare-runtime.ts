import { execFileSync } from 'node:child_process'
import { access, copyFile, cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

interface TargetSpec {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
}

function parseTarget(args: string[]): TargetSpec | null {
  let platform: NodeJS.Platform | undefined
  let arch: NodeJS.Architecture | undefined
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--platform' && index + 1 < args.length) {
      platform = args[index + 1] as NodeJS.Platform
      index += 1
    } else if (args[index] === '--arch' && index + 1 < args.length) {
      arch = args[index + 1] as NodeJS.Architecture
      index += 1
    }
  }
  if (platform === undefined && arch === undefined) return null
  return { platform: platform ?? process.platform, arch: arch ?? process.arch }
}

function runTool(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

async function downloadNodeBinary(target: TargetSpec): Promise<void> {
  const version = process.versions.node
  const isWindows = target.platform === 'win32'
  const fileName = isWindows
    ? `node-v${version}-${target.platform}-${target.arch}.zip`
    : `node-v${version}-${target.platform}-${target.arch}.tar.gz`
  const url = `https://nodejs.org/dist/v${version}/${fileName}`
  console.log(`Downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download node binary: HTTP ${response.status}`)
  const archive = join(projectRoot, 'resources', fileName)
  await mkdir(dirname(archive), { recursive: true })
  await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  const nodeDir = join(projectRoot, 'resources', 'node')
  await rm(nodeDir, { recursive: true, force: true })
  await mkdir(nodeDir, { recursive: true })
  const extractedDir = join(projectRoot, 'resources', `node-v${version}-${target.platform}-${target.arch}`)
  if (isWindows) {
    runTool('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${join(projectRoot, 'resources')}" -Force`,
    ])
    await copyFile(join(extractedDir, 'node.exe'), join(nodeDir, 'node.exe'))
  } else {
    runTool('tar', ['xzf', archive, '-C', join(projectRoot, 'resources')])
    await copyFile(join(extractedDir, 'bin', 'node'), join(nodeDir, 'node'))
  }
  await rm(extractedDir, { recursive: true, force: true })
  await rm(archive, { force: true })
}

const requested = parseTarget(process.argv.slice(2))
const target: TargetSpec = requested ?? { platform: process.platform, arch: process.arch }
const destination = join(projectRoot, 'resources', 'node', target.platform === 'win32' ? 'node.exe' : 'node')
await mkdir(dirname(destination), { recursive: true })

if (target.platform !== process.platform || target.arch !== process.arch) {
  await downloadNodeBinary(target)
  console.log(`Bundled Node runtime (downloaded ${target.platform}-${target.arch}): ${destination}`)
} else {
  try {
    await access(destination)
  } catch {
    await copyFile(process.execPath, destination)
  }
  console.log(`Bundled Node runtime: ${destination}`)
}

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
