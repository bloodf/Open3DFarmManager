import { createControlFixture } from './control.ts'
import type { KobraLinkFetch } from '../../../packages/connector/src/kobralink/client.ts'

export function createFilesFixture() {
  const control = createControlFixture()
  const uploads: {
    name: string
    content: string
    print: FormDataEntryValue | null
  }[] = []
  const starts: unknown[] = []
  let listing: unknown = [
    { filename: 'part.gcode', sizeBytes: 4, timestamp: 123 },
  ]
  const fetch: KobraLinkFetch = async (url, init) => {
    const path = new URL(url).pathname
    if (
      new Headers(init.headers).get('cookie') ===
      'better-auth.session_token=synthetic-control-token'
    ) {
      if (path.endsWith('/files') && init.method === 'GET')
        return Response.json([
          { id: 'file-1', filename: 'part.gcode', sizeBytes: 4 },
        ])
      if (
        path.endsWith('/print') &&
        !path.endsWith('/printer-files/print') &&
        init.method === 'POST'
      ) {
        starts.push(JSON.parse(String(init.body)))
        return Response.json({})
      }
      if (path.endsWith('/printer-files') && init.method === 'GET')
        return Response.json(listing)
      if (
        path.endsWith('/files') &&
        init.method === 'POST' &&
        init.body instanceof FormData
      ) {
        const file = init.body.get('file')
        if (!(file instanceof File)) return new Response(null, { status: 400 })
        uploads.push({
          name: file.name,
          content: await file.text(),
          print: init.body.get('print'),
        })
        return Response.json({ id: 'file-1' })
      }
    }
    return control.fetch(url, init)
  }
  return {
    ...control,
    fetch,
    uploads,
    starts,
    setListing(value: unknown) {
      listing = value
    },
  }
}
