import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledNpmDepsPath, bundledNpmScript, bundledPnpmScript, runCommand } from '../src/main/command.js'

const node = process.execPath

describe('runCommand', () => {
  it('resolves when the command exits with code 0', async () => {
    await runCommand(node, ['-e', 'process.stdout.write("ok")'], process.cwd())
  })

  it('rejects with exit output when the command fails', async () => {
    await expect(runCommand(node, ['-e', 'process.stderr.write("boom"); process.exit(3)'], process.cwd()))
      .rejects.toThrow(/failed with code 3/)
  })

  it('rejects when the executable cannot be spawned', async () => {
    await expect(runCommand('definitely-not-a-real-command-xyz', ['--version'], process.cwd()))
      .rejects.toThrow()
  })

  it('never hangs forever: a stuck child is killed after the timeout', async () => {
    const startedAt = Date.now()
    await expect(runCommand(
      node,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      process.env,
      { timeoutMs: 500 },
    )).rejects.toThrow(/timed out after 500ms/)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(10_000)
  })

  it('caps captured output so huge logs cannot exhaust memory', async () => {
    // Emit ~2MB; the capture buffer must stay bounded and the rejection
    // message must still surface the tail.
    await expect(runCommand(
      node,
      ['-e', 'process.stdout.write("x".repeat(2_000_000)); process.exit(1)'],
      process.cwd(),
      process.env,
      { maxOutputChars: 5_000 },
    )).rejects.toThrow(/failed with code 1/)
  })

  it('loads a preloader from a Windows path with spaces set through NODE_OPTIONS', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh npm loader '))
    const loader = join(fixture, 'loader.cjs')
    const marker = join(fixture, 'loaded.txt')
    try {
      await writeFile(loader, "require('node:fs').writeFileSync(process.env.DSH_TEST_PRELOAD_MARKER, 'loaded')")
      await runCommand(
        node,
        ['-e', "if (!require('node:fs').existsSync(process.env.DSH_TEST_PRELOAD_MARKER)) process.exit(9)"],
        process.cwd(),
        {
          ...process.env,
          DSH_TEST_PRELOAD_MARKER: marker,
          NODE_OPTIONS: `--require=${loader}`,
        },
      )
      await expect(readFile(marker, 'utf8')).resolves.toBe('loaded')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('resolves ESM npm dependencies from the renamed dependency tree', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh npm esm '))
    const dependencyRoot = join(fixture, 'npm-deps')
    const packageRoot = join(dependencyRoot, 'deps', 'chalk')
    const workingDirectory = join(fixture, 'work')
    try {
      await mkdir(packageRoot, { recursive: true })
      await mkdir(workingDirectory, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'chalk',
        type: 'module',
        exports: './index.js',
      }))
      await writeFile(join(packageRoot, 'index.js'), "export default 'resolved-from-npm-deps'\n")
      await runCommand(
        node,
        ['--input-type=module', '-e', "const mod = await import('chalk'); if (mod.default !== 'resolved-from-npm-deps') process.exit(9)"],
        workingDirectory,
        {
          ...process.env,
          DSH_NPM_DEPS: dependencyRoot,
          NODE_OPTIONS: `--require=${join(process.cwd(), 'resources', 'npm-loader.cjs')}`,
        },
      )
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('bundledPnpmScript', () => {
  it('points at the pnpm binary shipped in app dependencies', () => {
    expect(bundledPnpmScript('C:/app/root')).toBe(
      join('C:/app/root', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    )
  })
})

describe('bundledNpmScript', () => {
  it('points at the npm CLI shipped in app dependencies', () => {
    expect(bundledNpmScript('C:/app/root')).toBe(
      join('C:/app/root', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  })

  it('can point at the complete npm copy shipped beside the app', () => {
    expect(bundledNpmScript('C:/app/root', 'C:/app/resources')).toBe(
      join('C:/app/resources', 'npm', 'bin', 'npm-cli.js'),
    )
  })
})

describe('bundledNpmDepsPath', () => {
  it('points at the dependency directory beside the packaged npm CLI', () => {
    expect(bundledNpmDepsPath('C:/app/resources')).toBe(
      join('C:/app/resources', 'npm-deps'),
    )
  })
})
