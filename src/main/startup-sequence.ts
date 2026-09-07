export async function startAfterProfilePreparation<T>(
  preparation: Promise<unknown>,
  start: () => Promise<T>,
): Promise<T> {
  await preparation
  return start()
}
