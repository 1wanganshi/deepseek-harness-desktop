export interface HarnessLoader {
  setDesiredUrl(url: string | null): void
  clearLoadedUrl(): void
  load(url: string): Promise<void>
}

export function createHarnessLoader(
  loadUrl: (url: string) => Promise<void>,
  setVisible: (visible: boolean) => void,
): HarnessLoader {
  let desiredUrl: string | null = null
  let loadedUrl: string | null = null
  let queue = Promise.resolve()
  let runningOrQueued = false
  let pending = new Map<string, Promise<void>>()
  let visible: boolean | null = null

  const setVisibility = (nextVisible: boolean): void => {
    if (visible === nextVisible) return
    visible = nextVisible
    setVisible(nextVisible)
  }

  const loader: HarnessLoader = {
    setDesiredUrl(url) {
      desiredUrl = url
      if (url === null) setVisibility(false)
    },

    clearLoadedUrl() {
      loadedUrl = null
    },

    load(url) {
      const existing = pending.get(url)
      if (existing !== undefined) return existing

      const perform = async (): Promise<void> => {
        if (desiredUrl !== url) return
        if (loadedUrl === url) {
          setVisibility(true)
          return
        }

        if (loadedUrl !== null) setVisibility(false)
        try {
          await loadUrl(url)
          if (desiredUrl !== url) {
            setVisibility(false)
            return
          }
          loadedUrl = url
          setVisibility(true)
        } catch (error) {
          if (desiredUrl === url) {
            loadedUrl = null
            setVisibility(false)
          }
          throw error
        }
      }
      const promise = runningOrQueued
        ? queue.then(perform)
        : perform()
      runningOrQueued = true
      queue = promise.catch(() => undefined)
      pending.set(url, promise)
      pendingCount++
      void promise.then(
        () => finish(url, promise),
        () => finish(url, promise),
      )
      return promise
    },
  }

  let pendingCount = 0
  const finish = (url: string, promise: Promise<void>): void => {
    if (pending.get(url) === promise) pending.delete(url)
    pendingCount--
    if (pendingCount === 0) runningOrQueued = false
  }
  return loader
}
