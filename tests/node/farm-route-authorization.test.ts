import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = process.cwd()
const server = 'apps/farm/server'
// Deliberately explicit: additions require a reviewed reason and stale entries fail.
const EXEMPT: Record<string, string> = {}

// These are the actual HTTP entry points for the existing farm authorization
// services. Match both export and module, never just an identifier's spelling.
const GUARDS: Record<string, string[]> = {
  'services/connector-inventory.ts': ['connectorInventory'],
  'services/connector-pairing.ts': ['connectorPairing'],
  'services/printer-assignments.ts': ['printerAssignments'],
  'services/printer-profiles.ts': ['printerProfiles'],
  'services/printer-states.ts': ['printerStates'],
  'services/status-summary.ts': ['statusSummary'],
  'services/farm-network.ts': ['farmNetwork'],
  'services/spoolman-farm-setting.ts': ['spoolmanFarmSetting'],
  'services/spool-library-http.ts': ['spoolLibraryResource'],
  'services/spool-library-import.ts': ['spoolLibraryImport'],
  'services/spool-drying.ts': ['spoolFeature'],
  'services/spool-slots-http.ts': ['spoolSlotsFeature'],
  'services/spool-usage.ts': [
    'spoolUsageFeature',
    'spoolUsageReport',
    'spoolInventoryReport',
  ],
  'services/members-http.ts': ['membersRoute'],
  'services/sign-in-rules.ts': ['signInRulesRoute'],
  'services/account-registration.ts': ['createFarmInvite'],
  'utils/library/routes.ts': ['libraryRoutes'],
  'utils/bambu-cloud/http.ts': ['bambuCloudAccountHttp'],
  'utils/bambu-cloud/import-history-http.ts': ['bambuCloudHistoryHttp'],
  'utils/bambu-cloud/import-printers-http.ts': ['bambuCloudPrintersHttp'],
}

type Import = { local: string; exported: string; module: string }
function source(file: string) {
  return readFileSync(path.join(root, file), 'utf8')
}
function parse(file: string, text: string) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}
function importsAndCalls(file: string, text: string) {
  const tree = parse(file, text)
  const imports: Import[] = []
  const calls = new Set<string>()
  let storage = false
  function visit(node: ts.Node, inHandler = false) {
    if (ts.isExportAssignment(node)) inHandler = true
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text
      const resolved = spec.startsWith('.')
        ? path.normalize(path.join(path.dirname(file), spec))
        : spec
      if (
        resolved.startsWith(`${server}/storage/`) ||
        spec.includes('/server/storage/')
      )
        storage = true
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements) {
          if (!item.isTypeOnly && !node.importClause?.isTypeOnly)
            imports.push({
              local: item.name.text,
              exported: (item.propertyName ?? item.name).text,
              module: resolved,
            })
        }
    }
    if (ts.isCallExpression(node)) {
      if (inHandler && ts.isIdentifier(node.expression))
        calls.add(node.expression.text)
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const spec = node.arguments[0].text
        const resolved = spec.startsWith('.')
          ? path.normalize(path.join(path.dirname(file), spec))
          : spec
        if (
          resolved.startsWith(`${server}/storage/`) ||
          spec.includes('/server/storage/')
        )
          storage = true
      }
    }
    ts.forEachChild(node, (child) => visit(child, inHandler))
  }
  visit(tree)
  return { imports, calls, storage, text }
}
function called(
  parsed: ReturnType<typeof importsAndCalls>,
  module: string,
  name: string,
) {
  return parsed.imports.some(
    (i) =>
      i.module === `${server}/${module}` &&
      i.exported === name &&
      parsed.calls.has(i.local),
  )
}
function checkRoute(file: string, text: string): string | undefined {
  const parsed = importsAndCalls(file, text)
  if (parsed.storage) return 'direct storage import'
  if (
    Object.entries(GUARDS).some(([module, names]) =>
      names.some((name) => called(parsed, module, name)),
    )
  )
    return
  // These paths combine authentication with a separate owner/role service.
  if (
    called(
      parsed,
      'utils/integration-owner-apps-runtime.ts',
      'ownerAppsRuntime',
    ) &&
    [
      'listOwnerApps',
      'createOwnerApp',
      'listOwnerGrants',
      'createOwnerGrant',
      'revokeOwnerGrant',
      'revokeOwnerApp',
      'revokeOwnerCredential',
    ].some((n) => called(parsed, 'services/integration-owner-apps-http.ts', n))
  )
    return
  if (
    called(
      parsed,
      'utils/integration-approval-http-runtime.ts',
      'approvalHttpDeps',
    ) &&
    ['listApprovalsRequest', 'decideApprovalRequest'].some((n) =>
      called(parsed, 'services/integration-approval-http.ts', n),
    )
  )
    return
  if (
    called(
      parsed,
      'services/authenticated-session.ts',
      'authenticatedSession',
    ) &&
    called(
      parsed,
      'services/integration-audit-http.ts',
      'listIntegrationAudit',
    ) &&
    called(parsed, 'utils/auth/runtime.ts', 'authRuntime')
  )
    return
  if (
    called(
      parsed,
      'services/authenticated-session.ts',
      'authenticatedSession',
    ) &&
    called(
      parsed,
      'services/authenticated-session.ts',
      'sealedSessionRecordId',
    ) &&
    called(parsed, 'services/authenticated-session.ts', 'authResponse') &&
    called(parsed, 'utils/auth/runtime.ts', 'authRuntime') &&
    called(parsed, 'utils/spool-library/runtime.ts', 'spoolLibraryRuntime') &&
    /\.issueLegacyCredential\s*\(/.test(text)
  )
    return
  // The integration middleware authenticates the bearer and places its principal
  // in the request context; these handlers must additionally narrow farm grants.
  if (
    file.startsWith(`${server}/api/integrations/v1/`) &&
    /event\.context\.integrationAuth/.test(text) &&
    (called(parsed, 'utils/integration-read.ts', 'inventoryGrantFarms') ||
      called(parsed, 'utils/integration-read.ts', 'jobGrantScope'))
  )
    return
  if (file in EXEMPT) return
  return 'no recognised authorization guard'
}
function walk(dir: string): string[] {
  if (!existsSync(path.join(root, dir))) return []
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const name = `${dir}/${entry.name}`
      return entry.isDirectory()
        ? walk(name)
        : entry.isFile() && name.endsWith('.ts')
          ? [name]
          : []
    },
  )
}

test('farm routes use an authorization guard', () => {
  const files = [...walk(`${server}/api`), ...walk(`${server}/routes`)]
  const routes = files.filter(
    (file) =>
      file.startsWith(`${server}/api/farms/`) ||
      /\bfarmId\b/.test(source(file)),
  )
  assert.ok(routes.length > 0)
  for (const file of Object.keys(EXEMPT))
    assert.ok(routes.includes(file), `stale exemption: ${file}`)
  const failures = routes.flatMap((file) => {
    const error = checkRoute(file, source(file))
    return error ? [`${file}: ${error}`] : []
  })
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('direct storage imports are rejected even when a guard is called', () => {
  const file = `${server}/api/farms/[farmId]/fixture.get.ts`
  const fixture = `import { connectorInventory } from '../../../services/connector-inventory.ts'; import { anything } from '../../../storage/example.ts'; connectorInventory();`
  assert.equal(checkRoute(file, fixture), 'direct storage import')
})

// Pin the security-relevant parts of the recognised entry points as well as
// the route imports. A renamed/refactored guard must be reviewed, not silently
// treated as safe merely because its old exported name remains.
function functionBody(module: string, name: string): string {
  const file = `${server}/${module}`
  const tree = parse(file, source(file))
  const declaration = tree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  assert.ok(
    declaration && ts.isFunctionDeclaration(declaration) && declaration.body,
    `missing ${module}:${name}`,
  )
  return declaration.body.getText(tree)
}

test('recognised guards retain their session and scope checks', () => {
  const direct = Object.entries(GUARDS).flatMap(([module, names]) =>
    names.map((name) => [module, name] as const),
  )
  const special = new Set([
    'spoolUsageReport',
    'spoolInventoryReport',
    'membersRoute',
    'signInRulesRoute',
    'createFarmInvite',
  ])
  for (const [module, name] of direct) {
    if (special.has(name)) continue
    const body = functionBody(module, name)
    for (const call of [
      'authRuntime',
      'authResponse',
      'sealedSessionRecordId',
    ]) {
      assert.match(
        body,
        new RegExp(`\\b${call}\\s*\\(`),
        `${module}:${name} must call ${call}`,
      )
    }
    assert.match(
      body,
      /sessionRecordId|sessionId/,
      `${module}:${name} must pass the session`,
    )
  }
  const scopeCalls: Record<string, string> = {
    connectorInventory: 'storage.listConnectors',
    connectorPairing: 'runtime.revocation.revoke',
    printerAssignments: 'runtime.inventory.list',
    printerProfiles: 'profiles.read',
    printerStates: 'reader.list',
    statusSummary: 'reader.list',
    farmNetwork: 'reader.read',
    spoolmanFarmSetting: 'runtime.settings.list',
    spoolLibraryResource: 'storage.withScope',
    spoolLibraryImport: 'runSpoolLibraryImport',
    spoolFeature: ').run(',
    spoolSlotsFeature: 'access.authorize',
    spoolUsageFeature: ').run(',
    libraryRoutes: 'runtime.store.getSettings',
    bambuCloudAccountHttp: 'readBambuCloudAccount',
    bambuCloudHistoryHttp: 'ownerStore.member',
    bambuCloudPrintersHttp: 'listImportableBambuCloudPrinters',
  }
  for (const [module, name] of direct) {
    const call = scopeCalls[name]
    if (call)
      assert.ok(
        functionBody(module, name).includes(call),
        `${module}:${name} missing scoped operation ${call}`,
      )
  }
  for (const file of [
    'postgres-connector-inventory.ts',
    'postgres-printer-assignment-inventory.ts',
    'postgres-spoolman-settings.ts',
    'postgres-spool-library.ts',
  ]) {
    const body = source(`${server}/storage/${file}`)
    assert.ok(
      body.includes('farm.memberships') && body.includes('revoked_at'),
      `${file} missing membership check`,
    )
  }
  for (const name of ['spoolUsageReport', 'spoolInventoryReport'])
    assert.match(
      functionBody('services/spool-usage.ts', name),
      /spoolUsageFeature\s*\(/,
    )
  assert.match(
    functionBody('services/members-http.ts', 'membersRoute'),
    /authenticatedSession\s*\(/,
  )
  assert.match(
    functionBody('services/sign-in-rules.ts', 'signInRulesRoute'),
    /authenticatedSession\s*\([\s\S]*signInRules\.access\s*\(/,
  )
  assert.match(
    functionBody('services/account-registration.ts', 'createFarmInvite'),
    /authenticatedSession\s*\([\s\S]*createInvite\s*\(/,
  )
  assert.match(
    functionBody('services/spool-slots-http.ts', 'spoolSlotsFeature'),
    /access\.authorize\s*\(/,
  )
  for (const file of [
    'storage/postgres-spool-slot-access.ts',
    'storage/postgres-spool-usage.ts',
  ]) {
    const body = source(`${server}/${file}`)
    for (const marker of [
      'evaluateSession',
      'farm.memberships',
      'revoked_at',
      'authority.farmId',
      'decision.accountId',
    ])
      assert.ok(body.includes(marker), `${file} missing ${marker}`)
  }
  const middleware = source(`${server}/middleware/integrations-auth.ts`)
  for (const marker of [
    'integrationPath(',
    'authorizeIntegrationRequest(',
    'event.context.integrationAuth = result.principal',
  ])
    assert.ok(
      middleware.includes(marker),
      `integration middleware missing ${marker}`,
    )
  assert.match(
    functionBody('utils/integration-owner-apps-runtime.ts', 'ownerAppsRuntime'),
    /authenticatedSession\s*\([\s\S]*farm\.memberships[\s\S]*role = 'owner'/,
  )
  assert.match(
    source(`${server}/services/integration-owner-apps-http.ts`),
    /deps\.isOwner\s*\(/,
  )
})
