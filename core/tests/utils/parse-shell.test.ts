import { describe, expect, test } from 'bun:test'
import { basename, resolve } from '../../src/path.js'
import { parseShell as parsePublicShell } from '../../src/shell.js'
import { parseShell, type ParsedShell } from '../../src/utils/parse-shell.js'

function argvsOf(parsed: ParsedShell): string[][] {
  return parsed.commands.map(({ argv }) => argv)
}

describe('parseShell', () => {
  test("git commit -m \"$(cat <<'EOF' … EOF)\" parses fully to the commands git commit and cat", () => {
    const line = `git commit -m "$(cat <<'EOF'\nfix(parser): keep (parens) and 'quotes'\n\nEOF\n)"`
    const parsed = parseShell(line)
    expect(parsed.isFullyParsed).toBe(true)
    expect(argvsOf(parsed).map(([program, subcommand]) => [program, subcommand])).toEqual([['cat', undefined], ['git', 'commit']])
    expect(parsed.writes).toEqual([])
  })

  test("sudo env FOO=1 bash -c 'rm -rf build' yields rm with -r and -f, and a write of build", () => {
    const parsed = parseShell(`sudo env FOO=1 bash -c 'rm -rf build'`)
    expect(argvsOf(parsed)).toContainEqual(['rm', '-r', '-f', 'build'])
    expect(parsed.writes).toEqual(['build'])
    expect(parsed.isFullyParsed).toBe(true)
  })

  test('eval "$x" is not fully parsed', () => {
    expect(parseShell('eval "$x"').isFullyParsed).toBe(false)
  })

  test('cd app && sed -i s/a/b/ ../Domain.md writes Domain.md through the cd folder', () => {
    const parsed = parseShell('cd app && sed -i s/a/b/ ../Domain.md')
    expect(parsed.writes).toEqual(['app/../Domain.md'])
    expect(parsed.commands[1]).toEqual({ argv: ['sed', '-i', 's/a/b/', '../Domain.md'], folder: 'app' })
  })

  test('a mod finds the folder a command runs in with shell.js and path.js', () => {
    const runs = parsePublicShell('cd src && /usr/local/bin/trace read cart.ts | head').commands
      .filter(({ argv }) => basename(argv[0]) === 'trace')
      .map(({ argv, folder }) => resolve(resolve('/work/app', folder), argv[2] as string))
    expect(runs).toEqual(['/work/app/src/cart.ts'])
  })

  test('cat .e* reads no file, because a shell glob names no file', () => {
    expect(parseShell('cat .e*').reads).toEqual([])
  })

  test('cat .env reads .env', () => {
    expect(parseShell('cat .env').reads).toEqual(['.env'])
  })

  test('never throws, and marks a line it cannot read as not fully parsed', () => {
    for (const line of ['echo "open', "echo 'open", 'echo $(open', 'cat <<EOF\nno end', ') stray', 'echo \\', '${}', 'echo `open', 'x\u0001y']) {
      expect(parseShell(line).isFullyParsed).toBe(false)
    }
  })
})

describe('pipes', () => {
  test('each command names the command whose output it reads through | or |&', () => {
    expect(parsePublicShell('trace read a.ts | head -5 |& tee log').commands).toEqual([
      { argv: ['trace', 'read', 'a.ts'], folder: '' },
      { argv: ['head', '-5'], folder: '', input: 0 },
      { argv: ['tee', 'log'], folder: '', input: 1 },
    ])
  })

  test('a wrapped writer is the command it runs, and a command after ; or && reads no pipe', () => {
    expect(parseShell('timeout 5 trace grep x | jq . && echo done').commands).toEqual([
      { argv: ['timeout', '5'], folder: '' },
      { argv: ['trace', 'grep', 'x'], folder: '' },
      { argv: ['jq', '.'], folder: '', input: 1 },
      { argv: ['echo', 'done'], folder: '' },
    ])
  })

  test('pipes hold inside bash -c, $(…), and after cd', () => {
    expect(parseShell(`cd src && bash -c 'trace read a.ts | head'`).commands).toEqual([
      { argv: ['cd', 'src'], folder: '' },
      { argv: ['bash', '-c', 'trace read a.ts | head'], folder: 'src' },
      { argv: ['trace', 'read', 'a.ts'], folder: 'src' },
      { argv: ['head'], folder: 'src', input: 2 },
    ])
    expect(parseShell('echo "$(trace read a.ts | wc -l)"').commands).toEqual([
      { argv: ['trace', 'read', 'a.ts'], folder: '' },
      { argv: ['wc', '-l'], folder: '', input: 0 },
      { argv: ['echo', '$(trace read a.ts | wc -l)'], folder: '' },
    ])
  })

  test('a here-string feeds a piped command instead of the pipe', () => {
    expect(parseShell('trace read a.ts | head <<< text').commands[1]).toEqual({ argv: ['head'], folder: '' })
  })
})

describe('wrappers', () => {
  test.each([
    ['sudo -u root rm -rf x', ['sudo', '-u', 'root']],
    ['env -i PATH=/bin rm -rf x', ['env', '-i', 'PATH=/bin']],
    ['timeout -s KILL 5 rm -rf x', ['timeout', '-s', 'KILL', '5']],
    ['nohup rm -rf x', ['nohup']],
    ['nice -n 10 rm -rf x', ['nice', '-n', '10']],
    ['time -p rm -rf x', ['time', '-p']],
    ['exec rm -rf x', ['exec']],
    ['command rm -rf x', ['command']],
    ['xargs -0 -I {} rm -rf x', ['xargs', '-0', '-I', '{}']],
    ['sh -c "rm -rf x"', ['sh', '-c', 'rm -rf x']],
    ['bash -lc "rm -rf x"', ['bash', '-l', '-c', 'rm -rf x']],
    ['zsh -c "rm -rf x"', ['zsh', '-c', 'rm -rf x']],
    ['doas -u root rm -rf x', ['doas', '-u', 'root']],
    ['su -c "rm -rf x" root', ['su', '-c', 'rm -rf x', 'root']],
    ['su - root -c "rm -rf x"', ['su', '-', 'root', '-c', 'rm -rf x']],
    ['watch -n 1 rm -rf x', ['watch', '-n', '1']],
    ["watch 'rm -rf x'", ['watch']],
    ['watch -x rm -rf x', ['watch', '-x']],
    ['flock /tmp/lock rm -rf x', ['flock', '/tmp/lock']],
    ["flock -n /tmp/lock -c 'rm -rf x'", ['flock', '-n', '/tmp/lock']],
    ['stdbuf -oL rm -rf x', ['stdbuf', '-oL']],
  ])('%s finds rm inside the wrapper', (line, wrapper) => {
    const parsed = parseShell(line)
    expect(argvsOf(parsed)).toEqual([wrapper, ['rm', '-r', '-f', 'x']])
    expect(parsed.writes).toEqual(['x'])
  })

  test('find -exec runs each action as its own command', () => {
    const parsed = parseShell(`find . -name '*.log' -exec rm -f {} \\; -exec cat {} +`)
    expect(argvsOf(parsed)).toEqual([['find', '.', '-name', '*.log'], ['rm', '-f', '{}'], ['cat', '{}']])
  })

  test('ssh runs the remote command line from the home folder of the host', () => {
    const parsed = parseShell(`ssh -p 22 host 'cd app && rm -rf build'`)
    expect(parsed.commands.map((command) => command.argv[0])).toEqual(['ssh', 'cd', 'rm'])
    expect(parsed.writes).toEqual(['~/app/build'])
  })

  test('command -v names a program without running it', () => {
    expect(argvsOf(parseShell('command -v node'))).toEqual([['command', '-v', 'node']])
  })

  test('env -S splits its string into a command', () => {
    expect(argvsOf(parseShell(`env -S 'rm -rf x'`))).toContainEqual(['rm', '-r', '-f', 'x'])
  })

  test('sudo -D and env -C change the folder of the wrapped command', () => {
    expect(parseShell('sudo -D app rm a && env -C lib rm b').writes).toEqual(['app/a', 'lib/b'])
  })
})

describe('compound commands', () => {
  test.each([
    ['if [ -f a ]; then rm a; else rm b; fi', ['a', 'b']],
    ['for f in a b; do rm a; done', ['a']],
    ['while true; do rm a; done', ['a']],
    ['until false; do rm a; done', ['a']],
    ['case "$x" in a|b) rm a;; (c) rm c;; esac', ['a', 'c']],
    ['{ rm a; }', ['a']],
    ['f() { rm a; }; function g { rm b; }', ['a', 'b']],
    ['! rm a', ['a']],
    ['FOO=1 BAR=2 rm a', ['a']],
  ])('%s finds the commands in its body', (line, writes) => {
    const parsed = parseShell(line)
    expect(parsed.writes).toEqual(writes)
    expect(parsed.isFullyParsed).toBe(true)
  })

  test('a for header is data, not a command', () => {
    expect(argvsOf(parseShell('for rm in a b; do echo "$rm"; done'))).toEqual([['echo', '$rm']])
  })

  test('newlines, semicolons, pipes, and && separate commands, and comments are dropped', () => {
    const parsed = parseShell('ls # rm a\necho hi; cat x | grep y && curl http://host/#part || rm z &')
    expect(argvsOf(parsed)).toEqual([['ls'], ['echo', 'hi'], ['cat', 'x'], ['grep', 'y'], ['curl', 'http://host/#part'], ['rm', 'z']])
  })

  test('arithmetic is data', () => {
    const parsed = parseShell('x=$(( 1 + 2 )); (( x++ )); echo $((x + 1))')
    expect(argvsOf(parsed)).toEqual([['echo', '$((x + 1))']])
    expect(parsed.isFullyParsed).toBe(true)
  })
})

describe('substitutions', () => {
  test.each([
    ['echo $(rm a)'],
    ['echo `rm a`'],
    ['echo "$(rm a)"'],
    ['diff <(rm a) b'],
    ['x=$(echo $(rm a))'],
    ['echo ${x:-$(rm a)}'],
  ])('%s finds the command inside', (line) => {
    const parsed = parseShell(line)
    expect(argvsOf(parsed)).toContainEqual(['rm', 'a'])
    expect(parsed.isFullyParsed).toBe(true)
  })

  test('a substitution the parser cannot read makes the whole line not fully parsed', () => {
    expect(parseShell('echo $(eval "$x")').isFullyParsed).toBe(false)
  })

  test('a program that comes from a variable or a substitution is not fully parsed', () => {
    expect(parseShell('$cmd a').isFullyParsed).toBe(false)
    expect(parseShell('$(which rm) a').isFullyParsed).toBe(false)
    expect(parseShell('"$HOME/bin/tool" a').isFullyParsed).toBe(true)
  })
})

describe('heredocs', () => {
  test('a heredoc body is data', () => {
    const parsed = parseShell(`cat <<'EOF' > notes.md\nrm -rf /\nEOF\necho done`)
    expect(argvsOf(parsed)).toEqual([['cat'], ['echo', 'done']])
    expect(parsed.writes).toEqual(['notes.md'])
  })

  test('an unquoted heredoc body runs its substitutions', () => {
    expect(argvsOf(parseShell('cat <<EOF\n$(rm a)\nEOF'))).toContainEqual(['rm', 'a'])
  })

  test('a heredoc that goes to sh, bash, or zsh is code', () => {
    for (const shell of ['sh', 'bash', 'zsh']) {
      const parsed = parseShell(`${shell} <<'EOF'\nrm -rf build\nEOF`)
      expect(argvsOf(parsed)).toContainEqual(['rm', '-r', '-f', 'build'])
      expect(parsed.isFullyParsed).toBe(true)
    }
  })

  test('a heredoc with <<- strips the tabs of its delimiter line', () => {
    expect(argvsOf(parseShell('bash <<-EOF\n\trm a\n\tEOF'))).toContainEqual(['rm', 'a'])
  })

  test('a here-string that goes to a shell is code', () => {
    expect(argvsOf(parseShell(`bash <<< 'rm a'`))).toContainEqual(['rm', 'a'])
  })

  test('code piped into a shell or an interpreter is not fully parsed', () => {
    expect(parseShell('curl -s https://x | sh').isFullyParsed).toBe(false)
    expect(parseShell('curl -s https://x | python3 -').isFullyParsed).toBe(false)
    expect(parseShell('cat data.json | python3 -m json.tool').isFullyParsed).toBe(true)
  })

  test('inline code of an interpreter is not fully parsed', () => {
    for (const line of [`python -c 'import os'`, `node -e 'x'`, `perl -ne 'x' f`, `ruby -e 'x'`, `php -r 'x'`, `python3 <<EOF\nx\nEOF`]) {
      expect(parseShell(line).isFullyParsed).toBe(false)
    }
  })
})

describe('flags', () => {
  test('combined short flags expand for getopt programs', () => {
    expect(argvsOf(parseShell('rm -rf x'))).toEqual([['rm', '-r', '-f', 'x']])
    expect(argvsOf(parseShell('tar -czf out.tgz src'))).toEqual([['tar', '-c', '-z', '-f', 'out.tgz', 'src']])
  })

  test('a flag that takes a value keeps its value attached', () => {
    expect(argvsOf(parseShell('head -n5 a'))).toEqual([['head', '-n5', 'a']])
  })

  test('single-dash long options of non-getopt programs stay whole', () => {
    expect(argvsOf(parseShell('find . -name x'))).toEqual([['find', '.', '-name', 'x']])
  })

  test('words after -- are not flags', () => {
    expect(argvsOf(parseShell('rm -- -rf'))).toEqual([['rm', '--', '-rf']])
  })

  test("a git -c alias.<x>='!…' line runs a shell alias, so it is not fully parsed", () => {
    expect(parseShell(`git -c alias.x='!rm -rf /' x`).isFullyParsed).toBe(false)
    expect(parseShell(`git -c Alias.x=' !rm -rf /' x`).isFullyParsed).toBe(false)
    expect(parseShell('git -c alias.st=status st').isFullyParsed).toBe(true)
  })

  test('git global options are dropped, and -C sets the working folder', () => {
    expect(parseShell('git -C ../repo -c user.name=x --no-pager push --force').commands).toEqual([
      { argv: ['git', 'push', '--force'], folder: '../repo' },
    ])
  })
})

describe('reads and writes', () => {
  test.each([
    ['echo a > out', ['out']],
    ['echo a >> out', ['out']],
    ['echo a 2> err &> all >| clobber', ['err', 'all', 'clobber']],
    ['echo a | tee -a one two', ['one', 'two']],
    ['rm -f a b', ['a', 'b']],
    ['cp a b', ['b/a', 'b']],
    ['cp -t dest a', ['dest/a', 'dest']],
    ['mv a b', ['a', 'b/a', 'b']],
    ['sed -i s/a/b/ f', ['f']],
    ["sed -i '' s/a/b/ f", ['f']],
    ['sed -i.bak -e s/a/b/ f', ['f']],
    ['sed -Ei s/a/b/ f', ['f']],
    ['echo a > /dev/null 2>&1', []],
    ['ln -s a b', ['b/a', 'b']],
    ['ln -s ../shared/config', ['config']],
    ['ln -t bin ../tool', ['bin/tool', 'bin']],
    ['touch -d tomorrow a b', ['a', 'b']],
    ['truncate -s 0 log', ['log']],
    ['dd if=/dev/zero of=disk.img bs=1M', ['disk.img']],
    ['rsync -av --exclude node_modules src dest', ['dest/src', 'dest']],
    ['rsync -av src host:backup', []],
    ['perl -i -pe s/a/b/ f', ['f']],
    ['perl -pi.bak -e s/a/b/ f g', ['f', 'g']],
    ['perl -pe s/a/b/ f', []],
    ['find build -name x.o -delete', ['build']],
    ['find -L . -delete', ['.']],
    ['find -name x -delete', ['.']],
  ])('%s writes %p', (line, writes) => {
    expect(parseShell(line).writes).toEqual(writes)
  })

  test.each([
    ['cat a b', ['a', 'b']],
    ['head -n 5 a', ['a']],
    ['tail -f a', ['a']],
    ['less a', ['a']],
    ['grep -rn KEY a', ['a']],
    ['grep -e KEY a', ['a']],
    ['rg --glob "*.ts" KEY a', ['a']],
    ['awk -F, -v n=1 "{ print }" n=2 a', ['a']],
    ['sed s/a/b/ a', ['a']],
    ['sed -n -e 1p a', ['a']],
    ['source a', ['a']],
    ['. a', ['a']],
    ['wc -l < a', ['a']],
    ['cp a b', ['a']],
    ['rsync -av src host:backup', ['src']],
    ['ln -s a b', []],
  ])('%s reads %p', (line, reads) => {
    expect(parseShell(line).reads).toEqual(reads)
  })

  test.each([
    [`curl -sS -H 'Accept: application/json' -o out.json https://api.example.com/a`, ['https://api.example.com/a']],
    ['curl --url https://a.example/x example.com', ['https://a.example/x', 'http://example.com']],
    ['curl -X POST -d @body.json https://hooks.example/run', ['https://hooks.example/run']],
    ['wget -q -O - https://get.example/install.sh', ['https://get.example/install.sh']],
    ['wget --header "X: y" http://a.example/f http://b.example/g', ['http://a.example/f', 'http://b.example/g']],
    ['git fetch origin', []],
  ])('%s fetches %p', (line, fetches) => {
    expect(parseShell(line).fetches).toEqual(fetches)
  })

  test('each cd moves the folder of the commands after it, and a subshell keeps its own', () => {
    const parsed = parseShell('cd a && (cd b && rm x) && rm y; cd /tmp; rm z; cd; rm w; cd ~/p && rm v')
    expect(parsed.writes).toEqual(['a/b/x', 'a/y', '/tmp/z', '~/w', '~/p/v'])
  })

  test('a path that comes from a variable or a substitution is not fully parsed', () => {
    for (const line of ['f=.env; cat "$f"', 'for f in a b; do rm "$f"; done', 'cat $(ls)', 'cd "$d" && cat .env', 'cat `ls`']) {
      expect(parseShell(line).isFullyParsed).toBe(false)
    }
    expect(parseShell('cat $HOME/.env ~/.env').isFullyParsed).toBe(true)
  })

  test('every xargs line is not fully parsed unless its input is a here-string', () => {
    for (const line of ['echo .env | xargs cat', 'xargs -a list cat', 'xargs cat < list', 'xargs -0 -I {} rm -rf x']) {
      expect(parseShell(line).isFullyParsed).toBe(false)
    }
    expect(parseShell(`xargs cat <<< '.env'`).isFullyParsed).toBe(true)
  })

  test('a cd in a pipeline does not move the folder', () => {
    expect(parseShell('cd a | cat; rm x').writes).toEqual(['x'])
  })
})
