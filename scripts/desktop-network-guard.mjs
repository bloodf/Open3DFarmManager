// SPDX-License-Identifier: MIT
// Loopback-only network guard for `npm run desktop:check`.
//
// Loaded with `node --import` through NODE_OPTIONS, so every Node process the
// check starts (npm, vitest and its workers, Nuxt, Playwright, Connector, test
// helpers) runs with it. It rejects every outbound attempt whose destination is
// not loopback or a Unix socket: net, tls, dgram, http(s), global fetch and
// WebSocket, and DNS lookups. Each attempt is rejected at the call site and
// appended, one JSON line, to the file named by OPENFARM_NETWORK_GUARD_LOG so the
// runner can fail the step (and the run) even when a child swallowed the error.
//
// It is a guard for Node code. Other programs (Chrome, Go, curl) are covered by
// their own offline settings and, on Linux, by an unshared network namespace.
import dns from 'node:dns'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

export const GUARD_ERROR_CODE = 'ERR_OPENFARM_NETWORK_GUARD'
export const GUARD_LOG_ENV = 'OPENFARM_NETWORK_GUARD_LOG'
const INSTALLED = Symbol.for('openfarm.desktop-network-guard')

const loopback = new net.BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('0.0.0.0', 'ipv4')
loopback.addAddress('::1', 'ipv6')
loopback.addAddress('::', 'ipv6')
loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

/** Addresses of this host's own interfaces: traffic to them never leaves the machine. */
let ownAddresses = { at: 0, values: new Set() }
function isOwnAddress(value) {
  const now = Date.now()
  // Interfaces rarely change; scanning them on every call would be slow.
  if (now - ownAddresses.at > 2000) {
    const values = new Set()
    for (const addresses of Object.values(os.networkInterfaces()))
      for (const address of addresses ?? [])
        values.add(address.address.toLowerCase())
    ownAddresses = { at: now, values }
  }
  return ownAddresses.values.has(value)
}

/** True for the destinations a desktop run may contact. Pure; used by tests. */
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true
  let value = String(host).trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (value.endsWith('.')) value = value.slice(0, -1)
  if (value === 'localhost') return true
  const family = net.isIP(value)
  if (family === 4) return loopback.check(value, 'ipv4') || isOwnAddress(value)
  if (family === 6) return loopback.check(value, 'ipv6') || isOwnAddress(value)
  return false
}

function describeTarget(host, port) {
  const name = host === undefined || host === null || host === '' ? '' : host
  return port === undefined || port === null || port === ''
    ? String(name)
    : `${name}:${port}`
}

function guardError(api, target) {
  const error = new Error(
    `OpenFarm desktop network guard blocked outbound ${api} to ${target}`,
  )
  error.code = GUARD_ERROR_CODE
  return error
}

function record(api, target) {
  const error = guardError(api, target)
  const entry = {
    at: new Date().toISOString(),
    pid: process.pid,
    process: process.argv.slice(1, 3).join(' '),
    api,
    target,
    stack: (error.stack ?? '').split('\n').slice(2, 6).join('\n'),
  }
  const line = `${JSON.stringify(entry)}\n`
  const path = process.env[GUARD_LOG_ENV]
  try {
    if (path) fs.appendFileSync(path, line, { mode: 0o600 })
  } catch {
    // The stderr line below still reports the attempt.
  }
  try {
    process.stderr.write(
      `[desktop-network-guard] blocked ${api} -> ${target}\n`,
    )
  } catch {
    // stderr closed.
  }
  return error
}

function hostFromUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(String(input))
    return { host: url.hostname, port: url.port, scheme: url.protocol }
  } catch {
    return { host: String(input), port: '', scheme: '' }
  }
}

function connectOptions(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first !== null && typeof first === 'object') return first
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first }
  const options = { port: first }
  if (typeof args[1] === 'string') options.host = args[1]
  return options
}

function checkSocketTarget(api, options) {
  if (typeof options.path === 'string' && options.path !== '') return undefined
  const host = options.host ?? options.hostname
  if (isLoopbackHost(host)) return undefined
  return record(api, describeTarget(host, options.port))
}

function patchNet() {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const error = checkSocketTarget('net.connect', connectOptions(args))
    if (!error) return connect.apply(this, args)
    process.nextTick(() => this.destroy(error))
    return this
  }
  // net.connect, net.createConnection and tls.connect all end in this method,
  // so each attempt is recorded once and surfaces as an async socket error.
}

function dgramAddress(api, args) {
  // send(msg[, offset, length][, port][, address][, callback]); connect(port[, address][, cb]).
  // The address is the last string after the message; the port the last number.
  if (api === 'dgram.connect') return { port: args[0], host: args[1] }
  const rest = args.slice(1).filter((value) => typeof value !== 'function')
  return {
    port: rest.filter((value) => typeof value === 'number').at(-1),
    host: rest.filter((value) => typeof value === 'string').at(-1),
  }
}

function patchDgram() {
  const proto = dgram.Socket.prototype
  for (const [name, api] of [
    ['send', 'dgram.send'],
    ['connect', 'dgram.connect'],
  ]) {
    const original = proto[name]
    proto[name] = function guardedDgram(...args) {
      const { host, port } = dgramAddress(api, args)
      // A connected socket sends without an address; the connect call is guarded.
      if (host === undefined && name === 'send')
        return original.apply(this, args)
      if (isLoopbackHost(host)) return original.apply(this, args)
      const error = record(api, describeTarget(host, port))
      const callback = args.find((value) => typeof value === 'function')
      if (callback) process.nextTick(callback, error)
      else process.nextTick(() => this.emit('error', error))
      return undefined
    }
  }
}

function patchDns() {
  const guardHost = (host, name) =>
    isLoopbackHost(host) || (name === 'lookup' && net.isIP(String(host)) !== 0)
      ? undefined
      : host
  for (const name of [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCname',
    'resolveCaa',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ]) {
    const original = dns[name]
    if (typeof original !== 'function') continue
    const wrapped = function guardedDns(host, ...args) {
      const blocked = name === 'reverse' ? host : guardHost(host, name)
      if (blocked === undefined) return original.call(this, host, ...args)
      const error = record(`dns.${name}`, String(blocked))
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        process.nextTick(callback, error)
        return undefined
      }
      throw error
    }
    Object.defineProperty(wrapped, 'name', { value: original.name })
    dns[name] = wrapped
    const promised = dns.promises[name]
    if (typeof promised === 'function') {
      dns.promises[name] = async function guardedPromisesDns(host, ...args) {
        const blocked = name === 'reverse' ? host : guardHost(host, name)
        if (blocked === undefined) return promised.call(this, host, ...args)
        throw record(`dns.promises.${name}`, String(blocked))
      }
    }
  }
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
      if (!/^(resolve|reverse)/.test(name)) continue
      const original = Resolver.prototype[name]
      Resolver.prototype[name] = function guardedResolver(host, ...args) {
        if (name !== 'reverse' && isLoopbackHost(host))
          return original.call(this, host, ...args)
        const error = record(`dns.Resolver.${name}`, String(host))
        const callback = args.at(-1)
        if (typeof callback === 'function') {
          process.nextTick(callback, error)
          return undefined
        }
        return Promise.reject(error)
      }
    }
  }
}

function httpTarget(args) {
  const [first, second] = args
  let host
  let port
  let socketPath
  if (typeof first === 'string' || first instanceof URL) {
    const parsed = hostFromUrl(first)
    host = parsed.host
    port = parsed.port
  } else if (first && typeof first === 'object') {
    host = first.hostname ?? first.host
    port = first.port
    socketPath = first.socketPath
  }
  if (second && typeof second === 'object' && typeof second !== 'function') {
    host = second.hostname ?? second.host ?? host
    port = second.port ?? port
    socketPath = second.socketPath ?? socketPath
  }
  return { host, port, socketPath }
}

function patchHttp() {
  for (const [module, label] of [
    [http, 'http'],
    [https, 'https'],
  ]) {
    for (const name of ['request', 'get']) {
      const original = module[name]
      module[name] = function guardedHttp(...args) {
        const { host, port, socketPath } = httpTarget(args)
        if (!socketPath && !isLoopbackHost(host))
          throw record(`${label}.${name}`, describeTarget(host, port))
        return original.apply(this, args)
      }
    }
  }
}

function patchFetch() {
  const original = globalThis.fetch
  if (typeof original === 'function')
    globalThis.fetch = function guardedFetch(input, init) {
      const raw =
        input && typeof input === 'object' && 'url' in input ? input.url : input
      const { host, port } = hostFromUrl(raw)
      if (isLoopbackHost(host)) return original.call(this, input, init)
      return Promise.reject(record('fetch', describeTarget(host, port)))
    }
  const NativeWebSocket = globalThis.WebSocket
  if (typeof NativeWebSocket === 'function') {
    class GuardedWebSocket extends NativeWebSocket {
      constructor(url, ...rest) {
        const { host, port } = hostFromUrl(url)
        if (!isLoopbackHost(host))
          throw record('WebSocket', describeTarget(host, port))
        super(url, ...rest)
      }
    }
    globalThis.WebSocket = GuardedWebSocket
  }
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true
  patchNet()
  patchDgram()
  patchDns()
  patchHttp()
  patchFetch()
  syncBuiltinESMExports()
}
