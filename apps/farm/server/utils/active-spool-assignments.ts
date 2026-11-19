import { createActiveSpoolAssignmentStore } from '../../../../packages/connector/src/spoolman/active-assignments.ts'

export {
  createActiveSpoolAssignmentStore,
  type ActiveSpoolAssignment,
  type ActiveSpoolAssignmentStore,
} from '../../../../packages/connector/src/spoolman/active-assignments.ts'

/** Default on-disk path for farm-local assignment custody in development. */
export function farmActiveSpoolAssignmentsPath(dataDir: string) {
  return `${dataDir.replace(/\/$/, '')}/active-spool-assignments.json`
}

export function openFarmActiveSpoolAssignments(dataDir: string) {
  return createActiveSpoolAssignmentStore(
    farmActiveSpoolAssignmentsPath(dataDir),
  )
}
