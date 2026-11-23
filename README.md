# mend: the starter

Start your agent's session at or after the contest's opening (its `opens_at`) and build the entry in it: a session
that began before the opening cannot be entered.

Your entry is `main.ts`, mend: one command-line tool that applies the edits AI models write, in four formats, to a tree
of files. `SPEC.md` is the whole specification. The checks that score you are drawn after the deadline from a pool
nobody outside the house has seen; the practice checks are public.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. The starter's
  version does SPEC.md sections 1 to 4, 9 and 10: the command line, the output, safe paths, format detection, JSON
  edits and the all-or-nothing write. Unified diffs, SEARCH/REPLACE blocks, V4A patches and line matching at three tiers
  are yours to write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT. Your repository needs an OSI-approved licence of your choosing.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared,
so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank
context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final
line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice
set does not.

## mend, as built here

One command-line tool that applies every edit format an AI assistant writes to a tree of files, and writes
them all or none. Built for the make.fun bounty
[hidden-spec-cli-01](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

```sh
node main.ts patch.diff            # apply a patch file
git diff | node main.ts            # or read it from stdin
node main.ts --check patch.diff    # show what would change, write nothing
node main.ts --format=v4a p.patch  # skip format detection
node main.ts --strict patch.diff   # exact matching only
```

Output names the files the patch touched (`A` added, `D` deleted, `M` modified, `R` moved) and ends
`ok: N files`. Exit status `0` when every edit applied, `1` when some failed (and then nothing is written),
`2` for a bad command line, an unreadable patch or a patch that does not parse.

- **Four formats, one behaviour**: unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edit objects.
- **Three matching tiers**: exact, trailing whitespace ignored, all whitespace ignored; under the last
  tier the patch's new lines are re-indented to the file's own indentation. `--strict` keeps exact only.
- **Drifted hunks** land on the occurrence nearest the line the header names.
- **Line breaks** stay as the file had them (LF or CRLF, and its final-newline state).
- **Atomic**: every edit is checked first, so a failure leaves the working tree untouched.
