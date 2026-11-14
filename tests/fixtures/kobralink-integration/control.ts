// SPDX-License-Identifier: MIT
import type { KobraLinkFetch } from '../../../packages/connector/src/kobralink/client.ts'

// Synthetic CoreController contract at upstream 5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1.
// No sockets, MQTT or physical actuators.
export function createControlFixture() {
  const token = 'synthetic-control-token'
  const commands: string[] = []
  const extended: { path: string; body: unknown }[] = []
  const state = {
    printState: 'printing',
    connected: true,
    updatedAt: Date.now(),
    status: 204,
    expired: false,
    malformed: false,
    deviceId: 'synthetic-device',
    id: 'printer-1',
  }
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fetch: KobraLinkFetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/auth/sign-in/email')
      return new Response('{}', {
        headers: {
          'set-cookie': `better-auth.session_token=${token}; HttpOnly; Path=/`,
        },
      })
    if (
      state.expired ||
      new Headers(init.headers).get('cookie') !==
        `better-auth.session_token=${token}`
    )
      return json({ error: token }, 401)
    if (path === '/api/v1/printers/printer-1' && init.method === 'GET')
      return json({
        id: state.id,
        deviceId: state.deviceId,
        name: 'Synthetic Kobra X',
        live: {
          connected: state.connected,
          updatedAt: state.updatedAt,
          printState: state.printState,
        },
      })
    if (
      init.method === 'POST' &&
      /^\/api\/v1\/printers\/printer-1\/(temperature|fan|light|speed|axis|axis\/off|ams\/(slot|feed)|ace\/(auto-feed|dry)|printer-files\/print)$/.test(
        path,
      )
    ) {
      extended.push({ path, body: JSON.parse(String(init.body)) })
      return state.status === 204
        ? state.malformed
          ? json({ result: 'ok' })
          : new Response(null, { status: 204 })
        : json({ error: token }, state.status)
    }
    const match =
      /^\/api\/v1\/printers\/printer-1\/print\/(pause|resume|cancel)$/.exec(
        path,
      )
    if (match?.[1] && init.method === 'POST') {
      commands.push(match[1])
      return state.status === 204
        ? state.malformed
          ? json({ result: 'ok' })
          : new Response(null, { status: 204 })
        : json({ error: token }, state.status)
    }
    return json({}, 404)
  }
  return { fetch, state, commands, extended, token }
}
