import type { HalotStatusReply } from './session.ts'

// The reading of each `printStatus` word and the PRINT_STOP conflict are in
// docs/protocols/halot.md, "Status".

export type HalotStatus = {
  state: 'idle' | 'printing' | 'paused' | 'error' | 'unknown'
  filename?: string
  progress?: number
  currentLayer?: number
  totalLayer?: number
  estimatedRemainingSeconds?: number
  statusMessage?: string
}

const unknown = (statusMessage: string): HalotStatus => ({
  state: 'unknown',
  statusMessage,
})

export function halotStatus(reply: HalotStatusReply): HalotStatus {
  const filename = reply.filename || undefined
  const named = filename ? { filename } : {}
  switch (reply.printStatus) {
    case 'PRINT_GENERAL':
      return filename
        ? {
            ...unknown('A impressora informa um arquivo, mas não a impressão.'),
            ...named,
          }
        : { state: 'idle' }
    case 'PRINT_COMPLETE':
    case 'PRINT_END':
      return { state: 'idle', ...named }
    case 'PRINT_FAIL':
      return {
        state: 'error',
        ...named,
        statusMessage: 'A impressora informa falha na impressão.',
      }
    case 'PRINT_STOPING':
      return {
        ...unknown('A impressora está interrompendo a impressão.'),
        ...named,
      }
    case 'PRINT_PROCESSING':
    case 'PRINT_COMPLETING':
      return job('printing', reply, named)
    case 'PRINT_PAUSE':
      return job('paused', reply, named)
    case 'PRINT_STOP':
      return {
        ...job('paused', reply, named),
        statusMessage:
          'A impressora informa PRINT_STOP: pausada ou interrompida. Confira na tela.',
      }
    default:
      return {
        ...unknown('A impressora informa um estado desconhecido.'),
        ...named,
      }
  }
}

/** A job state needs its layer position; progress is never invented. */
function job(
  state: 'printing' | 'paused',
  reply: HalotStatusReply,
  named: { filename?: string },
): HalotStatus {
  const {
    curSliceLayer: current,
    sliceLayerCount: total,
    printRemainTime: remaining,
  } = reply
  if (current === undefined || !total || current > total)
    return {
      ...unknown('A impressora não informa a camada atual.'),
      ...named,
    }
  return {
    state,
    ...named,
    progress: current / total,
    currentLayer: current,
    totalLayer: total,
    ...(remaining === undefined
      ? {}
      : { estimatedRemainingSeconds: remaining }),
  }
}
