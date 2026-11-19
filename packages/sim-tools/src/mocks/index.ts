// SPDX-License-Identifier: MIT
export * from './env.ts'
export * from './tls.ts'
export * from './faults.ts'
export * from './scenario.ts'
export * from './network-guard.ts'
export * from './mqtt-broker.ts'
export * from './http-mock.ts'
export * from './bambu-mock.ts'
export * from './kobra-x-mock.ts'
export * from './moonraker-mock.ts'
export * from './spoolman-mock.ts'
export * from './oidc-mock.ts'

import {
  startHttpMock,
  type HttpMockOptions,
  type HttpMockInstance,
} from './http-mock.ts'
import {
  startMqttBroker,
  type MqttBrokerOptions,
  type MqttMockInstance,
} from './mqtt-broker.ts'
import {
  startBambuMock,
  type BambuMockOptions,
  type BambuMockInstance,
} from './bambu-mock.ts'
import {
  startKobraXMock,
  type KobraXMockOptions,
  type KobraXMockInstance,
} from './kobra-x-mock.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
  type MoonrakerMockInstance,
} from './moonraker-mock.ts'
import {
  startSpoolmanMock,
  type SpoolmanMockOptions,
  type SpoolmanMockInstance,
} from './spoolman-mock.ts'
import {
  startOidcMock,
  type OidcMockOptions,
  type OidcMockInstance,
} from './oidc-mock.ts'

export type MockKind =
  | 'http'
  | 'mqtt'
  | 'bambu'
  | 'kobra-x'
  | 'anycubic'
  | 'moonraker'
  | 'spoolman'
  | 'oidc'

export type MockOptionsMap = {
  http: HttpMockOptions
  mqtt: MqttBrokerOptions
  bambu: BambuMockOptions
  'kobra-x': KobraXMockOptions
  anycubic: KobraXMockOptions
  moonraker: MoonrakerMockOptions
  spoolman: SpoolmanMockOptions
  oidc: OidcMockOptions
}

export type MockInstanceMap = {
  http: HttpMockInstance
  mqtt: MqttMockInstance
  bambu: BambuMockInstance
  'kobra-x': KobraXMockInstance
  anycubic: KobraXMockInstance
  moonraker: MoonrakerMockInstance
  spoolman: SpoolmanMockInstance
  oidc: OidcMockInstance
}

export type AnyMockInstance =
  | HttpMockInstance
  | MqttMockInstance
  | BambuMockInstance
  | KobraXMockInstance
  | MoonrakerMockInstance
  | SpoolmanMockInstance
  | OidcMockInstance

/**
 * Unified entry point to start an in-process mock.
 * Listens on 127.0.0.1 with port 0.
 * Releases all sockets and timers on close().
 */
export async function startMock<K extends MockKind>(
  kind: K,
  options?: MockOptionsMap[K],
): Promise<MockInstanceMap[K]> {
  switch (kind) {
    case 'http':
      return (await startHttpMock(
        options as HttpMockOptions,
      )) as MockInstanceMap[K]
    case 'mqtt':
      return (await startMqttBroker(
        options as MqttBrokerOptions,
      )) as MockInstanceMap[K]
    case 'bambu':
      return (await startBambuMock(
        options as BambuMockOptions,
      )) as MockInstanceMap[K]
    case 'kobra-x':
    case 'anycubic':
      return (await startKobraXMock(
        options as KobraXMockOptions,
      )) as MockInstanceMap[K]
    case 'moonraker':
      return (await startMoonrakerMock(
        options as MoonrakerMockOptions,
      )) as MockInstanceMap[K]
    case 'spoolman':
      return (await startSpoolmanMock(
        options as SpoolmanMockOptions,
      )) as MockInstanceMap[K]
    case 'oidc':
      return (await startOidcMock(
        options as OidcMockOptions,
      )) as MockInstanceMap[K]
    default: {
      const _exhaustive: never = kind
      throw new Error(`Unsupported mock kind: ${String(_exhaustive)}`)
    }
  }
}
