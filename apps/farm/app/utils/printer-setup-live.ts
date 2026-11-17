import {
  observationAge,
  printerStateLabel,
  type FarmHealth,
  type FarmSnapshot,
} from './farm-view.ts'
import type {
  KobraEpoch,
  LiveConnection,
  Printer,
  PrinterSetupRefs,
} from './printer-setup-state.ts'
import { createAuthenticatedFarmStatusFeed } from './webrtc/farm-status-feed.ts'
import { createFarmStatusKeyResolver } from './webrtc/farm-status-key-resolver.ts'

export function createLiveStatus(state: PrinterSetupRefs, epoch: KobraEpoch) {
  const {
    farmId,
    printers,
    kobraKeyState,
    kobraKeyId,
    selectedKobraKey,
    liveConnections,
    liveObservations,
  } = state
  let feedHandles: { close(): void }[] = [],
    feedController: AbortController | undefined

  function closeLiveFeeds() {
    feedController?.abort()
    feedController = undefined
    for (const handle of feedHandles.splice(0)) {
      try {
        handle.close()
      } catch {}
    }
    liveConnections.value = {}
  }

  function startLiveStatusFeed() {
    closeLiveFeeds()
    const currentFarm = farmId.value
    const keyState = kobraKeyState.value
    const keyChoice = selectedKobraKey.value
    if (!currentFarm || keyState.kind !== 'available' || !keyChoice) return
    const activePrinters = printers.value.filter(
      (p) => p.status === 'active' && p.connectorStatus === 'approved',
    )
    if (!activePrinters.length) return
    const byAgent = new Map<string, Printer[]>()
    for (const printer of activePrinters) {
      const group = byAgent.get(printer.agentId) ?? []
      group.push(printer)
      byAgent.set(printer.agentId, group)
    }
    const currentController = new AbortController()
    feedController = currentController
    const accountId = keyState.accountId
    const viewEpoch = epoch.generation()
    const feed = createAuthenticatedFarmStatusFeed({
      resolveKey: createFarmStatusKeyResolver({
        isCurrent(scope, keyId) {
          return (
            !currentController.signal.aborted &&
            farmId.value === scope.farmId &&
            kobraKeyState.value.kind === 'available' &&
            kobraKeyState.value.accountId === scope.accountId &&
            kobraKeyId.value === keyId &&
            scope.viewEpoch === viewEpoch
          )
        },
      }),
    })
    for (const [targetAgentId, group] of byAgent.entries()) {
      const setAgentConnection = (status: LiveConnection) => {
        const next = { ...liveConnections.value }
        for (const item of group) next[item.assignmentId] = status
        liveConnections.value = next
      }
      setAgentConnection('connecting')
      const handle = feed.open({
        scope: { accountId, farmId: currentFarm, viewEpoch },
        agentId: targetAgentId,
        assignmentRefs: group.map((p) => ({
          assignmentId: p.assignmentId,
          agentId: p.agentId,
          printerKey: p.printerKey,
        })),
        browserKeyId: keyChoice.keyId,
        signal: currentController.signal,
        onHealth(health: FarmHealth) {
          if (currentController.signal.aborted) return
          if (health.kind === 'connecting' || health.kind === 'verifying') {
            setAgentConnection(health.kind)
          } else if (health.kind === 'authenticated') {
            setAgentConnection('authenticated')
          } else {
            setAgentConnection('closed')
            const nextObs = { ...liveObservations.value }
            for (const item of group) {
              const existing = nextObs[item.assignmentId]
              if (existing)
                nextObs[item.assignmentId] = { ...existing, historical: true }
            }
            liveObservations.value = nextObs
          }
        },
        onSnapshot(snapshot: FarmSnapshot) {
          if (currentController.signal.aborted) return
          const nextObs = { ...liveObservations.value }
          for (const item of group) {
            const found = snapshot.message.printers.find(
              (p) => p.printerKey === item.printerKey,
            )
            if (found) {
              nextObs[item.assignmentId] = {
                state: found,
                received: {
                  wall: snapshot.receivedAtWallMs,
                  mono: snapshot.receivedAtMonoMs,
                },
                sourceClockComparable: snapshot.sourceClockComparable,
                historical: false,
              }
            }
          }
          liveObservations.value = nextObs
        },
      })
      feedHandles.push(handle)
    }
  }

  return { closeLiveFeeds, startLiveStatusFeed }
}

type LiveView = Pick<
  PrinterSetupRefs,
  'liveConnections' | 'liveObservations' | 'liveTick'
>

export function liveConnectionLabel(
  { liveConnections, liveObservations }: LiveView,
  assignmentId: string,
): string {
  const status = liveConnections.value[assignmentId] ?? 'unavailable'
  const obs = liveObservations.value[assignmentId]
  switch (status) {
    case 'authenticated':
      return obs
        ? 'Conexão direta autenticada'
        : 'Conexão direta autenticada; aguardando estado.'
    case 'connecting':
      return 'Estabelecendo conexão direta…'
    case 'verifying':
      return 'Verificando conexão direta…'
    case 'closed':
      return obs
        ? 'Conexão direta indisponível. Exibindo a última observação.'
        : 'Conexão direta indisponível'
    case 'unavailable':
      return 'Conexão direta indisponível'
  }
}

export function livePrinterStateText(
  { liveObservations, liveTick }: LiveView,
  assignmentId: string,
): string {
  void liveTick.value
  const obs = liveObservations.value[assignmentId]
  if (!obs) return 'Nenhum estado recebido'
  const age = observationAge(obs, { wall: Date.now(), mono: performance.now() })
  const label = printerStateLabel[obs.state.state]
  return age.stale ? label + ' (desatualizado)' : label
}
