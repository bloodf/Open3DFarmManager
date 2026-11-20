// SPDX-License-Identifier: MIT
import { connect as tlsConnect } from 'node:tls'
import { MqttClient } from 'mqtt'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { decodeBambuReport } from './report.ts'

type BambuMaterials = NonNullable<PrinterState['materials']>

export type BambuCloudAmsOptions = {
  host: string
  port: number
  serial: string
  username: string
  accessToken: string
  ca: Buffer
  timeoutMs?: number
}

/** Reads one current AMS report. A null result means cloud telemetry was unavailable. */
export function readBambuCloudAms(
  options: BambuCloudAmsOptions,
): Promise<BambuMaterials | null> {
  const timeoutMs = options.timeoutMs ?? 5000
  if (
    !options.host ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.serial) ||
    !options.username ||
    !options.accessToken ||
    options.ca.length === 0 ||
    timeoutMs < 100 ||
    timeoutMs > 15000
  )
    return Promise.resolve(null)

  return new Promise((resolve) => {
    const reportTopic = `device/${options.serial}/report`
    const requestTopic = `device/${options.serial}/request`
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    let client: MqttClient
    const finish = (materials: BambuMaterials | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.end(true)
      } catch {
        /* connection may not have opened */
      }
      resolve(materials)
    }
    try {
      client = new MqttClient(
        () =>
          tlsConnect({
            host: options.host,
            port: options.port,
            ca: options.ca,
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
          }),
        {
          manualConnect: true,
          protocolVersion: 4,
          username: options.username,
          password: options.accessToken,
          connectTimeout: timeoutMs,
          reconnectPeriod: 0,
          clean: true,
          resubscribe: false,
          queueQoSZero: false,
        },
      )
      timer = setTimeout(() => finish(null), timeoutMs)
      client.on('error', () => finish(null))
      client.on('message', (_topic, payload) => {
        const decoded = decodeBambuReport(payload.toString('utf8'))
        if (decoded.kind === 'observation' && decoded.materials)
          finish(decoded.materials)
      })
      client.on('connect', () => {
        client.subscribe(reportTopic, { qos: 0 }, (error) => {
          if (error) return finish(null)
          client.publish(
            requestTopic,
            JSON.stringify({
              pushing: { command: 'pushall', version: 1, push_target: 1 },
            }),
            { qos: 0, retain: false },
            (publishError) => {
              if (publishError) finish(null)
            },
          )
        })
      })
      client.connect()
    } catch {
      resolve(null)
    }
  })
}
