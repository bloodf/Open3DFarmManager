// Stands in for utils/webrtc/farm-pause-control.ts in the files design
// captures: it only lists fixed files. No command leaves the page.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXkAAAAASUVORK5CYII='

export const PAUSE_CAPABILITY_MARGIN_MS = 3000

export function openFarmPauseControl(input: {
  onState(value: { kind: 'ready' }): void
}) {
  queueMicrotask(() => input.onState({ kind: 'ready' }))
  return {
    listFiles: async () => ({
      ok: true as const,
      files: [
        {
          name: 'vaso-espiral.gcode',
          size: 2097152,
          modified: 0,
          thumbnail: PIXEL,
        },
        {
          name: 'suporte-de-bancada-com-nome-bem-comprido.gcode',
          size: 524288,
          modified: 0,
          thumbnail: PIXEL,
        },
      ],
    }),
    close() {},
    async dispose() {},
  }
}
