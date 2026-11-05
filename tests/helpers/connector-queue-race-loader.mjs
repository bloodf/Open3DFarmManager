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
      const needle = '            Date.now,\n            attemptSignal,'
      const enqueue = '  const controller = new AbortController()'
      if (!source.includes(needle) || !source.includes(enqueue))
        throw new Error('Drain clock hook missing')
      return {
        ...result,
        source: source
          .replace(
            needle,
            '            () => Date.now() + 120000,\n            attemptSignal,',
          )
          .replace(
            enqueue,
            `  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (state, now) => originalEnqueue(state, now + 120000);
${enqueue}`,
          ),
      }
    }
    return result
  },
})
