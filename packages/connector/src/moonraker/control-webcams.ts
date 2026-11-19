import { parseWebcamsResult } from './discovery-parse.ts'

/** Read through the authenticated detail socket. Camera URLs stay on the Connector. */
export async function listDetailWebcams(
  request: (method: string) => Promise<unknown>,
) {
  return parseWebcamsResult(await request('server.webcams.list'), null).map(
    ({ uid, name, enabled, rotation, flipHorizontal, flipVertical }) => ({
      uid: uid?.toWellFormed() || null,
      name: name.toWellFormed(),
      enabled,
      rotation,
      flipHorizontal,
      flipVertical,
    }),
  )
}
