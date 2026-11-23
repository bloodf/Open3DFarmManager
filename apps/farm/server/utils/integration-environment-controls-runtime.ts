import type { EnvironmentControlPorts } from './integration-environment-controls.ts'

/**
 * Storage and envelope ports for environment-control actions. They stay unset
 * until the `environment:control` action and envelope storage is configured;
 * until then a qualified action answers `service-unavailable` and nothing is
 * sent. Readiness and management links never depend on them.
 */
let ports: EnvironmentControlPorts | null = null

export function setIntegrationEnvironmentControlPorts(
  next: EnvironmentControlPorts | null,
) {
  ports = next
}

export function integrationEnvironmentControlPorts() {
  return ports
}
