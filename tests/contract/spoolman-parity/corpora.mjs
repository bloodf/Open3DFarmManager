// Request corpora replayed against both servers. Each corpus runs on a fresh
// Spoolman container and a fresh farm, so ids and sequence state start equal.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const root = new URL('../../fixtures/spoolman/', import.meta.url)

async function load(path) {
  const text = await readFile(new URL(path, root), 'utf8')
  return {
    path: `tests/fixtures/spoolman/${path}`,
    sha256: createHash('sha256').update(text).digest('hex'),
    value: JSON.parse(text),
  }
}

/** Cases recorded from the pinned image: compared with the live answers too. */
function withRecorded(cases, recorded) {
  const byName = new Map(recorded.cases.map((item) => [item.name, item]))
  return cases.map((item) => {
    const answer = byName.get(item.name)
    if (!answer) throw new Error(`no recorded answer for ${item.name}`)
    return { ...item, recorded: answer }
  })
}

export async function loadCorpora() {
  const [
    spoolCases,
    spoolRecorded,
    vfCases,
    vfRecorded,
    clients,
    flows,
    aux,
    ws,
  ] = await Promise.all([
    load('spool-api/cases.json'),
    load('spool-api/upstream.json'),
    load('vendor-filament/cases.json'),
    load('vendor-filament/upstream.json'),
    load('upstream-contract/requests.json'),
    load('parity/client-flows.json'),
    load('parity/aux-cases.json'),
    load('parity/websocket-scenarios.json'),
  ])
  return [
    {
      name: 'spool-api',
      kind: 'http',
      files: [spoolCases, spoolRecorded],
      requests: withRecorded(spoolCases.value, spoolRecorded.value),
    },
    {
      name: 'vendor-filament',
      kind: 'http',
      files: [vfCases, vfRecorded],
      requests: withRecorded(vfCases.value, vfRecorded.value),
    },
    {
      name: 'client-contracts',
      kind: 'http',
      files: [clients, flows],
      // Recorded client requests carry their captured answer; the flows add the
      // Klipper-macro/Moonraker sequences, which have no recorded answer.
      requests: [
        ...clients.value.map((item) => ({
          ...item,
          recorded: { status: item.status, response: item.response },
        })),
        ...flows.value,
      ],
    },
    {
      name: 'auxiliary-api',
      kind: 'http',
      external: true,
      files: [aux],
      requests: aux.value,
    },
    {
      name: 'websocket',
      kind: 'websocket',
      files: [ws],
      scenarios: ws.value,
    },
  ]
}
