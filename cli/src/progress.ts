export type Progress = {
  step(heading: string): void
  update(heading: string, done: number, total: number, label: string): void
  log(text: string): void
  succeed(text: string): void
  skip(text: string): void
  fail(text: string): void
  note(text: string): void
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const barWidth = 30
const keptLogLines = 10
let clearSpinner: (() => void) | undefined

export function startProgress(output: NodeJS.WriteStream = process.stdout): Progress {
  return output.isTTY ? terminalProgress(output) : lineProgress(output)
}

export function interruptProgress(): void {
  clearSpinner?.()
}

export function paint(output: NodeJS.WriteStream = process.stdout) {
  const color = output.isTTY && !process.env['NO_COLOR']
  const code = (open: number, close: number) => (text: string) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : text)
  return { bold: code(1, 22), dim: code(2, 22), cyan: code(36, 39), green: code(32, 39), red: code(31, 39) }
}

function bar(done: number, total: number): string {
  const filled = total > 0 ? Math.round((Math.min(done, total) / total) * barWidth) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`
}

function terminalProgress(output: NodeJS.WriteStream): Progress {
  const style = paint(output)
  const logs: string[] = []
  let frame = 0
  let line = (_spinner: string) => ''
  let timer: ReturnType<typeof setInterval> | undefined

  const draw = () => {
    const columns = output.columns || 80
    const text = line(style.cyan(frames[frame % frames.length] ?? ''))
    output.write(`\r\x1b[2K${fit(text, columns - 1)}`)
  }
  const start = () => {
    if (timer) return
    output.write('\x1b[?25l')
    process.once('exit', showCursor)
    clearSpinner = () => stop('')
    timer = setInterval(() => {
      frame += 1
      draw()
    }, 80)
    timer.unref()
  }
  const showCursor = () => output.write('\x1b[?25h')
  const stop = (final: string) => {
    if (timer) clearInterval(timer)
    timer = undefined
    clearSpinner = undefined
    output.write(`\r\x1b[2K${final}${final ? '\n' : ''}`)
    showCursor()
    process.removeListener('exit', showCursor)
  }

  return {
    step(heading) {
      line = (spinner) => `${spinner} ${style.bold(heading)}${style.dim('…')}`
      start()
      draw()
    },
    update(heading, done, total, label) {
      line = (spinner) => `${spinner} ${style.bold(heading)}  ${bar(done, total).replace(/░+$/, (empty) => style.dim(empty))}  ${done}/${total}  ${style.dim(label)}`
      start()
      draw()
    },
    log(text) {
      logs.push(text)
      if (logs.length > keptLogLines) logs.shift()
    },
    succeed(text) {
      stop(`${style.green('✔')} ${text}`)
    },
    skip(text) {
      stop(style.dim(`– ${text}`))
    },
    fail(text) {
      if (timer) output.write('\r\x1b[2K')
      for (const entry of logs) output.write(`  ${style.dim(entry)}\n`)
      stop(`${style.red('✘')} ${text}`)
    },
    note(text) {
      output.write(`  ${style.dim(text)}\n`)
    },
  }
}

function lineProgress(output: NodeJS.WriteStream): Progress {
  let lastStep = ''
  return {
    step(heading) {
      if (heading === lastStep) return
      lastStep = heading
      output.write(`${heading}…\n`)
    },
    update(heading, done, total, label) {
      lastStep = ''
      output.write(`${heading}  ${done}/${total}  ${label}\n`)
    },
    log(text) {
      output.write(`  ${text}\n`)
    },
    succeed(text) {
      output.write(`✔ ${text}\n`)
    },
    skip(text) {
      output.write(`– ${text}\n`)
    },
    fail(text) {
      output.write(`✘ ${text}\n`)
    },
    note(text) {
      output.write(`  ${text}\n`)
    },
  }
}

function fit(text: string, columns: number): string {
  let visible = 0
  let result = ''
  for (const part of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) {
      result += part
      continue
    }
    for (const character of part) {
      if (visible >= columns) return `${result}\x1b[0m`
      result += character
      visible += 1
    }
  }
  return result
}
