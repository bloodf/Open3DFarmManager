import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SpoolDryingLogRow,
  SpoolFarmSettingsRow,
  SpoolFieldDefinitionRow,
  SpoolFilamentLowStockRow,
  SpoolHumidityReadingRow,
  SpoolLocationRow,
  SpoolSettingRow,
  SpoolSlotAssignmentRow,
  SpoolUsageRecordRow,
} from '../../../apps/farm/server/storage/spool-features-types.ts'

test('spool features row types cover every migration 0089 table and invariant', () => {
  const farmId = '00000000-0000-4000-8000-000000000001'
  const printerId = '00000000-0000-4000-8000-000000000002'

  const setting: SpoolSettingRow = {
    farmId,
    key: 'currency',
    value: 'EUR',
    sourceKey: 'local',
    sourceSha256: '0'.repeat(64),
    updatedAt: 1000,
  }
  const field: SpoolFieldDefinitionRow = {
    farmId,
    entityType: 'spool',
    key: 'shelf_code',
    name: 'Shelf Code',
    fieldType: 'choice',
    sortOrder: 0,
    unit: null,
    defaultValue: null,
    choices: ['A', 'B'],
    multiChoice: false,
    sourceKey: 'local',
    sourceSha256: '0'.repeat(64),
    updatedAt: 1000,
  }
  const location: SpoolLocationRow = {
    farmId,
    name: 'Drybox 1',
    sortOrder: 0,
    createdAt: 1000,
    updatedAt: 1000,
  }
  const farmSettings: SpoolFarmSettingsRow = {
    farmId,
    defaultLowStockThresholdGrams: 150,
    currency: 'EUR',
    updatedAt: 1000,
  }
  const filamentLowStock: SpoolFilamentLowStockRow = {
    farmId,
    filamentId: 1,
    lowStockThresholdGrams: 200,
  }
  const slot: SpoolSlotAssignmentRow = {
    farmId,
    id: '00000000-0000-4000-8000-000000000003',
    spoolId: 1,
    printerId,
    slotKind: 'ams',
    slotIndex: 0,
    assignedAt: 1000,
    unassignedAt: null,
  }
  const usage: SpoolUsageRecordRow = {
    farmId,
    id: '00000000-0000-4000-8000-000000000004',
    spoolId: 1,
    jobId: null,
    printerId,
    grams: 42.5,
    source: 'telemetry',
    correctedBy: null,
    createdAt: 1000,
  }
  const drying: SpoolDryingLogRow = {
    farmId,
    id: '00000000-0000-4000-8000-000000000005',
    spoolId: 1,
    startedAt: 1000,
    endedAt: null,
    temperatureCelsius: 55,
    notes: 'PETG dry',
  }
  const humiditySpool: SpoolHumidityReadingRow = {
    farmId,
    id: '00000000-0000-4000-8000-000000000006',
    spoolId: 1,
    printerId: null,
    slotKind: null,
    slotIndex: null,
    humidityPercent: 22.5,
    source: 'manual',
    recordedAt: 1000,
  }
  const humiditySlot: SpoolHumidityReadingRow = {
    farmId,
    id: '00000000-0000-4000-8000-000000000007',
    spoolId: null,
    printerId,
    slotKind: 'ams',
    slotIndex: 0,
    humidityPercent: 18,
    source: 'ams',
    recordedAt: 1000,
  }

  assert.equal(setting.farmId, farmId)
  assert.equal(field.entityType, 'spool')
  assert.equal(location.name, 'Drybox 1')
  assert.equal(farmSettings.currency, 'EUR')
  assert.equal(filamentLowStock.lowStockThresholdGrams, 200)
  assert.equal(slot.slotKind, 'ams')
  assert.equal(usage.source, 'telemetry')
  assert.equal(drying.temperatureCelsius, 55)
  assert.equal(humiditySpool.source, 'manual')
  assert.equal(humiditySlot.source, 'ams')
})
