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
