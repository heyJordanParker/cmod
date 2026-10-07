import { basename, parse, type GlobPattern, type ParseEntry } from '../vendor.js'

export type ShellCommand = { argv: [string, ...string[]]; folder: string }

export type ParsedShell = {
  commands: ShellCommand[]
  writes: string[]
  reads: string[]
  fetches: string[]
  isFullyParsed: boolean
}

type Word = { text: string; isGlob: boolean; isDynamic: boolean }
type Marker = { raw: string; code: string[] }
type Expansion = Marker & { end: number }
type Heredoc = { delimiter: string; stripsTabs: boolean; isQuoted: boolean; marker: Marker; end: number }
type Scan = { text: string; markers: Marker[]; end: number }
type Redirect = { operator: string; target: Word }
type Command = { words: Word[]; redirects: Redirect[]; isPipedIn: boolean }
type Stdin = { kind: 'text'; text: string } | { kind: 'pipe' }
type Access = 'reads' | 'writes'
type OptionSpec = { valued?: string; optional?: string; longValued?: readonly string[] }
type Option = { name: string; value: Word | undefined }
type FileProgram = OptionSpec & { scriptOptions?: readonly string[]; takesAssignments?: true; inPlaceOptions?: readonly string[] }
type CopyProgram = OptionSpec & { sources: 'reads' | 'writes' | undefined; targetOptions?: readonly string[]; linksHere?: true; skipsRemote?: true }
type Wrapper = OptionSpec & {
  stops?: readonly string[]
  folderOptions?: readonly string[]
  codeOptions?: readonly string[]
  shellUnless?: readonly string[]
  takesAssignments?: true
  leadingOperands?: number
}

const markerPattern = /\u0001(\d+)\u0001/g
const descriptorPattern = /[0-9]+(?=[<>])/y
const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
export const dynamicPattern = /[$`]/
const homePrefix = /^\$HOME(?=\/|$)/
const clusterPattern = /^-[A-Za-z0-9]{2,}$/
const separators = ';&|()<>'
const redirectOperators = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<', '<>', '<&', '<<<'])
const writeRedirects = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
const sequenceOperators = new Set([';', '&', '&&', '||', '|', '|&'])
const casePatternStarts = new Set([';;', ';&', ';;&'])
const reservedWords = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '{', '}', '!'])
const shells = new Set(['sh', 'bash', 'zsh'])
const findActions = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const gitValuedOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source'])
const nonGetoptPrograms = new Set([
  'find', 'java', 'javac', 'go', 'gcc', 'g++', 'clang', 'clang++', 'swift', 'swiftc',
  'xcodebuild', 'xcrun', 'ffmpeg', 'ffprobe', 'openssl', 'plutil', 'defaults', 'security', 'codesign',
])

const grep: FileProgram = {
  valued: 'efmABCdD',
  longValued: ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--directories', '--devices', '--binary-files', '--label', '--include', '--exclude', '--exclude-dir', '--exclude-from'],
  scriptOptions: ['-e', '-f', '--regexp', '--file'],
}
const awk: FileProgram = {
  valued: 'fFvi',
  longValued: ['--file', '--field-separator', '--assign', '--include', '--source'],
  scriptOptions: ['-f', '--file', '--source'],
  takesAssignments: true,
  inPlaceOptions: ['-i', '--include'],
}
const sed: FileProgram = {
  valued: 'efl',
  optional: 'iI',
  longValued: ['--expression', '--file', '--line-length'],
  scriptOptions: ['-e', '-f', '--expression', '--file'],
  inPlaceOptions: ['-i', '-I', '--in-place'],
}
const perl: FileProgram = {
  valued: 'eEIMmF',
  optional: 'ixdDC',
  scriptOptions: ['-e', '-E'],
  inPlaceOptions: ['-i'],
}
const fileWriters = new Map<string, OptionSpec>([
  ['tee', {}],
  ['rm', {}],
  ['touch', { valued: 'drt', longValued: ['--date', '--reference', '--time'] }],
  ['truncate', { valued: 'sr', longValued: ['--size', '--reference'] }],
])
const copyTarget = { valued: 'tS', longValued: ['--target-directory', '--suffix'], targetOptions: ['-t', '--target-directory'] }
const copyPrograms = new Map<string, CopyProgram>([
  ['cp', { ...copyTarget, sources: 'reads' }],
  ['mv', { ...copyTarget, sources: 'writes' }],
  ['ln', { ...copyTarget, sources: undefined, linksHere: true }],
  ['rsync', {
    valued: 'efBTM',
    longValued: [
      '--rsh', '--rsync-path', '--filter', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from',
      '--temp-dir', '--compare-dest', '--copy-dest', '--link-dest', '--backup-dir', '--suffix', '--chmod', '--chown',
      '--usermap', '--groupmap', '--timeout', '--contimeout', '--bwlimit', '--log-file', '--log-file-format', '--out-format',
      '--password-file', '--port', '--sockopts', '--max-size', '--min-size', '--max-delete', '--partial-dir', '--block-size',
      '--modify-window', '--iconv', '--checksum-choice', '--compress-choice', '--compress-level', '--remote-option',
      '--info', '--debug', '--address', '--write-batch', '--only-write-batch', '--read-batch', '--protocol', '--skip-compress',
    ],
    sources: 'reads',
    skipsRemote: true,
  }],
])
const fetchers = new Map<string, OptionSpec>([
  ['curl', {
    valued: 'AbcCdDeEFHKmoPQrTtuUwxXyYz',
    longValued: [
      '--url', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string',
      '--header', '--proxy-header', '--user', '--user-agent', '--referer', '--output', '--output-dir', '--cookie', '--cookie-jar',
      '--request', '--proxy', '--proxy-user', '--preproxy', '--noproxy', '--max-time', '--connect-timeout', '--retry',
      '--retry-delay', '--retry-max-time', '--range', '--continue-at', '--upload-file', '--write-out', '--cert', '--cert-type',
      '--key', '--key-type', '--cacert', '--capath', '--ciphers', '--config', '--dump-header', '--interface', '--limit-rate',
      '--max-filesize', '--max-redirs', '--resolve', '--connect-to', '--oauth2-bearer', '--aws-sigv4', '--unix-socket',
      '--abstract-unix-socket', '--variable', '--url-query', '--trace', '--trace-ascii', '--stderr', '--keepalive-time',
      '--local-port', '--dns-servers', '--doh-url', '--quote', '--telnet-option', '--time-cond', '--speed-limit', '--speed-time',
      '--etag-save', '--etag-compare', '--hsts', '--alt-svc', '--mail-from', '--mail-rcpt', '--mail-auth', '--pass', '--proto',
      '--proto-redir', '--pubkey', '--socks4', '--socks4a', '--socks5', '--socks5-hostname',
    ],
  }],
  ['wget', {
    valued: 'aoeiBtOTwQPlARDIXU',
    longValued: [
      '--output-file', '--append-output', '--execute', '--input-file', '--base', '--tries', '--output-document', '--timeout',
      '--dns-timeout', '--connect-timeout', '--read-timeout', '--wait', '--waitretry', '--quota', '--limit-rate',
      '--directory-prefix', '--level', '--accept', '--reject', '--domains', '--exclude-domains', '--include-directories',
      '--exclude-directories', '--user-agent', '--header', '--user', '--password', '--http-user', '--http-password',
      '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--referer', '--load-cookies', '--save-cookies',
      '--certificate', '--private-key', '--ca-certificate', '--ca-directory', '--bind-address', '--cut-dirs', '--default-page',
      '--restrict-file-names', '--local-encoding', '--remote-encoding',
    ],
  }],
])
const su: OptionSpec = { valued: 'cgGsw', longValued: ['--command', '--session-command', '--group', '--supp-group', '--shell', '--whitelist-environment'] }
const suCodeOptions: readonly string[] = ['-c', '--command', '--session-command']
const fileReaders = new Map<string, FileProgram>([
  ['cat', {}],
  ['head', { valued: 'nc', longValued: ['--lines', '--bytes'] }],
  ['tail', { valued: 'ncbs', longValued: ['--lines', '--bytes', '--pid', '--sleep-interval', '--max-unchanged-stats'] }],
  ['less', { valued: 'bhjkoOpPtTxyz' }],
  ['grep', grep],
  ['egrep', grep],
  ['fgrep', grep],
  ['rg', {
    valued: 'efgtTmABCjMrEd',
    longValued: ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--max-count', '--after-context', '--before-context', '--context', '--threads', '--max-columns', '--replace', '--encoding', '--max-depth', '--max-filesize', '--sort', '--sortr', '--pre', '--pre-glob', '--engine', '--ignore-file', '--path-separator', '--context-separator', '--field-match-separator', '--field-context-separator'],
    scriptOptions: ['-e', '-f', '--regexp', '--file'],
  }],
  ['awk', awk],
  ['gawk', awk],
  ['sed', sed],
  ['gsed', sed],
])
const wrappers = new Map<string, Wrapper>([
  ['sudo', {
    valued: 'CDghpRrTtUu',
    longValued: ['--close-from', '--chdir', '--group', '--host', '--prompt', '--chroot', '--role', '--type', '--command-timeout', '--other-user', '--user'],
    stops: ['-e', '--edit', '-l', '--list', '-v', '--validate', '-V', '--version', '-K', '--remove-timestamp'],
    folderOptions: ['-D', '--chdir'],
    takesAssignments: true,
  }],
  ['env', {
    valued: 'aCPSu',
    longValued: ['--argv0', '--chdir', '--split-string', '--unset'],
    folderOptions: ['-C', '--chdir'],
    codeOptions: ['-S', '--split-string'],
    takesAssignments: true,
  }],
  ['doas', { valued: 'aCu', stops: ['-C', '-L'] }],
  ['timeout', { valued: 'ks', longValued: ['--kill-after', '--signal'], leadingOperands: 1 }],
  ['flock', { valued: 'wEc', longValued: ['--timeout', '--wait', '--conflict-exit-code', '--command'], codeOptions: ['-c', '--command'], leadingOperands: 1 }],
  ['stdbuf', { valued: 'ioe', longValued: ['--input', '--output', '--error'] }],
  ['watch', { valued: 'nq', optional: 'd', longValued: ['--interval', '--equexit'], shellUnless: ['-x', '--exec'] }],
  ['nohup', {}],
  ['nice', { valued: 'n', longValued: ['--adjustment'] }],
  ['time', { valued: 'fo', longValued: ['--format', '--output'] }],
  ['exec', { valued: 'a' }],
  ['command', { stops: ['-v', '-V'] }],
  ['xargs', {
    valued: 'aEdILnPs',
    optional: 'eil',
    longValued: ['--arg-file', '--delimiter', '--max-args', '--max-chars', '--max-procs', '--process-slot-var'],
  }],
])
const inlineCodeFlags = new Map<string, readonly string[]>([
  ['python', ['-c']],
  ['python2', ['-c']],
  ['python3', ['-c']],
  ['node', ['-e', '--eval', '-p', '--print']],
  ['bun', ['-e', '--eval', '-p', '--print']],
  ['deno', ['eval']],
  ['ruby', ['-e']],
  ['perl', ['-e', '-E']],
  ['php', ['-r']],
  ['lua', ['-e']],
  ['osascript', ['-e']],
])

export function parseShell(line: string): ParsedShell {
  const result: ParsedShell = { commands: [], writes: [], reads: [], fetches: [], isFullyParsed: true }
  parseLine(line, '', result)
  return result
}

function parseLine(line: string, folder: string, result: ParsedShell): void {
  if (line.includes('\u0001')) {
    result.isFullyParsed = false
    return
  }
  try {
    const { text, markers } = scan(line, 0, false)
    walk(parse(text, (name) => (name === '' ? undefined : `$${name}`)), markers, folder, result)
  } catch {
    result.isFullyParsed = false
  }
}

function scan(source: string, start: number, isNested: boolean): Scan {
  const markers: Marker[] = []
  const heredocs: Heredoc[] = []
  const mark = (marker: Marker) => `\u0001${markers.push(marker) - 1}\u0001`
  let text = ''
  let depth = 0
  let cases = 0
  let index = start
  let isWordStart = true
  while (index < source.length) {
    const char = source.charAt(index)
    const next = source.charAt(index + 1)
    if (char === '\n') {
      text += ' ; '
      index = readHeredocBodies(source, index + 1, heredocs.splice(0))
      isWordStart = true
      continue
    }
    if (char === ' ' || char === '\t') {
      text += char
      index += 1
      isWordStart = true
      continue
    }
    if (char === '#') {
      if (isWordStart) index = lineEnd(source, index)
      else {
        text += '\\#'
        index += 1
      }
      continue
    }
    if (char === '\\') {
      if (next === '') throw new SyntaxError('The line ends with a backslash.')
      if (next !== '\n') {
        text += char + next
        isWordStart = false
      }
      index += 2
      continue
    }
    if (char === "'" || (char === '$' && next === "'")) {
      const close = closingQuote(source, index + (char === '$' ? 2 : 1), "'", char === '$')
      text += source.slice(index, close + 1)
      index = close + 1
      isWordStart = false
      continue
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(source, index, mark)
      text += quoted.text
      index = quoted.end
      isWordStart = false
      continue
    }
    const expansion = expansionAt(source, index)
    if (expansion !== undefined) {
      text += mark(expansion)
      index = expansion.end
      isWordStart = false
      continue
    }
    if ((char === '<' || char === '>') && next === '(') {
      const close = scan(source, index + 2, true).end
      text += mark({ raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)] })
      index = close + 1
      isWordStart = false
      continue
    }
    if (char === '(' && next === '(' && isWordStart) {
      const end = arithmeticEnd(source, index + 2)
      if (end !== undefined) {
        if (substitutionsIn(source.slice(index + 2, end - 2)).length > 0) throw new SyntaxError('An arithmetic command runs a substitution.')
        index = end
        continue
      }
    }
    if (source.startsWith('<<<', index)) {
      text += '<<<'
      index += 3
      isWordStart = true
      continue
    }
    if (char === '<' && next === '<') {
      const heredoc = readHeredocOperator(source, index)
      heredocs.push(heredoc)
      text += ` <<< ${mark(heredoc.marker)} `
      index = heredoc.end
      isWordStart = true
      continue
    }
    if (isWordStart) {
      descriptorPattern.lastIndex = index
      const descriptor = descriptorPattern.exec(source)
      if (descriptor !== null) {
        index += descriptor[0].length
        continue
      }
      if (startsWord(source, index, 'case')) cases += 1
      if (startsWord(source, index, 'esac') && cases > 0) cases -= 1
    }
    if (char === '(') depth += 1
    if (char === ')') {
      if (depth > 0) depth -= 1
      else if (cases === 0) {
        if (!isNested) throw new SyntaxError('The line closes a parenthesis it never opened.')
        if (heredocs.length > 0) throw new SyntaxError('A heredoc inside a substitution has no body.')
        return { text, markers, end: index }
      }
    }
    text += char
    index += 1
    isWordStart = separators.includes(char)
  }
  if (isNested) throw new SyntaxError('A substitution is never closed.')
  if (depth > 0) throw new SyntaxError('A parenthesis is never closed.')
  if (heredocs.length > 0) throw new SyntaxError('A heredoc has no body.')
  return { text, markers, end: index }
}

function readDoubleQuoted(source: string, start: number, mark: (marker: Marker) => string): { text: string; end: number } {
  let text = '"'
  let index = start + 1
  while (index < source.length) {
    const char = source.charAt(index)
    if (char === '"') return { text: `${text}"`, end: index + 1 }
    if (char === '\\') {
      if (source.charAt(index + 1) !== '\n') text += source.slice(index, index + 2)
      index += 2
      continue
    }
    const expansion = expansionAt(source, index)
    if (expansion !== undefined) {
      text += mark(expansion)
      index = expansion.end
      continue
    }
    text += char
    index += 1
  }
  throw new SyntaxError('A double quote is never closed.')
}

function expansionAt(source: string, index: number): Expansion | undefined {
  if (source.startsWith('$((', index)) {
    const end = arithmeticEnd(source, index + 3)
    if (end !== undefined) return { raw: source.slice(index, end), code: substitutionsIn(source.slice(index + 3, end - 2)), end }
  }
  if (source.startsWith('$(', index)) {
    const close = scan(source, index + 2, true).end
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)], end: close + 1 }
  }
  if (source.charAt(index) === '`') {
    const close = closingQuote(source, index + 1, '`', true)
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 1, close).replace(/\\([\\`$])/g, '$1')], end: close + 1 }
  }
  return undefined
}

function substitutionsIn(text: string): string[] {
  const code: string[] = []
  let index = 0
  while (index < text.length) {
    if (text.charAt(index) === '\\') {
      index += 2
      continue
    }
    const expansion = expansionAt(text, index)
    if (expansion === undefined) index += 1
    else {
      code.push(...expansion.code)
      index = expansion.end
    }
  }
  return code
}

function arithmeticEnd(source: string, from: number): number | undefined {
  let depth = 0
  for (let index = from; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (char === '(') depth += 1
    if (char !== ')') continue
    if (depth > 0) depth -= 1
    else return source.charAt(index + 1) === ')' ? index + 2 : undefined
  }
  throw new SyntaxError('An arithmetic expansion is never closed.')
}

function closingQuote(source: string, from: number, quote: string, isEscapable: boolean): number {
  for (let index = from; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (isEscapable && char === '\\') index += 1
    else if (char === quote) return index
  }
  throw new SyntaxError(`A ${quote} quote is never closed.`)
}

function lineEnd(source: string, index: number): number {
  const end = source.indexOf('\n', index)
  return end < 0 ? source.length : end
}

function startsWord(source: string, index: number, word: string): boolean {
  return source.startsWith(word, index) && /^$|[\s;&|()<>]/.test(source.charAt(index + word.length))
}

function readHeredocOperator(source: string, index: number): Heredoc {
  let end = index + 2
  const stripsTabs = source.charAt(end) === '-'
  if (stripsTabs) end += 1
  while (source.charAt(end) === ' ' || source.charAt(end) === '\t') end += 1
  let delimiter = ''
  let isQuoted = false
  while (end < source.length && !/[\s;&|()<>]/.test(source.charAt(end))) {
    const char = source.charAt(end)
    if (char === "'" || char === '"') {
      const close = closingQuote(source, end + 1, char, char === '"')
      delimiter += source.slice(end + 1, close)
      isQuoted = true
      end = close + 1
    } else if (char === '\\') {
      delimiter += source.charAt(end + 1)
      isQuoted = true
      end += 2
    } else {
      delimiter += char
      end += 1
    }
  }
  if (delimiter === '') throw new SyntaxError('A heredoc has no delimiter.')
  return { delimiter, stripsTabs, isQuoted, marker: { raw: '', code: [] }, end }
}

function readHeredocBodies(source: string, from: number, heredocs: Heredoc[]): number {
  let index = from
  for (const heredoc of heredocs) {
    const lines: string[] = []
    for (;;) {
      if (index >= source.length) throw new SyntaxError(`The heredoc ${heredoc.delimiter} never ends.`)
      const end = lineEnd(source, index)
      const line = heredoc.stripsTabs ? source.slice(index, end).replace(/^\t+/, '') : source.slice(index, end)
      index = end + 1
      if (line === heredoc.delimiter) break
      lines.push(line)
    }
    heredoc.marker.raw = lines.join('\n')
    heredoc.marker.code = heredoc.isQuoted ? [] : substitutionsIn(heredoc.marker.raw)
  }
  return index
}

function walk(tokens: ParseEntry[], markers: Marker[], start: string, result: ParsedShell): void {
  let folder = start
  const subshells: string[] = []
  let command = newCommand(false)
  let caseState: 'header' | 'pattern' | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (typeof token !== 'string' && 'comment' in token) throw new SyntaxError('The line holds a comment the scanner left.')
    if (isWordToken(token)) {
      const word = wordOf(token, markers, folder, result)
      if (caseState === 'header') {
        if (word.text === 'in') caseState = 'pattern'
      } else if (caseState === 'pattern') {
        if (word.text === 'esac') caseState = undefined
      } else if (word.text === 'case' && command.words.every((earlier) => reservedWords.has(earlier.text))) {
        caseState = 'header'
      } else command.words.push(word)
      continue
    }
    const operator = token.op
    if (redirectOperators.has(operator)) {
      const target = tokens[index + 1]
      if (target === undefined || !isWordToken(target)) throw new SyntaxError(`The redirection ${operator} has no target.`)
      index += 1
      command.redirects.push({ operator, target: wordOf(target, markers, folder, result) })
      continue
    }
    if (caseState !== undefined) {
      if (caseState === 'pattern' && operator === ')') caseState = undefined
      continue
    }
    const following = tokens[index + 1]
    if (operator === '(' && command.words.length === 1 && following !== undefined && !isWordToken(following) && 'op' in following && following.op === ')') {
      command = newCommand(false)
      index += 1
      continue
    }
    folder = finish(command, operator, folder, result)
    command = newCommand(operator === '|' || operator === '|&')
    if (operator === '(') subshells.push(folder)
    else if (operator === ')') {
      const outer = subshells.pop()
      if (outer === undefined) throw new SyntaxError('The line closes a subshell it never opened.')
      folder = outer
    } else if (casePatternStarts.has(operator)) caseState = 'pattern'
    else if (!sequenceOperators.has(operator)) throw new SyntaxError(`The parser does not know the operator ${operator}.`)
  }
  finish(command, ';', folder, result)
}

function newCommand(isPipedIn: boolean): Command {
  return { words: [], redirects: [], isPipedIn }
}

function isWordToken(token: ParseEntry): token is string | GlobPattern {
  return typeof token === 'string' || ('op' in token && token.op === 'glob')
}

function wordOf(token: string | GlobPattern, markers: Marker[], folder: string, result: ParsedShell): Word {
  const raw = typeof token === 'string' ? token : token.pattern
  for (const match of raw.matchAll(markerPattern)) {
    for (const code of markers[Number(match[1])]!.code) parseLine(code, folder, result)
  }
  return {
    text: raw.replace(markerPattern, (_, index: string) => markers[Number(index)]!.raw),
    isGlob: typeof token !== 'string',
    isDynamic: /[$\u0001]/.test(basename(raw)),
  }
}

function finish(command: Command, operator: string, folder: string, result: ParsedShell): string {
  for (const redirect of command.redirects) addRedirect(redirect, folder, result)
  const words = withoutPrefixes(command.words)
  const [first, ...args] = words
  if (first === undefined || first.text === 'for' || first.text === 'select') return folder
  const here = command.redirects.findLast((redirect) => redirect.operator === '<<<')
  const stdin: Stdin | undefined = here !== undefined ? { kind: 'text', text: here.target.text } : command.isPipedIn ? { kind: 'pipe' } : undefined
  const changed = addCommand(first, args, folder, stdin, result)
  const isPiped = command.isPipedIn || operator === '|' || operator === '|&' || operator === '&'
  return changed === undefined || isPiped ? folder : changed
}

function withoutPrefixes(words: Word[]): Word[] {
  let start = 0
  for (;;) {
    const text = words[start]?.text
    if (text === undefined) break
    if (text === 'function') start += 2
    else if (reservedWords.has(text) || assignmentPattern.test(text)) start += 1
    else break
  }
  return words.slice(start)
}

function addRedirect({ operator, target }: Redirect, folder: string, result: ParsedShell): void {
  if (operator === '<' || operator === '<>') addPath(result, 'reads', target, folder)
  if (writeRedirects.has(operator) || (operator === '>&' && !/^([0-9]+|-)$/.test(target.text))) addPath(result, 'writes', target, folder)
}

function addCommand(first: Word, args: Word[], folder: string, stdin: Stdin | undefined, result: ParsedShell): string | undefined {
  if (first.isDynamic || first.isGlob) result.isFullyParsed = false
  const program = basename(first.text)
  if (program === 'git') addGit(first, args, folder, result)
  else if (program === 'find') addFind(first, args, folder, result)
  else if (wrappers.has(program)) addWrapper(first, program, args, folder, stdin, result)
  else {
    const flags = expandFlags(program, args)
    result.commands.push({ argv: [first.text, ...flags], folder })
    addEffects(program, args, flags, folder, stdin, result)
    if (program === 'cd') return changedFolder(args, folder)
  }
  return undefined
}

function addGit(first: Word, args: Word[], folder: string, result: ParsedShell): void {
  let index = 0
  let gitFolder = folder
  for (let text = args[0]?.text; text?.startsWith('-') === true; text = args[index]?.text) {
    if (text === '-C') gitFolder = joinFolder(gitFolder, args[index + 1]?.text ?? '')
    if (text === '-c' && /^alias\.[^=]*=\s*!/i.test(args[index + 1]?.text ?? '')) result.isFullyParsed = false
    index += gitValuedOptions.has(text) ? 2 : 1
  }
  result.commands.push({ argv: [first.text, ...expandFlags('git', args.slice(index))], folder: gitFolder })
}

function addFind(first: Word, args: Word[], folder: string, result: ParsedShell): void {
  const own: string[] = []
  const actions: Word[][] = []
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text
    if (!findActions.has(text)) {
      own.push(text)
      continue
    }
    const end = args.findIndex((word, at) => at > index && (word.text === ';' || word.text === '+'))
    actions.push(args.slice(index + 1, end < 0 ? args.length : end))
    index = end < 0 ? args.length : end
  }
  result.commands.push({ argv: [first.text, ...own], folder })
  if (own.includes('-delete')) for (const start of findStarts(args)) addPath(result, 'writes', start, folder)
  for (const [actionFirst, ...actionArgs] of actions) {
    if (actionFirst !== undefined) addCommand(actionFirst, actionArgs, folder, undefined, result)
  }
}

function findStarts(args: Word[]): Word[] {
  let index = 0
  for (let text = args[0]?.text; text === '-D' || /^-([HLP]|O\d*)$/.test(text ?? ''); text = args[index]?.text) index += text === '-D' ? 2 : 1
  const end = args.findIndex((word, at) => at >= index && /^[-(!),]/.test(word.text))
  const starts = args.slice(index, end < 0 ? args.length : end)
  return starts.length > 0 ? starts : [literal('.')]
}

function addWrapper(first: Word, program: string, args: Word[], folder: string, stdin: Stdin | undefined, result: ParsedShell): void {
  const wrapper = wrappers.get(program)!
  if (program === 'xargs' && stdin?.kind !== 'text') result.isFullyParsed = false
  const { options, operands } = readArguments(args, wrapper, true)
  let start = args.length - operands.length
  if (options.some((option) => wrapper.stops?.includes(option.name) === true)) start = args.length
  start += wrapper.leadingOperands ?? 0
  while (wrapper.takesAssignments === true && assignmentPattern.test(args[start]?.text ?? '')) start += 1
  const hasTrailingCode = wrapper.codeOptions?.includes(args[start]?.text ?? '') === true
  result.commands.push({ argv: [first.text, ...expandFlags(program, args.slice(0, start))], folder })
  const innerFolder = options.findLast((option) => wrapper.folderOptions?.includes(option.name) === true)?.value
  const wrappedFolder = innerFolder === undefined ? folder : joinFolder(folder, innerFolder.text)
  const code = hasTrailingCode ? args[start + 1] : options.findLast((option) => wrapper.codeOptions?.includes(option.name) === true)?.value
  const rest = args.slice(hasTrailingCode ? start + 2 : start)
  const isShell = wrapper.shellUnless !== undefined && !options.some((option) => wrapper.shellUnless?.includes(option.name) === true)
  if (code !== undefined || isShell) {
    parseLine([...(code === undefined ? [] : [code]), ...rest].map((word) => word.text).join(' '), wrappedFolder, result)
    return
  }
  const [innerFirst, ...innerArgs] = rest
  if (innerFirst !== undefined) addCommand(innerFirst, innerArgs, wrappedFolder, stdin, result)
}

function addEffects(program: string, args: Word[], flags: string[], folder: string, stdin: Stdin | undefined, result: ParsedShell): void {
  const fileProgram = fileReaders.get(program)
  const fileWriter = fileWriters.get(program)
  const copyProgram = copyPrograms.get(program)
  const fetcher = fetchers.get(program)
  const inlineFlags = inlineCodeFlags.get(program)
  if (program === 'eval') result.isFullyParsed = false
  else if (shells.has(program)) addShell(args, folder, stdin, result)
  else if (program === 'ssh') addSsh(args, stdin, result)
  else if (program === 'su') addSu(args, folder, result)
  else if (program === 'source' || program === '.') addPath(result, 'reads', readArguments(args, {}, true).operands[0], folder)
  else if (program === 'dd') for (const word of args.filter((arg) => arg.text.startsWith('of='))) addPath(result, 'writes', { ...word, text: word.text.slice(3) }, folder)
  else if (fileWriter !== undefined) for (const operand of readArguments(args, fileWriter, false).operands) addPath(result, 'writes', operand, folder)
  else if (copyProgram !== undefined) addCopy(copyProgram, args, folder, result)
  else if (fileProgram !== undefined) addFileArguments(fileProgram, args, folder, result)
  else if (fetcher !== undefined) addFetches(fetcher, args, result)
  else if (inlineFlags !== undefined) {
    if (program === 'perl' && readArguments(args, perl, false).options.some((option) => option.name === '-i')) addFileArguments(perl, args, folder, result)
    const script = args.find((word) => !word.text.startsWith('-') || word.text === '-')
    const readsCodeFromPipe = stdin?.kind === 'pipe' && (script === undefined || script.text === '-')
    if (flags.some((flag) => inlineFlags.includes(flag)) || stdin?.kind === 'text' || readsCodeFromPipe) result.isFullyParsed = false
  }
}

function addShell(args: Word[], folder: string, stdin: Stdin | undefined, result: ParsedShell): void {
  const { options, operands } = readArguments(args, { valued: 'oO', longValued: ['--rcfile', '--init-file'] }, true)
  const script = operands[0]
  if (options.some((option) => option.name === '-c')) {
    if (script !== undefined) parseLine(script.text, folder, result)
  } else if (script === undefined || options.some((option) => option.name === '-s')) addStdinCode(stdin, folder, result)
}

function addSsh(args: Word[], stdin: Stdin | undefined, result: ParsedShell): void {
  const { operands } = readArguments(args, { valued: 'BbcDEeFIiJLlmOoPpQRSWw' }, true)
  const remote = operands.slice(1)
  if (remote.length > 0) parseLine(remote.map((word) => word.text).join(' '), '~', result)
  else if (operands.length > 0) addStdinCode(stdin, '~', result)
}

function addSu(args: Word[], folder: string, result: ParsedShell): void {
  const code = readArguments(args, su, false).options.findLast((option) => suCodeOptions.includes(option.name))?.value
  if (code !== undefined) parseLine(code.text, folder, result)
}

function addFetches(fetcher: OptionSpec, args: Word[], result: ParsedShell): void {
  const { options, operands } = readArguments(args, fetcher, false)
  const urls = [...options.filter((option) => option.name === '--url').flatMap((option) => (option.value === undefined ? [] : [option.value])), ...operands]
  for (const url of urls) result.fetches.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.text) ? url.text : `http://${url.text}`)
}

function addStdinCode(stdin: Stdin | undefined, folder: string, result: ParsedShell): void {
  if (stdin?.kind === 'text') parseLine(stdin.text, folder, result)
  if (stdin?.kind === 'pipe') result.isFullyParsed = false
}

function addCopy(program: CopyProgram, args: Word[], folder: string, result: ParsedShell): void {
  const { options, operands } = readArguments(args, program, false)
  const target = options.findLast((option) => program.targetOptions?.includes(option.name) === true)?.value
  const only = operands[0]
  if (program.linksHere === true && target === undefined && operands.length === 1 && only !== undefined) {
    addPath(result, 'writes', { ...only, text: basename(only.text) }, folder)
    return
  }
  const destination = target ?? operands.at(-1)
  const sources = target === undefined ? operands.slice(0, -1) : operands
  if (destination === undefined || sources.length === 0) return
  const isLocal = (word: Word) => program.skipsRemote !== true || !/^[^/]*:/.test(word.text)
  for (const source of sources.filter(isLocal)) {
    if (program.sources !== undefined) addPath(result, program.sources, source, folder)
    if (isLocal(destination) && !source.isGlob && !destination.isGlob) addPathText(result, 'writes', `${destination.text.replace(/\/+$/, '')}/${basename(source.text)}`, folder)
  }
  if (isLocal(destination)) addPath(result, 'writes', destination, folder)
}

function addFileArguments(program: FileProgram, args: Word[], folder: string, result: ParsedShell): void {
  const { options, operands } = readArguments(args, program, false)
  const inPlace = options.find((option) => program.inPlaceOptions?.includes(option.name) === true && (program !== awk || option.value?.text === 'inplace'))
  let files = operands
  if (program === sed && inPlace !== undefined && inPlace.value === undefined) {
    const suffix = files[0]?.text
    const hasScriptOption = options.some((option) => program.scriptOptions?.includes(option.name) === true)
    if (suffix === '' || (!hasScriptOption && suffix !== undefined && /^\.[\w.-]*$/.test(suffix))) files = files.slice(1)
  }
  if (program.scriptOptions !== undefined && !options.some((option) => program.scriptOptions?.includes(option.name) === true)) files = files.slice(1)
  if (program.takesAssignments === true) files = files.filter((file) => !assignmentPattern.test(file.text))
  for (const file of files) addPath(result, inPlace === undefined ? 'reads' : 'writes', file, folder)
}

function readArguments(args: Word[], spec: OptionSpec, stopsAtOperand: boolean): { options: Option[]; operands: Word[] } {
  const options: Option[] = []
  const operands: Word[] = []
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!
    const text = word.text
    if (text === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (word.isGlob || text === '-' || !text.startsWith('-')) {
      if (stopsAtOperand) {
        operands.push(...args.slice(index))
        break
      }
      operands.push(word)
      continue
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=')
      if (equals >= 0) options.push({ name: text.slice(0, equals), value: literal(text.slice(equals + 1)) })
      else if (spec.longValued?.includes(text) === true) {
        options.push({ name: text, value: args[index + 1] })
        index += 1
      } else options.push({ name: text, value: undefined })
      continue
    }
    for (let at = 1; at < text.length; at += 1) {
      const letter = text.charAt(at)
      const rest = text.slice(at + 1)
      if (spec.optional?.includes(letter) === true) {
        options.push({ name: `-${letter}`, value: rest === '' ? undefined : literal(rest) })
        break
      }
      if (spec.valued?.includes(letter) === true) {
        if (rest !== '') options.push({ name: `-${letter}`, value: literal(rest) })
        else {
          options.push({ name: `-${letter}`, value: args[index + 1] })
          index += 1
        }
        break
      }
      options.push({ name: `-${letter}`, value: undefined })
    }
  }
  return { options, operands }
}

function expandFlags(program: string, args: Word[]): string[] {
  const texts = args.map((word) => word.text)
  if (nonGetoptPrograms.has(program)) return texts
  const spec: OptionSpec | undefined = fileReaders.get(program) ?? wrappers.get(program)
  const takesValue = `${spec?.valued ?? ''}${spec?.optional ?? ''}`
  const end = texts.indexOf('--')
  return texts.flatMap((text, index) => ((end >= 0 && index > end) || !clusterPattern.test(text) ? [text] : expandCluster(text, takesValue)))
}

function expandCluster(cluster: string, takesValue: string): string[] {
  const flags: string[] = []
  for (let index = 1; index < cluster.length; index += 1) {
    const letter = cluster.charAt(index)
    if (takesValue.includes(letter) && index < cluster.length - 1) return [...flags, `-${cluster.slice(index)}`]
    flags.push(`-${letter}`)
  }
  return flags
}

function changedFolder(args: Word[], folder: string): string {
  const target = args.find((word) => !word.text.startsWith('-') || word.text === '-')
  if (target === undefined) return '~'
  return joinFolder(folder, target.text === '-' ? '$OLDPWD' : target.text)
}

function addPath(result: ParsedShell, access: Access, word: Word | undefined, folder: string): void {
  if (word !== undefined && !word.isGlob) addPathText(result, access, word.text, folder)
}

function addPathText(result: ParsedShell, access: Access, path: string, folder: string): void {
  if (path === '' || path.startsWith('/dev/')) return
  const joined = joinFolder(folder, path)
  if (dynamicPattern.test(joined.replace(homePrefix, ''))) result.isFullyParsed = false
  result[access].push(joined)
}

function joinFolder(folder: string, path: string): string {
  return folder === '' || /^(\/|~|\$HOME(\/|$))/.test(path) ? path : `${folder}/${path}`
}

function literal(text: string): Word {
  return { text, isGlob: false, isDynamic: false }
}
