import { isAbsolute, relative } from 'node:path'

export function acceptanceOptions(env: NodeJS.ProcessEnv, checkout: string) {
  const image = env.CONFIGURATION_POSTGRES_IMAGE ?? ''
  const context = env.CONFIGURATION_POSTGRES_CONTEXT ?? ''
  const evidence = env.CONFIGURATION_POSTGRES_EVIDENCE ?? ''
  const port = Number(env.CONFIGURATION_POSTGRES_PORT)
  if (
    env.CONFIGURATION_POSTGRES_ADMITTED !== 'yes' ||
    !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
      image,
    ) ||
    !/^colima-openfarm-[a-z0-9-]+$/.test(context) ||
    !isAbsolute(evidence) ||
    !relative(checkout, evidence).startsWith('../') ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error(
      'Explicit admission, owned context, pinned PostgreSQL 17 image, external evidence directory and loopback port required',
    )
  return { image, context, evidence, port }
}
