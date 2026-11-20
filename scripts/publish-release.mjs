import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const { VERSION, GH_REPO, GH_TOKEN, GITHUB_ACTOR, GITHUB_SHA } = process.env
const tag = `v${VERSION}`
const ref = `refs/tags/${tag}`
const repo = `repos/${GH_REPO}`
const files = [
  `farm-${tag}-image.tar.gz`,
  `connector-${tag}-image.tar.gz`,
  `connector-${tag}-linux-amd64.tar.gz`,
  'SHA256SUMS',
]

function run(command, args, input) {
  return execFileSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function api(path, ...args) {
  return run('gh', ['api', `${repo}/${path}`, ...args])
}

function rows(path) {
  const output = api(path, '--paginate', '--jq', '.[] | @json')
  return output ? output.split('\n').map(line => JSON.parse(line)) : []
}

function verifyTag() {
  const refs = JSON.parse(api(`git/matching-refs/tags/${tag}`))
  const existing = refs.find(entry => entry.ref === ref)
  if (!existing) return false

  let object = existing.object
  // Peel annotated tags, with a bound on malformed or deeply nested refs.
  for (let depth = 0; object.type === 'tag' && depth < 16; depth++) {
    object = JSON.parse(api(`git/tags/${object.sha}`)).object
  }
  if (object.type !== 'commit' || object.sha !== GITHUB_SHA) {
    throw new Error(`Tag ${tag} resolves to ${object.type} ${object.sha}, expected commit ${GITHUB_SHA}`)
  }
  return true
}

function missingAssets(release, digests) {
  const assets = rows(`releases/${release.id}/assets?per_page=100`)
  const missing = new Map(digests)
  for (const asset of assets) {
    if (!missing.has(asset.name) || asset.state !== 'uploaded' || asset.digest !== missing.get(asset.name)) {
      throw new Error(`Release ${tag} has an unexpected or mismatched asset: ${asset.name}`)
    }
    missing.delete(asset.name)
  }
  if (!release.draft && missing.size) {
    throw new Error(`Published release ${tag} is missing assets: ${[...missing.keys()].join(', ')}`)
  }
  return [...missing.keys()]
}

function imageToPush(component) {
  const source = `openfarm-${component}:${tag}`
  const destination = `ghcr.io/${GH_REPO.toLowerCase()}/${component}:${tag}`
  run('docker', ['load', '-i', `${component}-${tag}-image.tar.gz`])
  const imageId = image => run('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
  const expected = imageId(source)
  try {
    run('docker', ['pull', '--platform', 'linux/amd64', destination])
  } catch (error) {
    // Only a registry's explicit missing-manifest response permits a push.
    if (!/^Error response from daemon: (?:manifest for \S+ not found: )?manifest unknown\b/m.test(error.stderr ?? '')) {
      throw error
    }
    return { source, destination }
  }
  if (imageId(destination) !== expected) {
    throw new Error(`Registry image ${destination} differs from the verified archive`)
  }
}

function publish() {
  run('sha256sum', ['-c', 'SHA256SUMS'])
  const manifest = new Set(readFileSync('SHA256SUMS', 'utf8').trimEnd().split('\n').map(line => line.slice(66)))
  if (manifest.size !== files.length - 1 || files.slice(0, -1).some(file => !manifest.has(file))) {
    throw new Error('SHA256SUMS must cover all release archives')
  }
  const digests = new Map(files.map(file => [file, `sha256:${run('sha256sum', [file]).split(' ')[0]}`]))
  const hasTag = verifyTag()
  const releases = rows('releases?per_page=100').filter(release => release.tag_name === tag)
  if (releases.length > 1) throw new Error(`Multiple releases use tag ${tag}`)
  let [release] = releases
  if (release && (!hasTag || (release.draft && release.target_commitish !== GITHUB_SHA))) {
    throw new Error(`Release ${tag} cannot be tied to commit ${GITHUB_SHA}`)
  }
  const missing = release ? missingAssets(release, digests) : files

  run('docker', ['login', 'ghcr.io', '-u', GITHUB_ACTOR, '--password-stdin'], `${GH_TOKEN}\n`)
  const images = ['farm', 'connector'].map(imageToPush).filter(Boolean)
  if (!hasTag) api('git/refs', '-f', `ref=${ref}`, '-f', `sha=${GITHUB_SHA}`, '--silent')
  if (!verifyTag()) throw new Error(`Tag ${tag} disappeared during publication`)
  for (const { source, destination } of images) {
    run('docker', ['tag', source, destination])
    run('docker', ['push', destination])
  }
  if (release && !release.draft) return

  if (!release) {
    release = JSON.parse(api('releases', '-f', `tag_name=${tag}`, '-f', `target_commitish=${GITHUB_SHA}`,
      '-f', `name=${tag}`, '-F', 'draft=true', '-F', 'generate_release_notes=true'))
  }
  for (const file of missing) run('gh', ['release', 'upload', tag, file])
  const remaining = missingAssets(release, digests)
  if (remaining.length) throw new Error(`Missing uploaded assets: ${remaining.join(', ')}`)
  if (!verifyTag()) throw new Error(`Tag ${tag} disappeared during publication`)
  api(`releases/${release.id}`, '-X', 'PATCH', '-F', 'draft=false', '--silent')
}

try {
  publish()
} catch (error) {
  // Avoid logging command arguments or environment values from child errors.
  console.error(error.stderr?.trim() || error.message)
  process.exitCode = 1
}
