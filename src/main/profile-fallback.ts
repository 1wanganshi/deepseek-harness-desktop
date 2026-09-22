import { lstat, readdir, readlink, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Removes stale installation fallback links created by the official DSH
 * launcher, leaving every link that still resolves.
 *
 * The launcher builds a flat directory of links so its plugin loader can
 * resolve packages that live in the pnpm store. A previous installation can
 * leave a link behind whose target no longer exists, and Node then reports
 * EEXIST while the launcher rebuilds the directory, which aborts the boot.
 *
 * Only broken links are removed. Earlier versions deleted every symlink on
 * each boot, which destroyed the working dependency map the running Harness
 * depends on: the runtime then failed to resolve its own packages, the desktop
 * shell restarted it, and the two formed an endless restart loop.
 */
export async function clearProfileFallbackLinks(root: string): Promise<number> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }

  let removed = 0
  for (const entry of entries) {
    const path = `${root}/${entry.name}`
    let stats
    try {
      stats = await lstat(path)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) {
      if (await isBrokenLink(path, root)) {
        await unlink(path)
        removed += 1
      }
      continue
    }
    if (stats.isDirectory()) {
      removed += await clearProfileFallbackLinks(path)
    }
  }
  return removed
}

/** A link is stale when its target no longer exists. */
async function isBrokenLink(path: string, root: string): Promise<boolean> {
  try {
    const target = await readlink(path)
    // readlink returns the raw target; resolve it the way Node would.
    const absolute = target.startsWith('/') || /^[A-Za-z]:/.test(target)
      ? target
      : resolve(root, target)
    await lstat(absolute)
    return false
  } catch {
    return true
  }
}
