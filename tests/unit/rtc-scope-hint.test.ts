import { describe, expect, it } from 'vitest'
import {
  isLoopbackBindAddress,
  DEFAULT_RTC_BIND_ADDRESS,
} from '../../packages/connector/src/config/rtc.ts'
import { connectorRtcScopeHint } from '../../apps/farm/app/utils/connector-version.ts'

describe('RTC scope hint', () => {
  it('distinguishes the default and LAN addresses', () => {
    expect(isLoopbackBindAddress(DEFAULT_RTC_BIND_ADDRESS)).toBe(true)
    expect(isLoopbackBindAddress('::1')).toBe(true)
    expect(isLoopbackBindAddress('192.168.1.2')).toBe(false)
  })
  it('explains scope and leaves older connectors silent', () => {
    expect(connectorRtcScopeHint('loopback')).toContain('rtc.bindAddress')
    expect(connectorRtcScopeHint('lan')).toContain('rede local')
    expect(connectorRtcScopeHint()).toBe('')
  })
})
