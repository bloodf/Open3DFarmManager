import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type Value = string | Value[] | { [key: string]: Value }
type Mapping = { [key: string]: Value }

// Parse the compose file's YAML subset without Docker or installed dependencies.
// Unsupported YAML fails closed so a new mount syntax cannot evade this test.
function parseCompose(source: string): Mapping {
  const lines = source.split('\n').filter((line) => !/^\s*(#|$)/.test(line))
  const anchors: Record<string, Mapping> = {}
  let index = 0
  const indent = (line: string) => line.length - line.trimStart().length
  function scalar(value: string): Value {
    if (/^\[[^\[\]{}]*\]$/.test(value)) {
      return value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    if (/^'[^']*'$/.test(value)) return value.slice(1, -1)
    assert.match(value, /^[\w./,:@$*{}=-]+$/, `unsupported scalar: ${value}`)
    return value
  }
  function block(level: number): Value {
    const sequence = lines[index]?.trimStart().startsWith('- ')
    const result: Mapping | Value[] = sequence ? [] : {}
    while (index < lines.length && indent(lines[index]!) === level) {
      const text = lines[index]!.trim()
      index++
      if (sequence) {
        assert.ok(text.startsWith('- '), `unsupported sequence: ${text}`)
        ;(result as Value[]).push(scalar(text.slice(2)))
        continue
      }
      const match = /^(<<|[\w.-]+):(?:\s+(.*))?$/.exec(text)
      assert.ok(match, `unsupported mapping: ${text}`)
      const [, key, rest = ''] = match
      assert.ok(key)
      if (key === '<<') {
        assert.match(rest, /^\*\w+$/)
        const anchor = anchors[rest.slice(1)]
        assert.ok(anchor, `unknown anchor: ${rest}`)
        Object.assign(result, anchor)
      } else {
        let value: Value
        if (rest.startsWith('&')) {
          assert.match(rest, /^&\w+$/)
          assert.ok(index < lines.length && indent(lines[index]!) > level)
          value = block(indent(lines[index]!))
          assert.ok(!Array.isArray(value) && typeof value === 'object')
          anchors[rest.slice(1)] = value
        } else if (rest) {
          value = scalar(rest)
        } else if (index < lines.length && indent(lines[index]!) > level) {
          value = block(indent(lines[index]!))
        } else {
          value = ''
        }
        ;(result as Mapping)[key] = value
      }
    }
    return result
  }
  const parsed = block(0)
  assert.equal(index, lines.length, `unsupported YAML near line ${index + 1}`)
  assert.ok(!Array.isArray(parsed) && typeof parsed === 'object')
  return parsed
}

function mapping(value: Value | undefined): Mapping {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

function check(source: string) {
  const compose = parseCompose(source)
  const services = mapping(compose.services)
  const volumes = mapping(compose.volumes)
  for (const name of ['sv06', 'u1']) {
    const service = mapping(services[name])
    assert.deepEqual(service.cap_drop, ['ALL'])
    assert.deepEqual(service.security_opt, ['no-new-privileges:true'])
    assert.equal(service.user, 'printer')
  }
  const allowedBinds = new Set([
    './sv06/moonraker.conf:/home/printer/example-configs/moonraker.conf:ro',
    './u1/printer.cfg:/home/printer/example-configs/printer.cfg:ro',
    './u1/tools.cfg:/home/printer/example-configs/addons/open3d-tools.cfg:ro',
    './u1/moonraker.conf:/home/printer/example-configs/moonraker.conf:ro',
    './rtsp/mediamtx.yml:/mediamtx.yml:ro',
  ])
  for (const [name, value] of Object.entries(services)) {
    const service = mapping(value)
    for (const key of [
      'devices',
      'device_cgroup_rules',
      'volumes_from',
      'privileged',
    ]) {
      assert.equal(service[key], undefined, `${name}: ${key} is forbidden`)
    }
    const mounts = service.volumes ?? []
    assert.ok(Array.isArray(mounts), `${name}: unsupported volumes`)
    for (const mount of mounts) {
      assert.ok(typeof mount === 'string', `${name}: unsupported mount`)
      if (allowedBinds.has(mount)) continue
      const match = /^([\w-]+):([^:]+)$/.exec(mount)
      assert.ok(
        match && Object.hasOwn(volumes, match[1]!),
        `${name}: unsafe mount ${mount}`,
      )
      assert.equal(
        volumes[match[1]!],
        '',
        `${name}: volume configuration is not allowed`,
      )
      assert.doesNotMatch(
        match[2]!,
        /(?:^|\/)(?:dev|run|var\/run)(?:\/|$)|\.sock(?:\/|$)/i,
      )
    }
  }
}

const source = readFileSync(
  new URL('../../infra/sim/docker-compose.yml', import.meta.url),
  'utf8',
)
test('simulator compose restricts printers and mounts', () => check(source))
test('rejects hardware, sockets and unsafe volume declarations', () => {
  for (const mount of [
    '/dev/ttyUSB0:/dev/ttyUSB0',
    '/var/run/docker.sock:/tmp/docker.sock',
    './socket:/tmp/socket',
  ]) {
    assert.throws(() =>
      check(
        source.replace(
          '      - sv06-data:/home/printer/printer_data',
          `      - ${mount}`,
        ),
      ),
    )
  }
  assert.throws(() =>
    check(
      source.replace('  sv06-data:\n', '  sv06-data:\n    driver_opts: {}\n'),
    ),
  )
  assert.throws(() =>
    check(
      source.replace(
        '    <<: *printer\n',
        '    <<: *printer\n    devices: [unsafe]\n',
      ),
    ),
  )
})
test('camera base image is pinned by digest', () => {
  const dockerfile = readFileSync(
    new URL('../../packages/sim-cams/Dockerfile', import.meta.url),
    'utf8',
  )
  assert.match(dockerfile, /^FROM node:24\.22\.3-alpine@sha256:[a-f0-9]{64}$/m)
})
