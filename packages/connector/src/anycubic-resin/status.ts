import type { PhotonResinState } from './session.ts'

/** A job report older than this no longer describes the current job. */
export const PHOTON_RESIN_FRESH_MS = 5000

export type PhotonResinStatus = {
  state: 'idle' | 'printing' | 'unknown'
  /** Present only while a current report names a job the stop can address. */
  stoppableJob?: { filename: string; taskId: string }
  filename?: string
  progress?: number
  currentLayer?: number
  totalLayer?: number
  statusMessage?: string
}

/**
 * Maps one session state. Only `free`, `printing` and `waiting` were captured
 * (photonP1MaxSources): anything else, and any contradiction, stays unknown.
 */
export function photonResinStatus(
  session: PhotonResinState,
  now: number,
): PhotonResinStatus {
  const { job, printer } = session
  const free = printer?.activity === 'free'
  if (!job || job.phase === 'stopped')
    return { state: free ? 'idle' : 'unknown' }
  const fresh = now - job.observedAt <= PHOTON_RESIN_FRESH_MS
  if (!fresh || (job.phase !== 'printing' && job.phase !== 'waiting'))
    return { state: 'unknown' }
  const { filename, taskId, progressPercent, layer, totalLayers, code } = job
  const stoppable = filename && taskId && taskId !== '-1'
  return {
    // A printing row requires progress; without it the state stays unknown.
    state: progressPercent === null ? 'unknown' : 'printing',
    ...(stoppable ? { stoppableJob: { filename, taskId } } : {}),
    ...(filename ? { filename } : {}),
    ...(progressPercent === null ? {} : { progress: progressPercent / 100 }),
    ...(layer === null ? {} : { currentLayer: layer }),
    ...(totalLayers === null ? {} : { totalLayer: totalLayers }),
    ...(job.phase === 'waiting'
      ? {
          statusMessage: `Impressora aguardando${code === null ? '' : ` (código ${code})`}`,
        }
      : {}),
  }
}
