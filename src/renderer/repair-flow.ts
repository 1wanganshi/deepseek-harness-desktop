export function shouldAutoStartRepair(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.get('repair') === '1' && params.get('auto') === '1'
}
