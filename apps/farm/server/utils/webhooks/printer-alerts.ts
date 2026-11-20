import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import {
  deriveRowAlerts,
  type FarmAlert,
  type FarmAlertKind,
} from '../../../app/utils/farm-alerts.ts'
import type { FarmRow } from '../../../app/utils/farm-view.ts'
import { webhookHeaders } from '../../services/webhook-delivery.ts'
import type { IntegrationPrinterRow } from '../integration-auth.ts'

export const PRINTER_ALERT_RAISED = 'printer.alert.raised' as const

export interface ApiPrinterAlert {
  id: string
  kind: FarmAlertKind
  label: string
  message: string
}

export interface PrinterAlertRaisedData {
  farmId: string
  printerId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  alert: ApiPrinterAlert
}

export interface PrinterAlertRaisedEvent {
  id: string
  type: typeof PRINTER_ALERT_RAISED
  occurredAt: number
  data: PrinterAlertRaisedData
}

function toApiAlert(alert: FarmAlert): ApiPrinterAlert {
  return {
    id: alert.id,
    kind: alert.kind,
    label: alert.label,
    message: alert.message,
  }
}

/** Projects a stored integration printer row onto the E20.6 farm-row shape. */
export function farmRowFromPrinter(
  row: IntegrationPrinterRow,
  nowWall: number,
): FarmRow {
  const agentId = row.agentId ?? row.id
  const assignment = {
    assignmentId: row.id,
    agentId,
    printerKey: row.printerKey,
    displayName: row.displayName ?? null,
    groupName: row.groupName ?? null,
    location: row.location ?? null,
    status: 'active' as const,
    connectorStatus: 'approved' as const,
  }
  const parsed = PrinterState.safeParse(row.state)
  if (!parsed.success) {
    return {
      assignment,
      connection: 'closed',
      observation: null,
      localOrigin: null,
    }
  }
  const observedAt = row.observedAt ?? parsed.data.observedAt
  return {
    assignment,
    connection: parsed.data.state === 'offline' ? 'closed' : 'authenticated',
    observation: {
      state: parsed.data,
      received: { wall: observedAt, mono: nowWall },
      sourceClockComparable: true,
      historical: false,
    },
    localOrigin: null,
  }
}

export function alertsForPrinter(
  row: IntegrationPrinterRow,
  nowWall = Date.now(),
): ApiPrinterAlert[] {
  return deriveRowAlerts(farmRowFromPrinter(row, nowWall), {
    wall: nowWall,
    mono: nowWall,
  }).map(toApiAlert)
}

/** Alerts present in `current` that were absent from `previous` (by id). */
export function newlyRaisedAlerts(
  previous: IntegrationPrinterRow | null,
  current: IntegrationPrinterRow,
  nowWall = Date.now(),
): ApiPrinterAlert[] {
  const before = new Set(
    previous
      ? alertsForPrinter(previous, nowWall).map((alert) => alert.id)
      : [],
  )
  return alertsForPrinter(current, nowWall).filter(
    (alert) => !before.has(alert.id),
  )
}

export function buildPrinterAlertRaisedEvent(
  row: IntegrationPrinterRow,
  alert: ApiPrinterAlert,
  occurredAt = Date.now(),
  eventId = randomUUID(),
): PrinterAlertRaisedEvent {
  return {
    id: eventId,
    type: PRINTER_ALERT_RAISED,
    occurredAt,
    data: {
      farmId: row.farmId,
      printerId: row.id,
      printerKey: row.printerKey,
      ...(row.displayName !== undefined
        ? { displayName: row.displayName }
        : {}),
      ...(row.groupName !== undefined ? { groupName: row.groupName } : {}),
      ...(row.location !== undefined ? { location: row.location } : {}),
      alert,
    },
  }
}

export function signPrinterAlertWebhook(
  event: PrinterAlertRaisedEvent,
  secret: string,
  now = Date.now(),
) {
  const body = JSON.stringify(event)
  return { body, headers: webhookHeaders(event.id, secret, body, now) }
}

/** True when the signature header matches `v1=` HMAC-SHA256 of `timestamp.body`. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  timestamp: string,
  signatureHeader: string,
) {
  const expected =
    'v1=' +
    createHmac('sha256', secret)
      .update(timestamp + '.' + body)
      .digest('hex')
  const left = Buffer.from(expected)
  const right = Buffer.from(signatureHeader)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function printerAlertEventsForTransition(
  previous: IntegrationPrinterRow | null,
  current: IntegrationPrinterRow,
  nowWall = Date.now(),
): PrinterAlertRaisedEvent[] {
  return newlyRaisedAlerts(previous, current, nowWall).map((alert) =>
    buildPrinterAlertRaisedEvent(current, alert, nowWall),
  )
}
