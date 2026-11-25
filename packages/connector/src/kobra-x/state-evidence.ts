import { record } from './discovery.ts'
import { isKobraXActivePhase } from './facts.ts'
import { reportRefusal, type KobraXReport } from './requests.ts'

export const kobraXQueries = {
  info: 'query',
  status: 'query',
  print: 'query',
  tempature: 'query',
  multiColorBox: 'getInfo',
  // The external spool; read-only, as spooler's `kx_request` sends it.
  extfilbox: 'getInfo',
} as const
export type KobraXQuery = keyof typeof kobraXQueries

export function createKobraXQueryEvidence() {
  const pending = new Map<string, string>()
  // Keep recently used IDs to recognize delayed info/report replies, whose
  // action is also used by unsolicited telemetry.
  const issued = new Set<string>()
  return {
    issue(type: KobraXQuery, id: string) {
      pending.set(type, id)
      issued.add(id)
      if (issued.size > 64) issued.delete(issued.values().next().value!)
    },
    classify(report: KobraXReport): 'current' | 'stale' | 'other' {
      const { type, action, msgid } = report
      const expected = kobraXQueries[type as KobraXQuery]
      const answersQuery =
        expected &&
        (action === expected || (type === 'info' && action === 'report'))
      if (answersQuery && pending.get(type) === msgid) {
        pending.delete(type)
        return 'current'
      }
      return issued.has(msgid) ? 'stale' : 'other'
    },
    resetPending: () => pending.clear(),
    reset() {
      pending.clear()
      issued.clear()
    },
  }
}

type PrintState = 'idle' | 'cancelled' | 'printing' | 'paused'
interface StateEvidence {
  printState: PrintState
  filename?: string
  taskId?: string
  phase?: string
}

function isKobraXStateReport({ type, action, data }: KobraXReport) {
  return (
    (type === 'print' && action !== 'getSliceParam' && action !== 'update') ||
    ((type === 'info' || type === 'status') &&
      (action === 'query' || action === 'report' || 'state' in data))
  )
}

function readPrint(report: KobraXReport): StateEvidence | undefined {
  const { state, data } = report
  if (state === 'free' || state === 'finished' || state === 'stoped')
    return { printState: state === 'stoped' ? 'cancelled' : 'idle' }
  if (!isKobraXActivePhase(state)) return
  if (data.filename !== undefined && typeof data.filename !== 'string') return
  if (data.taskid !== undefined && typeof data.taskid !== 'string') return
  return {
    printState: state === 'paused' ? 'paused' : 'printing',
    phase: state,
    ...(typeof data.filename === 'string' ? { filename: data.filename } : {}),
    ...(typeof data.taskid === 'string' ? { taskId: data.taskid } : {}),
  }
}

export function createKobraXStateEvidence() {
  let machine: 'free' | 'busy' | undefined
  let print: StateEvidence | undefined
  let current: StateEvidence | undefined
  let invalid = false
  const machines = new Map<
    string,
    {
      state: 'free' | 'busy'
      project: Record<string, unknown>
    }
  >()
  function disagreesWithJob(
    project: Record<string, unknown>,
    job: StateEvidence,
  ) {
    return (
      (project.filename !== undefined &&
        job.filename !== undefined &&
        project.filename !== job.filename) ||
      (project.taskid !== undefined &&
        job.taskId !== undefined &&
        project.taskid !== job.taskId)
    )
  }
  function invalidate() {
    current = undefined
    invalid = true
    return true
  }
  return {
    get: () => current,
    invalidated: () => invalid,
    reset() {
      invalid = false
      machines.clear()
      machine = undefined
      print = undefined
      current = undefined
    },
    report(report: KobraXReport, correlated: boolean) {
      if (invalid || !isKobraXStateReport(report)) return false
      const isPrint = report.type === 'print'
      const observedPrint = isPrint ? readPrint(report) : undefined
      const { state, project } = report.data
      const job = record(project)
      const observedMachine =
        !isPrint &&
        (job.filename === undefined || typeof job.filename === 'string') &&
        (job.taskid === undefined || typeof job.taskid === 'string') &&
        ((state === 'free' && project == null) ||
          (state === 'busy' &&
            (project == null ||
              (typeof project === 'object' && !Array.isArray(project)))))
          ? state
          : undefined
      if (reportRefusal(report) !== null)
        return correlated || current || print || machine ? invalidate() : false
      if (correlated && report.code === undefined) return invalidate()
      if (!correlated) {
        if (!current) return false
        const agrees = isPrint
          ? observedPrint?.printState === current.printState &&
            observedPrint.phase === current.phase &&
            (observedPrint.filename === undefined ||
              observedPrint.filename === current.filename) &&
            (observedPrint.taskId === undefined ||
              observedPrint.taskId === current.taskId)
          : observedMachine === machine && !disagreesWithJob(job, current)
        if (agrees) return false
        return invalidate()
      }
      if (isPrint ? !observedPrint : !observedMachine) {
        return invalidate()
      }
      if (isPrint) print = observedPrint
      else if (observedMachine) {
        machines.set(report.type, { state: observedMachine, project: job })
        if (
          [...machines.values()].some(
            (value) => value.state !== observedMachine,
          )
        )
          return invalidate()
        machine = observedMachine
      }
      const active =
        print?.printState === 'printing' || print?.printState === 'paused'
      if (
        machine &&
        print &&
        ((machine === 'free') === active ||
          [...machines.values()].some(({ project }) =>
            disagreesWithJob(project, print!),
          ))
      ) {
        return invalidate()
      }
      current =
        machine === 'free'
          ? (print ?? { printState: 'idle' })
          : machine === 'busy' && active
            ? print
            : undefined
      return true
    },
  }
}
