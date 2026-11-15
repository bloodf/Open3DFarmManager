import test from 'node:test'

test(
  'real Docker upgrade preserves product data and Connector configuration',
  {
    skip:
      process.env.OPENFARM_DOCKER_REHEARSAL !== '1'
        ? 'Set OPENFARM_DOCKER_REHEARSAL=1 to build and run isolated Docker releases'
        : false,
    timeout: 1_800_000,
  },
  async () => {
    const { realRehearsal } =
      await import('../../scripts/self-host/real-rehearsal.ts')
    await realRehearsal()
  },
)
