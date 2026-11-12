import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/runtime/collect.ts') && process.env.QUEUE_RACE_DIR) {
      const source = String(result.source)
      const needle = '  assertUnscopedCollection(directory)'
      if (!source.includes(needle)) throw new Error('Collection hook missing')
      return {
        ...result,
        source: source.replace(
          needle,
          `${needle}
  { const fs = process.getBuiltinModule('fs'); const dir = process.env.QUEUE_RACE_DIR;
    fs.writeFileSync(dir + '/paused', 'ready');
    while (!fs.existsSync(dir + '/resume')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }`,
        ),
      }
    }
    if (url.endsWith('/runtime/agent.ts') && process.env.QUEUE_ADVANCE_DRAIN) {
      const source = String(result.source)
      // Tolerates reformatting; still fails loudly if the drain clock moves.
      const needle = /\(\) => clock\.now\(\),(\s*attemptSignal,)/
      const enqueue = '  const controller = new AbortController()'
      if (!needle.test(source) || !source.includes(enqueue))
        throw new Error('Drain clock hook missing')
      return {
        ...result,
        source: source.replace(needle, '() => Date.now() + 120000,$1').replace(
          enqueue,
          `  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (state, now) => originalEnqueue(state, now + 120000);
${enqueue}`,
        ),
      }
    }
    if (
      url.endsWith('/runtime/agent.ts') &&
      process.env.QUEUE_EXPIRE_ON_DELIVERY
    ) {
      const source = String(result.source)
      const needle = "if (result.status === 'delivered') {"
      if (!source.includes(needle))
        throw new Error('Expire on delivery hook missing')
      return {
        ...result,
        source: source.replace(
          needle,
          `${needle}\n          credential.expires_at = 0`,
        ),
      }
    }
    return result
  },
})
