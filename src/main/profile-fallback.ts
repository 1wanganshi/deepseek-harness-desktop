import { lstat, readdir, unlink } from 'node:fs/promises'

/**
 * Removes only the installation fallback links created by official DSH.
 *
 * The official Windows launcher rebuilds this flat directory on every boot,
 * but junctions left by an older installation can make Node report EEXIST
 * while the launcher is replacing them. Real directories are user-owned and
 * are deliberately preserved.
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
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      await unlink(path)
      removed += 1
    } else if (stats.isDirectory()) {
      removed += await clearProfileFallbackLinks(path)
    }
  }
  return removed
}
