import { isAbsolute, relative, sep } from 'node:path'

/** Validate before opening Docker, sockets, databases or browser contexts. */
export function registrationAdmission(
  env: NodeJS.ProcessEnv,
  checkout: string,
) {
  const evidence = env.KOBRALINK_RTC_EVIDENCE ?? ''
  const outside = relative(checkout, evidence)
  const postgresImage = env.KOBRALINK_RTC_POSTGRES_IMAGE ?? ''
  const kobraImage = env.KOBRALINK_RTC_KOBRA_IMAGE ?? ''
  const ports = ['DB', 'HTTPS', 'KOBRA', 'MQTT'].map((key) =>
    Number(env[`KOBRALINK_RTC_${key}_PORT`]),
  )
  if (
    env.KOBRALINK_RTC_ADMITTED !== 'yes' ||
    env.KOBRALINK_RTC_CONTEXT !== 'colima-openfarm-kobralink-togiej' ||
    !isAbsolute(evidence) ||
    !(outside === '..' || outside.startsWith('..' + sep)) ||
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
      'Explicit admission, exact owned context, external private evidence, pinned images, upstream 5a5e5d9 and four distinct unprivileged loopback ports required',
    )
  return { evidence, postgresImage, kobraImage, ports }
}
