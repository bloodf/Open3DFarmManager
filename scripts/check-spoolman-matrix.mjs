// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath) {
  const absolute = join(ROOT, relativePath)
  return { absolute, value: JSON.parse(readFileSync(absolute, 'utf8')) }
}

function sha256(relativePath) {
  return createHash('sha256')
    .update(readFileSync(join(ROOT, relativePath)))
    .digest('hex')
}

function fail(message) {
  console.error(`check-spoolman-matrix: ${message}`)
  process.exitCode = 1
}

const PRODUCT_STATUSES = new Set([
  'implemented',
  'unimplemented',
  'simulator_or_test_only',
  'experimental',
])
const CLIENT_COVERAGE_STATUSES = new Set([
  'covered',
  'not_covered',
  'partial',
  'not_applicable',
  'unknown',
])

function hasValue(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function requireList(row, key, endpointId, note) {
  if (!Array.isArray(row[key])) {
    note(`matrix row ${endpointId} ${key} must be an array`)
    return
  }
  for (const [index, value] of row[key].entries()) {
    if (!hasValue(value)) {
      note(`matrix row ${endpointId} ${key}[${index}] must not be empty`)
    }
  }
}

function main() {
  const errors = []
  const note = (message) => errors.push(message)

  const lock = readJson(
    'third_party/spoolman-reference/upstream.lock.json',
  ).value
  const inventory = readJson(
    'docs/compatibility/spoolman-endpoint-inventory.json',
  ).value
  const matrix = readJson('docs/compatibility/spoolman-matrix.json').value
  const thirdParty = readFileSync(join(ROOT, 'THIRD_PARTY.md'), 'utf8')
  const licenseText = readFileSync(
    join(ROOT, 'third_party/spoolman-reference/LICENSE'),
    'utf8',
  )

  const expectedRevision = 'ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b'
  const requiredThirdParty = [
    'Daniel Hultgren',
    expectedRevision,
    'v0.27.1',
    'third_party/spoolman-reference/LICENSE',
    'docs/compatibility/spoolman-matrix.json',
  ]

  for (const needle of requiredThirdParty) {
    if (!thirdParty.includes(needle)) {
      note(`THIRD_PARTY.md missing required attribution fragment: ${needle}`)
    }
  }

  if (!licenseText.includes('MIT License')) {
    note('upstream LICENSE does not contain expected MIT License marker')
  }
  if (!licenseText.includes('Daniel Hultgren')) {
    note('upstream LICENSE missing Daniel Hultgren copyright')
  }

  for (const [artifact, relativePath] of Object.entries({
    license: 'third_party/spoolman-reference/LICENSE',
    openapi: 'docs/compatibility/spoolman-openapi-v0.27.1.json',
    inventory: 'docs/compatibility/spoolman-endpoint-inventory.json',
    matrix: 'docs/compatibility/spoolman-matrix.json',
  })) {
    const digest = sha256(relativePath)
    if (lock.artifacts_sha256?.[artifact] !== digest) {
      note(
        `upstream.lock.json artifacts_sha256.${artifact} does not match ${relativePath}`,
      )
    }
  }

  if (lock.upstream?.source_revision !== expectedRevision) {
    note('upstream.lock.json source_revision mismatch')
  }
  if (inventory.upstream?.source_revision !== expectedRevision) {
    note('endpoint inventory source_revision mismatch')
  }
  if (matrix.upstream?.source_revision !== expectedRevision) {
    note('matrix source_revision mismatch')
  }
  if (inventory.upstream?.version_tag !== 'v0.27.1') {
    note('endpoint inventory version_tag must be v0.27.1')
  }

  const openapiDigest = sha256(
    'docs/compatibility/spoolman-openapi-v0.27.1.json',
  )
  if (inventory.upstream?.openapi_sha256 !== openapiDigest) {
    note('inventory openapi_sha256 does not match committed openapi file')
  }
  if (lock.upstream?.openapi_sha256 !== openapiDigest) {
    note('lock openapi_sha256 does not match committed openapi file')
  }

  const licenseDigest = sha256('third_party/spoolman-reference/LICENSE')
  if (inventory.upstream?.license_sha256 !== licenseDigest) {
    note('inventory license_sha256 does not match committed LICENSE')
  }
  if (lock.upstream?.license_sha256 !== licenseDigest) {
    note('lock license_sha256 does not match committed LICENSE')
  }

  if (matrix.endpoint_count !== inventory.endpoints.length) {
    note(
      `matrix.endpoint_count (${matrix.endpoint_count}) != inventory endpoints (${inventory.endpoints.length})`,
    )
  }

  const matrixById = new Map(matrix.rows.map((row) => [row.endpoint_id, row]))
  for (const endpoint of inventory.endpoints) {
    const row = matrixById.get(endpoint.id)
    if (!row) {
      note(`matrix missing row for inventory endpoint ${endpoint.id}`)
      continue
    }
    if (row.method !== endpoint.method || row.path !== endpoint.path) {
      note(`matrix row drift for ${endpoint.id}`)
    }
    if (!row.product_status) {
      note(`matrix row ${endpoint.id} missing product_status`)
    }

    const upstreamStatuses = [...(endpoint.responses ?? [])].map(String).sort()
    const matrixStatuses = Array.isArray(row.statuses)
      ? row.statuses.map((status) => String(status.code ?? '')).sort()
      : []
    if (JSON.stringify(matrixStatuses) !== JSON.stringify(upstreamStatuses)) {
      note(`matrix row ${endpoint.id} statuses do not match pinned inventory`)
    }

    for (const field of ['request_schema', 'output_schema']) {
      if (!hasValue(row[field])) {
        note(`matrix row ${endpoint.id} missing ${field}`)
      }
    }

    for (const field of [
      'statuses',
      'errors',
      'relevant_headers',
      'evidence',
      'gaps',
    ]) {
      requireList(row, field, endpoint.id, note)
    }

    if (!row.evidence?.length && !row.gaps?.length) {
      note(`matrix row ${endpoint.id} needs evidence or an explicit gap`)
    }

    if (
      typeof row.external_client_coverage_status !== 'string' ||
      !CLIENT_COVERAGE_STATUSES.has(row.external_client_coverage_status)
    ) {
      note(
        `matrix row ${endpoint.id} external_client_coverage_status must be one of ${[...CLIENT_COVERAGE_STATUSES].join(', ')}`,
      )
    }

    if (
      typeof row.builtin_server_compatibility_status !== 'string' ||
      !PRODUCT_STATUSES.has(row.builtin_server_compatibility_status)
    ) {
      note(
        `matrix row ${endpoint.id} builtin_server_compatibility_status must be one of ${[...PRODUCT_STATUSES].join(', ')}`,
      )
    }

    // product_status is retained as a compatibility alias and always describes
    // the built-in replacement server. External client calls cannot establish
    // that the server implements an upstream endpoint.
    if (
      row.builtin_server_compatibility_status &&
      row.product_status !== row.builtin_server_compatibility_status
    ) {
      note(
        `matrix row ${endpoint.id} product_status must match builtin_server_compatibility_status`,
      )
    }
  }

  for (const row of matrix.rows) {
    if (
      !matrixById.has(row.endpoint_id) ||
      matrixById.get(row.endpoint_id) !== row
    ) {
      note(`duplicate or orphan matrix endpoint_id ${row.endpoint_id}`)
    }
  }

  const inventoryIds = new Set(inventory.endpoints.map((e) => e.id))
  for (const row of matrix.rows) {
    if (!inventoryIds.has(row.endpoint_id)) {
      note(`matrix row ${row.endpoint_id} not present in inventory`)
    }
  }

  if (
    !Array.isArray(matrix.client_contracts) ||
    matrix.client_contracts.length < 3
  ) {
    note('matrix.client_contracts must list maintained request contracts')
  }

  for (const row of matrix.rows) {
    if (
      ['covered', 'partial'].includes(row.external_client_coverage_status) &&
      !matrix.client_contracts.some(
        (contract) =>
          contract.method === row.method && contract.path === row.path,
      )
    ) {
      note(
        `matrix row ${row.endpoint_id} claims external client coverage without a matching client contract`,
      )
    }
  }

  for (const fixture of matrix.fixture_provenance ?? []) {
    const digest = sha256(fixture.path)
    if (fixture.sha256 !== digest) {
      note(`fixture provenance sha256 mismatch for ${fixture.path}`)
    }
  }

  const schemaNames = new Set(Object.keys(inventory.schemas ?? {}))
  if (schemaNames.size < 50) {
    note(`expected at least 50 documented schemas, got ${schemaNames.size}`)
  }

  for (const event of inventory.websocket_events ?? []) {
    if (!event.model?.endsWith('Event')) {
      note(`unexpected websocket event model name ${event.model}`)
    }
  }

  const implemented = matrix.rows.filter(
    (r) => r.builtin_server_compatibility_status === 'implemented',
  )
  if (implemented.length !== 0) {
    note(
      `expected 0 implemented built-in server endpoints; external connector client calls do not establish server compatibility, got ${implemented.length}`,
    )
  }

  if (errors.length === 0) {
    console.log(
      JSON.stringify({
        result: 'passed',
        version_tag: inventory.upstream.version_tag,
        source_revision: inventory.upstream.source_revision,
        endpoints: inventory.endpoints.length,
        schemas: schemaNames.size,
        websocket_event_models: (inventory.websocket_events ?? []).length,
        implemented_product_endpoints: implemented.map((r) => r.endpoint_id),
      }),
    )
    return
  }

  for (const message of errors) fail(message)
  process.exit(1)
}

main()
