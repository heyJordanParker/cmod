import { storeFolder } from '../records.js'
import type { Claude } from './claude.js'

export type Programs = { readonly claude: Claude; refresh(): Promise<void> }

export function locatingPrograms(claude: Claude): Programs {
  let folder: string | undefined
  let names: ReadonlySet<string> = new Set()
  const located = (argv: readonly string[]): readonly string[] => {
    const [name, ...rest] = argv
    return folder !== undefined && name !== undefined && names.has(name) ? [`${folder}/${name}`, ...rest] : argv
  }
  return {
    claude: {
      ...claude,
      process: {
        run: (argv, init) => claude.process.run(located(argv), init),
        spawn: (request) => claude.process.spawn({ ...request, argv: located(request.argv) }),
      },
    },
    async refresh() {
      const [home, dataHome] = await Promise.all([claude.env.home(), claude.env.dataHome()])
      const programs = `${storeFolder({ HOME: home, XDG_DATA_HOME: dataHome })}/programs`
      names = new Set((await claude.fs.list(programs).catch(() => [])).map((entry) => entry.name))
      folder = programs
    },
  }
}
