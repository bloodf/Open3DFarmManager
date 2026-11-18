// SPDX-License-Identifier: MIT
import net from 'node:net'
import dgram from 'node:dgram'

export interface NetworkGuardStats {
  listenAttempts: number
  rejectedAttempts: number
}

const stats: NetworkGuardStats = {
  listenAttempts: 0,
  rejectedAttempts: 0,
}

let isInstalled = false
const originalListen = net.Server.prototype.listen
const originalDgramBind = dgram.Socket.prototype.bind

function isLoopback(host?: string | null): boolean {
  if (!host) return false
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
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
}

export function uninstallNetworkGuard(): void {
  if (!isInstalled) return
  isInstalled = false
  net.Server.prototype.listen = originalListen
  dgram.Socket.prototype.bind = originalDgramBind
}

export function getNetworkGuardStats(): Readonly<NetworkGuardStats> {
  return { ...stats }
}

export function resetNetworkGuardStats(): void {
  stats.listenAttempts = 0
  stats.rejectedAttempts = 0
}

export async function withNetworkGuard<T>(action: () => Promise<T> | T): Promise<T> {
  const wasInstalled = isInstalled
  if (!wasInstalled) installNetworkGuard()
  try {
    return await action()
  } finally {
    if (!wasInstalled) uninstallNetworkGuard()
  }
}

export function assertLoopbackAddress(addr: net.AddressInfo | string | null): void {
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
