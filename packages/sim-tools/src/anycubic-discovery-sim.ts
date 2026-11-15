// Simulator responses are made up from docs/protocols/anycubic-discovery.md.
import http from 'node:http'

export function createAnycubicDiscoverySimulator() {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/info') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        ctrlType: 'lan',
        token: 'simulator-token',
        ctrlInfoUrl: '/ctrl',
        modelId: 'K3',
        cn: 'simulator',
        modelName: 'Anycubic Kobra 3',
        deviceType: 'fdm',
      }),
    )
  })
}
