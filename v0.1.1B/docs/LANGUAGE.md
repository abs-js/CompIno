# CompIno language guide

CompIno 0.1.1-beta.0 turns a `.cno` file into an Arduino sketch. The generated `.ino` contains only the calls the program uses: a blink sketch is `pinMode` and `digitalWrite`, not a general runtime.

Comments start with `#`. Code before `&{ ... }` is `setup()`. Code inside `&{ ... }` is `loop()`.

## Variables

```text
$num = 10
$text = "hello"
$flag = True
$sum = $num + 10
$values = [$num, $sum, 30]
```

`E` poisons the value that receives it. Passing `E` into a call is an error.

## Functions and control

```text
func add ($a, $b) {
  return $a + $b
}

if ($flag) {
  serial("yes")
} elif ($num > 5) {
  serial("elif")
} else {
  serial("no")
}
```

Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`. Logic: `and`, `or`, `xor`, `!`.

## Pins

`@7` is digital pin 7. `~5` is analog pin 5 (0–1023). `writable(@7)` is output. `readable(@7)` is input.

## Libraries

```text
import Servo from "Servo.h"
import Switch from "lib.cnl"
```

A `.cnl` file cannot use `@`, `~`, or `&`. It asks with `request`. The sketch answers in `&lib`.

## Error codes

| Code | Meaning |
| --- | --- |
| E001 | Broken syntax or missing brace |
| E002 | Unexpected token |
| E003 | Unterminated string |
| E004 | Unknown function |
| E006 | Pin outside 0–127 digital or 0–21 analog |
| E007 | fixed chain |
| E008 | Use after move |
| E009 | Division by zero |
| E010 | Library used a pin or loop block |
| E011 | Duplicate function or class |
| E012 | Missing class or export |
| E013 | Import file not found |
| E014 | Request has no `&lib` handler |
| E015 | Poison value `E` passed into a call |

CompIno reports every error it can find and does not write a `.ino` until the source is clean.
