// Drift gate (#912): COMMAND-SECURITY.md and DRIVER-EVIDENCE.md against the
// Connector's role, state and rate-limit rules and the journey specs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ControlArguments,
  ExtendedControlAction,
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import {
  claimCommand,
  closeCommandJournal,
  finishCommand,
  markWriteStarted,
  openCommandJournal,
  type CommandJournalHandle,
} from '../../packages/connector/src/control/command-journal.ts'

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const security = read('docs/COMMAND-SECURITY.md')
const evidence = read('docs/fullfarmmanager/DRIVER-EVIDENCE.md')

/** Rows of the first Markdown table whose header starts with `columns`. */
function table(document: string, ...columns: string[]): string[][] {
  const lines = document.split('\n')
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(' | ')
      .map((cell) => cell.trim())
  const header = lines.findIndex(
    (line) =>
      line.startsWith('|') &&
      columns.every((column, i) => cells(line)[i] === column),
  )
  assert.ok(header >= 0, `table ${columns.join(', ')} not found`)
  const rows: string[][] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    rows.push(cells(line))
  }
  assert.ok(rows.length, `table ${columns.join(', ')} is empty`)
  return rows
}

const actions: readonly ExtendedControlAction[] = ExtendedControlAction.options
const named = (cell: string) =>
  [...cell.matchAll(/`([a-z_]+)`/g)]
    .map((match) => match[1] as ExtendedControlAction)
    .filter((name) => actions.includes(name))

const ROLES = ['owner', 'admin', 'operator']
const ROLE_PHRASES: Record<string, string[]> = {
  'Operator or higher': ROLES,
  'Owner or admin': ['owner', 'admin'],
  'Owner only': ['owner'],
}
const STATES = [
  'idle',
  'printing',
  'paused',
  'cancelled',
  'error',
  'unknown',
] as const
const STATE_PHRASES: Record<string, string[]> = {
  'Any state': [...STATES],
  'Printing only': ['printing'],
  'Paused only': ['paused'],
  'Printing or paused': ['printing', 'paused'],
  'Idle only': ['idle'],
  'Idle or cancelled': ['idle', 'cancelled'],
  'Idle or error': ['idle', 'error'],
  'Idle, cancelled or error': ['idle', 'cancelled', 'error'],
  'Not `unknown` or `error`': ['idle', 'printing', 'paused', 'cancelled'],
}
/** The phrase before the first `;`; anything after it is a stricter note. */
const phrase = (cell: string) => cell.split(';')[0]!.trim()

const policy = table(
  security,
  'Action',
  'Required role',
  'Allowed printer state',
)
const actionRows = policy.flatMap((row) =>
  named(row[0]!).map((action) => ({ action, row })),
)

test('every control action has a policy row', () => {
  const documented = new Set(actionRows.map(({ action }) => action))
  assert.deepEqual(
    actions.filter((action) => !documented.has(action)),
    [],
  )
})

test('documented roles match controlRoleAllowed', () => {
  for (const { action, row } of actionRows) {
    const roles = ROLE_PHRASES[phrase(row[1]!)]
    assert.ok(roles, `${action}: unknown role phrase "${row[1]}"`)
    assert.deepEqual(
      ROLES.filter((role) => controlRoleAllowed(role, action)),
      roles,
      `${action} role`,
    )
  }
})

test('documented states match controlSourceState', () => {
  for (const { action, row } of actionRows) {
    const states = STATE_PHRASES[phrase(row[2]!)]
    assert.ok(states, `${action}: unknown state phrase "${row[2]}"`)
    assert.deepEqual(
      STATES.filter((state) => controlSourceState(action, state)),
      STATES.filter((state) => states.includes(state)),
      `${action} state`,
    )
  }
})

// --- Rate limits: the documented table against the real journal --------------

const SHA = 'a'.repeat(64)
const SAMPLE_ARGS: Record<ExtendedControlAction, Record<string, unknown>> = {
  pause: {},
  resume: {},
  cancel: {},
  emergency_stop: {},
  firmware_restart: {},
  unload_filament: {},
  motors_off: {},
  set_temperature: { heater: 'bed', target_c: 0 },
  set_tool_temperature: { tool: 0, target_c: 0 },
  set_fan: { fan: 'part', percent: 0 },
  home: { axes: ['x'] },
  set_light: { on: true },
  set_speed: { level: 'standard' },
  start_print: { file: 'a.gcode' },
  start_library_print: { sha256: SHA },
  service: { op: 'klipper_restart' },
  power: { device: 'printer', on: true },
  timelapse: { op: 'render' },
  run_macro: { name: 'PURGE' },
  config_write: { path: 'printer.cfg', base_sha256: SHA, sha256: SHA },
  load_filament: {},
  jog: { axis: 'x', distance_mm: 1, feed: 600 },
  z_babystep: { delta_mm: 0.01 },
  set_factor: { speed_pct: 100, flow_pct: 100 },
  extrude: { tool: 0, length_mm: 1, feed: 100 },
  file_op: { op: 'mkdir', path: 'a' },
  exclude_object: { name: 'part' },
  set_led: { name: 'led', r: 0, g: 0, b: 0 },
  set_pin: { name: 'pin', value: 0 },
  queue_op: { op: 'pause' },
  bed_mesh: { op: 'clear' },
  gcode: { line: 'M105' },
  confirm_collection: { attempt: '0' },
}

type Claim = (action: ExtendedControlAction) => string

function withJournal(run: (claim: Claim) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'docs-drift-journal-'))
  const journal: CommandJournalHandle = openCommandJournal({
    directory,
    clock: () => 1000,
  })
  const scope = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'text_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const claim: Claim = (action) => {
    const args = SAMPLE_ARGS[action]
    assert.ok(ControlArguments.safeParse({ action, args }).success, action)
    const result = claimCommand(journal, {
      command: {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        ...scope,
        action,
        args,
        issued_at: 1000,
        expires_at: 6000,
        nonce: randomBytes(16).toString('base64url'),
        sig: 'A'.repeat(86),
      },
      printerKey: 'printer',
      wireSha256: SHA,
    })
    if (!result.ok) return result.reason
    assert.ok(markWriteStarted(journal, result.receipt))
    assert.ok(finishCommand(journal, result.receipt, 'applied', 'applied'))
    return 'ok'
  }
  try {
    run(claim)
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
}

const rates = table(
  security,
  'Rate class',
  'Maximum per minute',
  'Uses the shared allowance',
  'Covers',
).map(([name, max, shared, covers]) => ({
  name: name!,
  max: Number(max),
  shared: shared === 'Yes',
  covers: named(covers!),
}))
const sharedClass = rates.find((rate) => rate.name === 'Shared')!
const listed = new Set(rates.flatMap((rate) => rate.covers))
const classOf = (action: ExtendedControlAction) =>
  rates.find((rate) => rate.covers.includes(action)) ?? sharedClass

test('every policy row names the rate class of its actions', () => {
  for (const { action, row } of actionRows)
    assert.equal(row[4], classOf(action).name, `${action} rate class`)
})

test('the Connector enforces each documented per-class maximum', () => {
  for (const action of actions)
    withJournal((claim) => {
      const { max } = classOf(action)
      for (let i = 0; i < max; i++)
        assert.equal(claim(action), 'ok', `${action} claim ${i + 1}`)
      assert.equal(
        claim(action),
        action === 'emergency_stop' ? 'ok' : 'rate-limited',
        `${action} claim ${max + 1}`,
      )
    })
})

test('the Connector shares the allowance exactly as documented', () => {
  const other = actions.find(
    (action) => !listed.has(action) && action !== 'emergency_stop',
  )!
  for (const rate of rates.filter((entry) => entry !== sharedClass))
    for (const action of rate.covers) {
      // A spent shared allowance blocks exactly the classes that use it.
      withJournal((claim) => {
        for (let i = 0; i < sharedClass.max; i++)
          assert.equal(claim(other), 'ok')
        assert.equal(
          claim(action),
          rate.shared ? 'rate-limited' : 'ok',
          `${action} after the shared allowance`,
        )
      })
      // A spent class cap leaves the rest of the shared allowance usable.
      withJournal((claim) => {
        for (let i = 0; i < rate.max; i++) assert.equal(claim(action), 'ok')
        const left = sharedClass.max - (rate.shared ? rate.max : 0)
        for (let i = 0; i < left; i++) assert.equal(claim(other), 'ok')
        assert.equal(claim(other), 'rate-limited', `after ${action}`)
      })
    }
})

// --- Driver evidence ----------------------------------------------------------

test('every journey path named in DRIVER-EVIDENCE.md exists', () => {
  const paths = new Set(
    [...evidence.matchAll(/(?:tests\/journey\/)?[\w-]+\.spec\.ts/g)].map(
      ([name]) => (name.includes('/') ? name : `tests/journey/${name}`),
    ),
  )
  for (const [path] of evidence.matchAll(/tests\/journey\/[\w./-]+\.ts/g))
    paths.add(path)
  assert.ok(paths.size)
  assert.deepEqual(
    [...paths].filter(
      (path) => !existsSync(new URL(`../../${path}`, import.meta.url)),
    ),
    [],
  )
})

test('journey operations are not overclaimed', () => {
  // These specs only watch status through a connection loss. phrozen.spec.ts
  // also drives a test-only qualified pair and has its own exact wording.
  const statusOnly = [
    'flashforge',
    'formlabs',
    'prusa-link',
    'qidi',
    'sdcp',
  ].map((name) => `${name}.spec.ts`)
  for (const row of table(evidence, 'Brand', 'Model')) {
    const [brand, model, adapter, , , spec, run, operations] = row
    const label = `${brand} ${model}`
    if (adapter === 'none') assert.equal(spec, 'not found', label)
    if (spec === 'not found') {
      assert.equal(run, 'no', label)
      assert.match(operations!, /^no journey\b/, label)
    } else if (spec === 'phrozen.spec.ts')
      assert.equal(
        operations,
        'read-only status, connection loss and recovery; with a test-only qualification: signed pause, resume and cancel',
        label,
      )
    else if (statusOnly.includes(spec!))
      assert.equal(
        operations,
        'read-only status, connection loss and recovery',
        label,
      )
  }
})
