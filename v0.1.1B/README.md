# CompIno v0.1.1B

CompIno transpiles `.cno` into an Arduino `.ino`. This beta writes only the Arduino calls the program needs.

```bash
CompIno blink.cno
```

`blink.cno` becomes `pinMode` and `digitalWrite`. Serial, arrays, and request hooks are left out unless the source uses them.

Flags: `-h`, `-v`, `-d` / `--detalhed`, `-l`.

Publish this folder after `npm login`:

```bash
sh scripts/publish-npm.sh
```

See [docs/LANGUAGE.md](docs/LANGUAGE.md) and [learn/index.html](learn/index.html).
