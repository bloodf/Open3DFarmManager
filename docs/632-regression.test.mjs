import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const commandSecurity = read('./COMMAND-SECURITY.md')
const localCi = read('./LOCAL-CI.md')
const baseline = read('./compatibility/install-baseline.md')
const rtsp = read('./connector/rtsp-ingest.md')
const rtcBackend = read('./RTC-BACKEND-DECISION.md')
const signalling = read('./SIGNALLING-RUNTIME-CHECKPOINT.md')
const desktop = read('./desktop-check.md')
const camera = read('./CAMERA-END-TO-END-CHECKPOINT.md')
const gate = read('../scripts/local-ci.sh')
const packageJson = JSON.parse(read('../package.json'))

assert.ok(commandSecurity.includes('verifyCommandV2'))
assert.ok(
  commandSecurity.includes(
    'packages/connector/src/control/pause-dispatcher.ts',
  ),
)
for (const [label, document] of Object.entries({ localCi, baseline, rtsp })) {
  assert.doesNotMatch(document, /\bpnpm\b/i, `${label} must use npm commands`)
}
assert.doesNotMatch(rtcBackend, /blocked on (the )?npm migration/i)
assert.match(
  signalling,
  /^### Signalling successor credentials \(migration 0030\)$/m,
)
assert.doesNotMatch(desktop, /npm run desktop:bundle/)
assert.match(desktop, /npm run desktop:check/)

const gateLine = gate.split('\\n').find((line) => line.includes('node_ver =~'))
const nodeRegexSource = gateLine?.split('node_ver =~ ')[1]?.split(' ]]')[0]
assert.ok(nodeRegexSource, 'local CI must retain a Node version gate')
const nodeRegex = new RegExp(nodeRegexSource)
const accepts = (version) => nodeRegex.test(version)
for (const version of [
  'v22.22.3',
  'v22.22.10',
  'v22.23.0',
  'v24.22.2',
  'v24.99.99',
]) {
  assert.ok(accepts(version), `${version} should be accepted`)
}
for (const version of [
  'v22.18.0',
  'v22.22.2',
  'v23.0.0',
  'v24.22.1',
  'v25.0.0',
]) {
  assert.ok(!accepts(version), `${version} should be rejected`)
}
assert.equal(packageJson.engines.node, '^22.22.3 || >=24.22.2 <25')
assert.doesNotMatch(camera, /64 MiB per session/)
assert.doesNotMatch(camera, /"address": "192\.0\.2\.10"/)
assert.match(camera, /16 MiB per lease/)
assert.match(camera, /"address": "127\.0\.0\.1"/)
