declare const Bun: {
  file(path: string): { readonly lastModified: number }
  Glob: new (pattern: string) => { scanSync(options: { readonly cwd: string; readonly onlyFiles: boolean }): Iterable<string> }
}

declare const process: { readonly platform: string; readonly arch: string }

const cli = (import.meta as unknown as { readonly dir: string }).dir.replace(/\/tests$/, '')

const name = `cmod-${process.platform}-${process.arch}`

const path = `${cli}/dist/${name}`

const sources = [`${cli}/src`, `${cli}/../core/src`]

const howToBuild = 'Run the tests through bun run test [<test file>…], in cli/ or at the root, which builds it first.'

const filesIn = (folder: string, pattern = '**/*') => [...new Bun.Glob(pattern).scanSync({ cwd: folder, onlyFiles: true })].map((file) => `${folder}/${file}`)

function currentBinary(): string {
  if (filesIn(`${cli}/dist`, name).length === 0) throw new Error(`${path} is missing. ${howToBuild}`)
  const built = Bun.file(path).lastModified
  const newer = sources.flatMap((folder) => filesIn(folder)).find((file) => Bun.file(file).lastModified > built)
  if (newer !== undefined) throw new Error(`${path} is older than ${newer}. ${howToBuild}`)
  return path
}

export const cmodBinary = currentBinary()
