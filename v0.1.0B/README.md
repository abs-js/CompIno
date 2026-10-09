# CompIno

CompIno is a small language that transpiles `.cno` source into an Arduino sketch (`.ino`).

This folder is version **v0.1.0B** (beta `0.1.0-beta.0`). Later releases live in their own version folders (`v0.1.0/`, `v0.2.0/`, `v0.2.0B/`, and so on).

## Use

```bash
npx compino@beta sketch.cno
# or, after npm link / install:
CompIno sketch.cno
```

CompIno writes `sketch.ino` next to the source file. Open that file in the Arduino IDE and upload it.

## Commands

```text
CompIno [flags] file.cno
```

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |
| `-d`, `--detailed`, `--detalhed` | Print transpile steps |
| `-l`, `--learn` | Open the HTML lesson in a browser |

## Publish

From this folder, after `npm login`:

```bash
sh scripts/publish-npm.sh
```

The npm package name is `compino` (npm requires lowercase). The command name is `CompIno`.

## Docs

- [Language guide](docs/LANGUAGE.md)
- [Lesson](learn/index.html)
