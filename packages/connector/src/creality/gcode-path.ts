const legacyDirectory = '/usr/data/printer_data/gcodes'
const udiskDirectory = '/mnt/UDISK/printer_data/gcodes'
const udiskReference = 'creality-udisk:'

function validName(name: string) {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9_. -]*\.gcode$/i.test(name) &&
    !name.includes('..') &&
    Buffer.byteLength(name) <= 255
  )
}

export function crealityGcodePath(file: string) {
  const udisk = file.startsWith(udiskReference)
  const name = udisk ? file.slice(udiskReference.length) : file
  if (!validName(name) || file.length > 255)
    throw new Error('Invalid Creality filename')
  return `${udisk ? udiskDirectory : legacyDirectory}/${name}`
}

export function crealityGcodeReference(name: string, path: string) {
  if (!validName(name)) return undefined
  if (path === `${legacyDirectory}/${name}`) return name
  const reference = udiskReference + name
  if (path === `${udiskDirectory}/${name}` && reference.length <= 255)
    return reference
  return undefined
}
