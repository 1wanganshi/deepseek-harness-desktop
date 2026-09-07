export function createStatusPanelTransition(
  resizeNativeView: (expanded: boolean) => Promise<void> | void,
  commitRenderedState: (expanded: boolean) => void,
): (expanded: boolean) => Promise<void> {
  let queue = Promise.resolve()

  return (expanded: boolean) => {
    const transition = queue.then(async () => {
      await resizeNativeView(expanded)
      commitRenderedState(expanded)
    })
    queue = transition.then(() => undefined, () => undefined)
    return transition
  }
}

export function createStatusPanelStateReconciler(
  readNativeState: () => Promise<boolean>,
  commitRenderedState: (expanded: boolean) => void,
): () => Promise<void> {
  let lastExpanded: boolean | undefined

  return async () => {
    const expanded = await readNativeState()
    if (expanded === lastExpanded) return
    lastExpanded = expanded
    commitRenderedState(expanded)
  }
}
