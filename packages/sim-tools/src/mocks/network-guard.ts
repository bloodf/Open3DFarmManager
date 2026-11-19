// SPDX-License-Identifier: MIT
import net from 'node:net'
import dgram from 'node:dgram'

export interface NetworkGuardStats {
  listenAttempts: number
  rejectedAttempts: number
  multicastSendAttempts: number
  multicastRejected: number
}

const stats: NetworkGuardStats = {
  listenAttempts: 0,
  rejectedAttempts: 0,
  multicastSendAttempts: 0,
  multicastRejected: 0,
}

let isInstalled = false
const originalListen = net.Server.prototype.listen
const originalDgramBind = dgram.Socket.prototype.bind
const originalDgramSend = dgram.Socket.prototype.send
const originalAddMembership = dgram.Socket.prototype.addMembership

function isLoopback(host?: string | null): boolean {
  if (!host) return false
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/** IPv4 multicast (224.0.0.0/4), including mDNS and SSDP groups. */
export function isMulticastAddress(address?: string | null): boolean {
  if (!address) return false
  const trimmed = address.trim()
  if (trimmed === '224.0.0.251' || trimmed === '239.255.255.250') return true
  const match = /^(\d{1,3})\./.exec(trimmed)
  if (!match) return false
  const first = Number(match[1])
  return first >= 224 && first <= 239
}

function sendDestination(args: unknown[]): string | undefined {
  // dgram.send(msg, port, address, cb) | send(msg, offset, length, port, address, cb)
  // | send(msg, port, address) | send(msg, { port, address }, cb)
  for (let i = 1; i < args.length; i++) {
    const value = args[i]
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'address' in value) {
      const address = (value as { address?: unknown }).address
      if (typeof address === 'string') return address
    }
  }
  return undefined
}

export function installNetworkGuard(): void {
  if (isInstalled) return
  isInstalled = true

  // Intercept net.Server.prototype.listen
  net.Server.prototype.listen = function (this: net.Server, ...args: any[]) {
    stats.listenAttempts++
    let host: string | undefined

    if (args.length > 0) {
      if (typeof args[0] === 'object' && args[0] !== null) {
        host = args[0].host
      } else if (typeof args[1] === 'string') {
        host = args[1]
      }
    }

    if (!isLoopback(host)) {
      stats.rejectedAttempts++
      const err = new Error(
        `Network guard violation: non-loopback socket rejected (host: ${host ?? 'default/any'})`,
      )
      this.emit('error', err)
      throw err
    }

    return originalListen.apply(this, args as any)
  }

  // Intercept dgram.Socket.prototype.bind
  dgram.Socket.prototype.bind = function (this: dgram.Socket, ...args: any[]) {
    stats.listenAttempts++
    let address: string | undefined

    if (args.length > 0) {
      if (typeof args[0] === 'object' && args[0] !== null) {
        address = args[0].address
      } else if (typeof args[1] === 'string') {
        address = args[1]
      }
    }

    if (!isLoopback(address)) {
      stats.rejectedAttempts++
      const err = new Error(
        `Network guard violation: non-loopback UDP socket rejected (address: ${address ?? 'default/any'})`,
      )
      this.emit('error', err)
      throw err
    }

    return originalDgramBind.apply(this, args as any)
  }

  dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: any[]) {
    const destination = sendDestination(args)
    if (isMulticastAddress(destination)) {
      stats.multicastSendAttempts++
      stats.multicastRejected++
      const err = new Error(
        `Network guard violation: multicast UDP send rejected (address: ${destination})`,
      )
      const maybeCb = args[args.length - 1]
      if (typeof maybeCb === 'function') {
        queueMicrotask(() => maybeCb(err))
        return 0
      }
      throw err
    }
    return originalDgramSend.apply(this, args as any)
  }

  dgram.Socket.prototype.addMembership = function (
    this: dgram.Socket,
    multicastAddress: string,
    multicastInterface?: string,
  ) {
    stats.multicastSendAttempts++
    stats.multicastRejected++
    throw new Error(
      `Network guard violation: multicast membership rejected (address: ${multicastAddress}${multicastInterface ? `, iface: ${multicastInterface}` : ''})`,
    )
  }
}

export function uninstallNetworkGuard(): void {
  if (!isInstalled) return
  isInstalled = false
  net.Server.prototype.listen = originalListen
  dgram.Socket.prototype.bind = originalDgramBind
  dgram.Socket.prototype.send = originalDgramSend
  dgram.Socket.prototype.addMembership = originalAddMembership
}

export function getNetworkGuardStats(): Readonly<NetworkGuardStats> {
  return { ...stats }
}

export function resetNetworkGuardStats(): void {
  stats.listenAttempts = 0
  stats.rejectedAttempts = 0
  stats.multicastSendAttempts = 0
  stats.multicastRejected = 0
}

export async function withNetworkGuard<T>(
  action: () => Promise<T> | T,
): Promise<T> {
  const wasInstalled = isInstalled
  if (!wasInstalled) installNetworkGuard()
  try {
    return await action()
  } finally {
    if (!wasInstalled) uninstallNetworkGuard()
  }
}

export function assertLoopbackAddress(
  addr: net.AddressInfo | string | null,
): void {
  if (!addr) {
    throw new Error('Address is missing or null')
  }
  if (typeof addr === 'string') {
    if (!addr.includes('127.0.0.1')) {
      throw new Error(`Non-loopback address string: ${addr}`)
    }
    return
  }
  if (addr.address !== '127.0.0.1') {
    throw new Error(`Non-loopback socket address: ${addr.address}`)
  }
}
