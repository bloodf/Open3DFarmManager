import {
  observationAge,
  type FarmRow,
  type FarmViewState,
} from './farm-view.ts'

export type Clock = { wall: number; mono: number }

export type FarmAlertKind =
  | 'error'
  | 'connector-storage-degraded'
  | 'offline-or-stale'
  | 'paused'
  | 'finished-bed-clear'
  | 'low-slot'
  | 'firmware-update'

export type FarmAlertTone =
  'error' | 'offline' | 'stale' | 'paused' | 'printing' | 'idle'

export interface FarmAlert {
  id: string
  kind: FarmAlertKind
  tone: FarmAlertTone
  icon: string
  label: string
  message: string
  targetLabel: string
  href: string
  agentId: string
  assignmentId?: string
  printerKey?: string
}

export interface FarmAlertsSummary {
  alerts: readonly FarmAlert[]
  total: number
  counts: Readonly<Record<FarmAlertKind, number>>
  byAssignment: Readonly<Record<string, readonly FarmAlert[]>>
  announcement: string
}

export type FarmAlertsInput =
  | FarmViewState
  | {
      kind?: 'ready'
      rows: readonly FarmRow[]
      connectorStorage?: Readonly<Record<string, 'degraded'>>
    }
  | null
  | undefined

export const FARM_ALERT_ORDER: readonly FarmAlertKind[] = [
  'error',
  'connector-storage-degraded',
  'offline-or-stale',
  'paused',
  'finished-bed-clear',
  'low-slot',
  'firmware-update',
]

export const FARM_ALERT_META: Readonly<
  Record<
    FarmAlertKind,
    { label: string; countLabel: string; tone: FarmAlertTone; icon: string }
  >
> = {
  error: {
    label: 'Erro',
    countLabel: 'em erro',
    tone: 'error',
    icon: '!',
  },
  'connector-storage-degraded': {
    label: 'Armazenamento do Connector degradado',
    countLabel: 'armazenamento do Connector degradado',
    tone: 'error',
    icon: '!',
  },
  'offline-or-stale': {
    label: 'Offline ou desatualizado',
    countLabel: 'offline ou com dados desatualizados',
    tone: 'offline',
    icon: '×',
  },
  paused: {
    label: 'Pausada',
    countLabel: 'em pausa',
    tone: 'paused',
    icon: 'Ⅱ',
  },
  'finished-bed-clear': {
    label: 'Aguardando limpeza da mesa',
    countLabel: 'aguardando limpeza da mesa',
    tone: 'printing',
    icon: '✓',
  },
  'low-slot': {
    label: 'Filamento abaixo de 10%',
    countLabel: 'com filamento abaixo de 10%',
    tone: 'paused',
    icon: '◔',
  },
  'firmware-update': {
    label: 'Atualização de firmware',
    countLabel: 'com atualização de firmware',
    tone: 'printing',
    icon: '↑',
  },
}

const kindOrder = new Map<FarmAlertKind, number>(
  FARM_ALERT_ORDER.map((kind, index) => [kind, index]),
)

function emptyCounts(): Record<FarmAlertKind, number> {
  return {
    error: 0,
    'connector-storage-degraded': 0,
    'offline-or-stale': 0,
    paused: 0,
    'finished-bed-clear': 0,
    'low-slot': 0,
    'firmware-update': 0,
  }
}

function formatSlotName(slot: string): string {
  const match = /^ams:([0-3]):([0-3])$/.exec(slot)
  if (match)
    return `AMS ${Number(match[1]) + 1}, bandeja ${Number(match[2]) + 1}`
  if (slot === 'external') return 'Bobina externa'
  return slot
}

function formatPercentPtBr(value: number): string {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

function derivePrinterAlerts(row: FarmRow, now: Clock): FarmAlert[] {
  const alerts: FarmAlert[] = []
  const obs = row.observation
  const { assignmentId, agentId, printerKey } = row.assignment
  const href = `#printer-${assignmentId}`

  if (obs?.state.state === 'error') {
    alerts.push({
      id: `${assignmentId}:error`,
      kind: 'error',
      tone: 'error',
      icon: '!',
      label: 'Erro',
      message: 'Impressora em estado de erro.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  if (obs?.state.state === 'offline') {
    const missingCert = obs.state.statusReason === 'client-certificate-missing'
    alerts.push({
      id: `${assignmentId}:offline-or-stale`,
      kind: 'offline-or-stale',
      tone: 'offline',
      icon: '×',
      label: missingCert ? 'Certificado ausente' : 'Offline',
      message: missingCert
        ? 'Certificado do cliente ausente; impressora indisponível segundo o Connector.'
        : 'Impressora indisponível segundo o Connector.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  } else if (obs === null && row.connection === 'closed') {
    alerts.push({
      id: `${assignmentId}:offline-or-stale`,
      kind: 'offline-or-stale',
      tone: 'offline',
      icon: '×',
      label: 'Offline',
      message: 'Conexão direta encerrada sem estado recebido.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  } else if (
    obs !== null &&
    (row.connection !== 'authenticated' || observationAge(obs, now).stale)
  ) {
    alerts.push({
      id: `${assignmentId}:offline-or-stale`,
      kind: 'offline-or-stale',
      tone: 'stale',
      icon: '◷',
      label: 'Dados desatualizados',
      message: 'Dados desatualizados ou sem conexão direta ativa.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  if (obs?.state.state === 'paused') {
    alerts.push({
      id: `${assignmentId}:paused`,
      kind: 'paused',
      tone: 'paused',
      icon: 'Ⅱ',
      label: 'Pausada',
      message: obs.state.filename
        ? `Impressão pausada (${obs.state.filename}).`
        : 'Impressão pausada.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  if (
    obs?.state.state === 'idle' &&
    obs.state.lastJob?.outcome === 'completed'
  ) {
    alerts.push({
      id: `${assignmentId}:finished-bed-clear`,
      kind: 'finished-bed-clear',
      tone: 'printing',
      icon: '✓',
      label: 'Aguardando limpeza da mesa',
      message: obs.state.lastJob.filename
        ? `Impressão concluída (${obs.state.lastJob.filename}); aguardando limpeza da mesa.`
        : 'Impressão concluída; aguardando limpeza da mesa.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  const lowSlots = (obs?.state.materials ?? []).filter(
    (material): material is typeof material & { remainingPercent: number } =>
      material.remainingPercent !== undefined &&
      Number.isFinite(material.remainingPercent) &&
      material.remainingPercent < 10,
  )
  if (lowSlots.length > 0) {
    const details = lowSlots.map(
      (material) =>
        `${formatSlotName(material.slot)} (${formatPercentPtBr(material.remainingPercent)})`,
    )
    alerts.push({
      id: `${assignmentId}:low-slot`,
      kind: 'low-slot',
      tone: 'paused',
      icon: '◔',
      label: 'Filamento abaixo de 10%',
      message: `Filamento abaixo de 10%: ${details.join('; ')}.`,
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  if (obs?.state.firmware?.updateAvailable === true) {
    alerts.push({
      id: `${assignmentId}:firmware-update`,
      kind: 'firmware-update',
      tone: 'printing',
      icon: '↑',
      label: 'Atualização de firmware',
      message: obs.state.firmware.latest
        ? `Atualização de firmware disponível (${obs.state.firmware.latest}).`
        : 'Atualização de firmware disponível.',
      targetLabel: printerKey,
      href,
      agentId,
      assignmentId,
      printerKey,
    })
  }

  return alerts
}

export function deriveRowAlerts(
  row: FarmRow,
  now: Clock,
  connectorStorage?: Readonly<Record<string, 'degraded'>>,
): FarmAlert[] {
  const alerts = derivePrinterAlerts(row, now)
  if (connectorStorage?.[row.assignment.agentId] === 'degraded') {
    const { assignmentId, agentId, printerKey } = row.assignment
    alerts.push({
      id: `${assignmentId}:connector-storage-degraded`,
      kind: 'connector-storage-degraded',
      tone: 'error',
      icon: '!',
      label: 'Armazenamento do Connector degradado',
      message:
        'Armazenamento do Connector degradado; novos registros não são gravados e comandos são recusados.',
      targetLabel: printerKey,
      href: `#printer-${assignmentId}`,
      agentId,
      assignmentId,
      printerKey,
    })
  }
  alerts.sort(
    (a, b) => (kindOrder.get(a.kind) ?? 99) - (kindOrder.get(b.kind) ?? 99),
  )
  return alerts
}

export function deriveAlerts(
  state: FarmAlertsInput,
  now: Clock,
): FarmAlertsSummary {
  const counts = emptyCounts()
  if (!state || (state.kind !== undefined && state.kind !== 'ready')) {
    return {
      alerts: [],
      total: 0,
      counts,
      byAssignment: {},
      announcement: 'Nenhum alerta ativo no momento.',
    }
  }

  const connectorStorage = state.connectorStorage
  const panelAlerts: FarmAlert[] = []
  const byAssignment: Record<string, FarmAlert[]> = {}

  for (const row of state.rows) {
    const printerAlerts = derivePrinterAlerts(row, now)
    panelAlerts.push(...printerAlerts)
    const rowChips = deriveRowAlerts(row, now, connectorStorage)
    if (rowChips.length > 0)
      byAssignment[row.assignment.assignmentId] = rowChips
  }

  if (connectorStorage) {
    const degradedAgents = Object.entries(connectorStorage)
      .filter(([, status]) => status === 'degraded')
      .map(([agentId]) => agentId)

    for (const agentId of degradedAgents) {
      const matchingRows = state.rows.filter(
        (row) => row.assignment.agentId === agentId,
      )
      const first = matchingRows[0]
      const printerNames = matchingRows
        .map((row) => row.assignment.printerKey)
        .join(', ')
      panelAlerts.push({
        id: `connector:${agentId}:storage-degraded`,
        kind: 'connector-storage-degraded',
        tone: 'error',
        icon: '!',
        label: 'Armazenamento do Connector degradado',
        message: first
          ? `Armazenamento do Connector degradado; comandos bloqueados (${printerNames}).`
          : 'Armazenamento do Connector degradado; novos registros não são gravados e comandos são recusados.',
        targetLabel: first ? first.assignment.printerKey : 'Connectors',
        href: first
          ? `#printer-${first.assignment.assignmentId}`
          : '/connectors',
        agentId,
        ...(first ? { assignmentId: first.assignment.assignmentId } : {}),
      })
    }
  }

  panelAlerts.sort(
    (a, b) => (kindOrder.get(a.kind) ?? 99) - (kindOrder.get(b.kind) ?? 99),
  )

  for (const alert of panelAlerts) counts[alert.kind]++

  const parts = FARM_ALERT_ORDER.filter((kind) => counts[kind] > 0).map(
    (kind) => `${counts[kind]} ${FARM_ALERT_META[kind].countLabel}`,
  )
  const total = panelAlerts.length
  const announcement =
    total === 0
      ? 'Nenhum alerta ativo no momento.'
      : `${total} ${total === 1 ? 'alerta ativo' : 'alertas ativos'}: ${parts.join(', ')}.`

  return {
    alerts: panelAlerts,
    total,
    counts,
    byAssignment,
    announcement,
  }
}
