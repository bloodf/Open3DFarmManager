function quoted(value: string): string {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Invalid Unicode surrogate')
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new Error('Invalid Unicode surrogate')
  }
  return JSON.stringify(value)
}

// RFC 8785 serialization for JSON data, with local depth/work limits.
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>()
  let visited = 0
  function encode(item: unknown, depth: number): string {
    if (++visited > 10_000 || depth > 64)
      throw new Error('JSON complexity limit exceeded')
    if (item === null) return 'null'
    if (typeof item === 'string') return quoted(item)
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Non-finite JSON number')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') throw new Error('Unsupported JSON value')
    if (ancestors.has(item)) throw new Error('Cyclic JSON value')
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error('Symbol JSON property')
    ancestors.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      for (const descriptor of Object.values(descriptors)) {
        if (descriptor.get || descriptor.set)
          throw new Error('Accessor JSON property')
      }
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length)
          throw new Error('Sparse or extended JSON array')
        return (
          '[' +
          Array.from({ length: item.length }, (_, index) => {
            if (!Object.hasOwn(item, index))
              throw new Error('Sparse JSON array')
            return encode(item[index], depth + 1)
          }).join(',') +
          ']'
        )
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== null && prototype !== Object.prototype)
        throw new Error('Non-JSON object')
      return (
        '{' +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              quoted(key) + ':' + encode(descriptors[key]!.value, depth + 1),
          )
          .join(',') +
        '}'
      )
    } finally {
      ancestors.delete(item)
    }
  }
  return encode(value, 0)
}
