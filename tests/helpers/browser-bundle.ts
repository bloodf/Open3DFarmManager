import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

// A separate Node process bounds esbuild startup, compilation and output.
export function browserBundle(
  entry: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const require = createRequire(import.meta.url)
  const modulePath = require.resolve('esbuild')
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const { build } = require(process.argv[1]);
        const result = await build({ entryPoints: [process.argv[2]], bundle: true,
          platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
        const output = result.outputFiles[0];
        if (!output || output.contents.byteLength > 1024 * 1024)
          throw Error('Browser bundle output limit');
        process.stdout.write(output.contents);
      `,
        modulePath,
        entry,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error) reject(error)
        else if (!stdout) reject(Error('Empty browser bundle'))
        else resolve(stdout)
      },
    )
  })
}
