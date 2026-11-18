// SPDX-License-Identifier: MIT
/**
 * Switch for simulator execution mode.
 * Default is 'mock' (in-process / loopback TypeScript mocks).
 * 'docker' is opt-in for existing docker compose environments.
 */
export type SimMode = 'mock' | 'docker'

export function getSimMode(): SimMode {
  const envVal = process.env.OPENFARM_SIM?.trim().toLowerCase()
  if (envVal === 'docker') {
    return 'docker'
  }
  return 'mock'
}

export function isDockerSim(): boolean {
  return getSimMode() === 'docker'
}

export function isMockSim(): boolean {
  return getSimMode() === 'mock'
}
