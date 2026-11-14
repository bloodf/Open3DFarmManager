import { createInterface } from 'node:readline'
import { startBambuSimulator } from './bambu-simulator.ts'

const peer = await startBambuSimulator()
console.log(`SIMULADOR SINTÉTICO — TLS ${peer.host}:${peer.port}\nTópico: ${peer.reportTopic}\nConfiança sintética pública:\n${peer.syntheticTrust}\nDigite JSON ou texto malformado para publicar; /disconnect desconecta; /quit encerra.`)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
async function stop() { input.close(); await peer.close() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  for await (const line of input) {
    if (line === '/quit') break
    if (line === '/disconnect') await peer.disconnectClients()
    else {
      try { peer.publishReport(line) }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)) }
    }
  }
} finally {
  await stop()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
