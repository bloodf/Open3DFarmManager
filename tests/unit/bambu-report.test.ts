import { describe, expect, it } from 'vitest'
import {
  decodeBambuReport,
  mapBambuGcodeState,
  normalizeBambuProgress,
  parseBambuTemperature,
  MAX_BAMBU_FRAME_BYTES,
} from '../../packages/connector/src/bambu/report.ts'

describe('Bambu Report Decoder', () => {
  describe('mapBambuGcodeState', () => {
    it.each([
      ['IDLE', 'idle'],
      ['idle', 'idle'],
      ['FINISH', 'idle'],
      ['finish', 'idle'],
      ['PREPARE', 'printing'],
      ['prepare', 'printing'],
      ['RUNNING', 'printing'],
      ['running', 'printing'],
      ['PAUSE', 'paused'],
      ['pause', 'paused'],
      ['FAILED', 'error'],
      ['failed', 'error'],
      ['OFFLINE', 'offline'],
      ['offline', 'offline'],
    ])('maps documented %s to %s', (input, expected) => {
      expect(mapBambuGcodeState(input)).toBe(expected)
    })

    it.each([
      ['INIT'],
      ['SLICING'],
      ['UNKNOWN'],
      ['unknown'],
      ['CALIBRATING'],
      [''],
      ['   '],
      [null],
      [undefined],
      [123],
      [{}],
      [[]],
    ])(
      'returns undefined for undocumented/unknown/missing state %j (never defaults to idle/offline/error)',
      (input) => {
        expect(mapBambuGcodeState(input)).toBeUndefined()
      },
    )
  })

  describe('normalizeBambuProgress', () => {
    it.each([
      [0, 0],
      [50, 0.5],
      [100, 1],
      [25.5, 0.255],
      ['0', 0],
      ['50', 0.5],
      ['100', 1],
      ['25.5', 0.255],
    ])('normalizes valid percent %j to %j', (input, expected) => {
      expect(normalizeBambuProgress(input)).toBe(expected)
    })

    it.each([
      [-1],
      [101],
      ['-5'],
      ['150'],
      ['abc'],
      [''],
      [null],
      [undefined],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY],
      [{}],
      [[]],
    ])('returns undefined for invalid or out-of-range progress %j', (input) => {
      expect(normalizeBambuProgress(input)).toBeUndefined()
    })
  })

  describe('parseBambuTemperature', () => {
    it.each([
      [0, 0],
      [25.4, 25.4],
      [220, 220],
      [-5.5, -5.5],
      ['25.4', 25.4],
      ['220', 220],
    ])('parses finite temperature %j to %j', (input, expected) => {
      expect(parseBambuTemperature(input)).toBe(expected)
    })

    it.each([
      [''],
      ['abc'],
      [null],
      [undefined],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY],
      [{}],
      [[]],
    ])(
      'returns undefined for non-finite or invalid temperature %j',
      (input) => {
        expect(parseBambuTemperature(input)).toBeUndefined()
      },
    )
  })

  describe('decodeBambuReport', () => {
    it('decodes a full push_status report frame correctly', () => {
      const frame = {
        print: {
          command: 'push_status',
          sequence_id: '1234',
          gcode_state: 'RUNNING',
          mc_percent: 42,
          nozzle_temper: 215.5,
          bed_temper: 60.0,
        },
      }

      const result = decodeBambuReport(frame)
      expect(result).toEqual({
        kind: 'observation',
        state: 'printing',
        progress: 0.42,
        toolTemperatureCelsius: 215.5,
        bedTemperatureCelsius: 60.0,
      })
    })

    it('decodes a full push_status JSON string frame correctly', () => {
      const wire = JSON.stringify({
        print: {
          command: 'push_status',
          gcode_state: 'PAUSE',
          mc_percent: 75,
          nozzle_temper: 220,
          bed_temper: 55,
        },
      })

      const result = decodeBambuReport(wire)
      expect(result).toEqual({
        kind: 'observation',
        state: 'paused',
        progress: 0.75,
        toolTemperatureCelsius: 220,
        bedTemperatureCelsius: 55,
      })
    })

    it('handles partial delta reports where only some fields are observed', () => {
      // P1 series sends partial updates containing only changed fields
      const delta1 = {
        print: {
          nozzle_temper: 210,
        },
      }
      expect(decodeBambuReport(delta1)).toEqual({
        kind: 'observation',
        toolTemperatureCelsius: 210,
      })

      const delta2 = {
        print: {
          mc_percent: 88,
        },
      }
      expect(decodeBambuReport(delta2)).toEqual({
        kind: 'observation',
        progress: 0.88,
      })

      const delta3 = {
        print: {
          gcode_state: 'FINISH',
        },
      }
      expect(decodeBambuReport(delta3)).toEqual({
        kind: 'observation',
        state: 'idle',
      })
    })

    it('does not map missing/unknown values to default idle, zero, or offline', () => {
      const frame = {
        print: {
          gcode_state: 'UNKNOWN_CUSTOM_STATE',
          mc_percent: 'invalid_num',
          nozzle_temper: null,
          bed_temper: undefined,
        },
      }

      const result = decodeBambuReport(frame)
      expect(result).toEqual({
        kind: 'observation',
      })
      // Ensure properties are strictly absent, not idle / 0
      if (result.kind === 'observation') {
        expect(result.state).toBeUndefined()
        expect(result.progress).toBeUndefined()
        expect(result.toolTemperatureCelsius).toBeUndefined()
        expect(result.bedTemperatureCelsius).toBeUndefined()
      }
    })

    it('ignores non-print messages (e.g. info.get_version or upgrade reports)', () => {
      const infoReport = {
        info: {
          command: 'get_version',
          module: [],
          sequence_id: '0',
        },
      }
      expect(decodeBambuReport(infoReport)).toEqual({ kind: 'ignored' })

      const upgradeReport = {
        upgrade: {
          command: 'get_history',
          result: 'success',
        },
      }
      expect(decodeBambuReport(upgradeReport)).toEqual({ kind: 'ignored' })
    })

    it('ignores print command acknowledgements that contain no telemetry fields', () => {
      const amsAck = {
        print: {
          command: 'ams_get_rfid',
          result: 'success',
          reason: 'success',
          ams_id: 0,
          slot_id: 0,
        },
      }
      expect(decodeBambuReport(amsAck)).toEqual({ kind: 'ignored' })
    })

    it('rejects invalid inputs: null, primitives, arrays', () => {
      expect(decodeBambuReport(null)).toEqual({
        kind: 'invalid',
        reason: 'invalid_input_type',
      })
      expect(decodeBambuReport(undefined)).toEqual({
        kind: 'invalid',
        reason: 'invalid_input_type',
      })
      expect(decodeBambuReport(12345)).toEqual({
        kind: 'invalid',
        reason: 'invalid_input_type',
      })
      expect(decodeBambuReport(true)).toEqual({
        kind: 'invalid',
        reason: 'invalid_input_type',
      })
      expect(decodeBambuReport([])).toEqual({
        kind: 'invalid',
        reason: 'not_an_object',
      })
      expect(decodeBambuReport({ print: null })).toEqual({
        kind: 'invalid',
        reason: 'invalid_print_payload',
      })
      expect(decodeBambuReport({ print: 'not_an_object' })).toEqual({
        kind: 'invalid',
        reason: 'invalid_print_payload',
      })
      expect(decodeBambuReport({ print: [] })).toEqual({
        kind: 'invalid',
        reason: 'invalid_print_payload',
      })
    })

    it('rejects malformed JSON strings', () => {
      expect(decodeBambuReport('{ "print": ')).toEqual({
        kind: 'invalid',
        reason: 'JSON input rejected: invalid-json',
      })
      expect(decodeBambuReport('not json at all')).toEqual({
        kind: 'invalid',
        reason: 'JSON input rejected: invalid-json',
      })
    })

    it('rejects JSON strings with duplicate keys (bounded JSON security check)', () => {
      const duplicateKeyJson =
        '{"print":{"mc_percent":10,"\u006dc_percent":20}}'
      const result = decodeBambuReport(duplicateKeyJson)
      expect(result.kind).toBe('invalid')
      if (result.kind === 'invalid') {
        expect(result.reason).toContain('duplicate-key')
      }
    })

    it('rejects oversized frames exceeding MAX_BAMBU_FRAME_BYTES', () => {
      const bigString = 'a'.repeat(MAX_BAMBU_FRAME_BYTES + 10)
      const bigWire = JSON.stringify({ print: { comment: bigString } })
      expect(decodeBambuReport(bigWire)).toEqual({
        kind: 'invalid',
        reason: 'frame_too_large',
      })
    })

    it('handles frames with extra unknown Bambu fields cleanly without leaking them into observation', () => {
      const rawBambuTelemetry = {
        print: {
          command: 'push_status',
          sequence_id: '999',
          gcode_state: 'IDLE',
          mc_percent: 0,
          nozzle_temper: 24.5,
          bed_temper: 23.0,
          ams: { ams: [] },
          cooling_fan_speed: '0',
          wifi_signal: '-45dBm',
          subtask_name: 'test_print.gcode',
          lights_report: [{ mode: 'on', node: 'chamber_light' }],
          xcam: { printing_monitor: true },
        },
      }

      const result = decodeBambuReport(rawBambuTelemetry)
      expect(result).toEqual({
        kind: 'observation',
        state: 'idle',
        progress: 0,
        toolTemperatureCelsius: 24.5,
        bedTemperatureCelsius: 23.0,
      })

      // Check that extraneous keys are not attached to observation
      expect(Object.keys(result).sort()).toEqual(
        [
          'bedTemperatureCelsius',
          'kind',
          'progress',
          'state',
          'toolTemperatureCelsius',
        ].sort(),
      )
    })
  })
})
