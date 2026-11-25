// Command dispatch in Klipper3d/klipper, klippy/gcode.py at
// https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/gcode.py
export function klipperCommandName(line: string): string {
  const body = line.trim().split(';', 1)[0]!
  const parts = body.toUpperCase().split(/([A-Z_]+|\*)/)
  const numbered = parts[0] === '' && parts[1] === 'N'
  return (numbered ? parts.slice(3, 5) : parts.slice(0, 3)).join('').trim()
}
