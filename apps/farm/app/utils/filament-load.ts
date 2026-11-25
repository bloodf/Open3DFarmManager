export function filamentLoadArgs(input: { id: number } | undefined) {
  return input ? { tray: input.id } : undefined
}
