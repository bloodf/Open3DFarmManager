import { dirname, isAbsolute, join, relative } from 'node:path'
import { lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export function admitEvidence(evidence: string, checkout: string) {
  if (
    !isAbsolute(evidence) ||
    relative(checkout, evidence) !== join('.output', 'kobralink-rtc-evidence')
  )
    throw new Error('Only ignored .output/kobralink-rtc-evidence is admitted')
  for (const path of [join(checkout, '.output'), evidence])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Evidence symlinks are forbidden')
  execFileSync('git', ['check-ignore', '-q', evidence], { cwd: checkout })
  if (
    execFileSync('git', ['ls-files', '--', evidence], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('Tracked evidence is forbidden')
}

/**
 * Validates a generated fixture path (such as layer, output, or ledger)
 * under the admitted evidence root for a run.
 */
export function admitEvidenceChild(child: string, checkout: string) {
  if (!isAbsolute(child))
    throw new Error('An absolute evidence child path is required')
  const canonicalEvidence = join(checkout, '.output', 'kobralink-rtc-evidence')
  admitEvidence(canonicalEvidence, checkout)
  const relFromCheckout = relative(checkout, child)
  const r = relative(canonicalEvidence, child)
  if (
    !r ||
    r.startsWith('..') ||
    isAbsolute(r) ||
    r.split(/[/\\]/).includes('..')
  )
    throw new Error('Fixture path must be inside admitted evidence')
  let curr = child
  while (curr.length >= checkout.length && curr.startsWith(checkout)) {
    if (lstatSync(curr, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Evidence symlinks are forbidden')
    const parent = dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  if (
    execFileSync('git', ['ls-files', '--', relFromCheckout], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('Tracked evidence is forbidden')
}

/** Validate before opening Docker, sockets, databases or browser contexts. */
export function registrationAdmission(
  env: NodeJS.ProcessEnv,
  checkout: string,
) {
  const evidence = env.KOBRALINK_RTC_EVIDENCE ?? ''
  admitEvidence(evidence, checkout)
  const postgresImage = env.KOBRALINK_RTC_POSTGRES_IMAGE ?? ''
  const kobraImage = env.KOBRALINK_RTC_KOBRA_IMAGE ?? ''
  const ports = ['DB', 'HTTPS', 'KOBRA', 'MQTT'].map((key) =>
    Number(env[`KOBRALINK_RTC_${key}_PORT`]),
  )
  if (
    env.KOBRALINK_RTC_ADMITTED !== 'yes' ||
    env.KOBRALINK_RTC_CONTEXT !== 'colima-openfarm-kobralink-togiej' ||
    !isAbsolute(evidence) ||
    !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
      postgresImage,
    ) ||
    !(
      /^[^\s]+@sha256:[a-f0-9]{64}$/.test(kobraImage) ||
      kobraImage ===
        'sha256:9865baa7346eb87d8860ced1881c30a1e5600b979d618c44757228407dce22e3'
    ) ||
    env.KOBRALINK_RTC_UPSTREAM_REVISION !== '5a5e5d9' ||
    ports.some(
      (port) => !Number.isInteger(port) || port < 1024 || port > 65535,
    ) ||
    new Set(ports).size !== ports.length
  )
    throw new Error(
      'Explicit admission, exact owned context, ignored synthetic evidence, pinned images, upstream 5a5e5d9 and four distinct unprivileged loopback ports required',
    )
  return { evidence, postgresImage, kobraImage, ports }
}
