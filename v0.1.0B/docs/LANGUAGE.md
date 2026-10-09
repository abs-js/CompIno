# CompIno language guide

CompIno (version 0.1.0-beta.0) turns a `.cno` file into Arduino C++. Comments start with `#` and run to the end of the line.

Code before `&{ ... }` is `setup()`. Code inside `&{ ... }` is `loop()`.

## Variables

Names start with `$`.

```text
$num = 10
$texto = "hello"
$bool = True
$soma = $num + 10
$array = [$num, $soma, 30]
```

`True` and `False` are booleans. `E` is the poison value: if a value becomes `E`, later uses of it stay `E`.

Arithmetic operators are `+`, `-`, `*`, `/`, `%`. Compound forms are `+=`, `-=`, `*=`, `/=`, `%=`.

## Functions

```text
func somar ($a, $b) {
  return $a + $b
}
$soma = somar(1, 10)
```

## Pins

`@10` is digital pin 10. `~5` is analog pin 5 (read range 0–1023).

```text
writable(@7)    # pinMode OUTPUT
readable(@7)    # pinMode INPUT
@7 = true       # digitalWrite HIGH
$level = ~5     # analogRead
```

Assigning to `~5` calls `analogWrite` (0–255).

## Control

```text
if ($algo) {
  serial("yes")
} elif ($outro) {
  serial("elif")
} else {
  serial("no")
}

while ($algo) {
  $algo = false
}
```

Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`. Logic: `and`, `or`, `xor`, and `!`.

## Builtins

- `sleep(ms)` delays for milliseconds.
- `serial(value)` prints a line at 9600 baud.
- `map(value, fromLow, fromHigh, toLow, toHigh)` scales a number. Four arguments mean `toLow` is 0.

## Move, swap, chain, put

```text
$algo -> $outro    # move. $algo becomes E
$a <=> $b          # swap
$a:$b              # chain. Both names share one value. A second chain is a fixed-chain error.
$outro = $array => somar
```

`=>` puts the left value into the right value:

- into a function: call it (each array item is one call)
- into a number: sum
- into text: join
- into an array: keep the array
- into a class or boolean: no change

## Classes

Fields and methods that start with `_` belong to the class. Outside the class, drop the underscore.

```text
class Algo {
  func _main ($coisa) {
    _algo = $coisa
  }
  _texto = "hello"
  Main _main
}
$algo = new Algo(10)
serial($algo.texto)
serial($algo.algo)
```

## Libraries

Arduino headers:

```text
import Servo from "Servo.h"
$servo = new Servo(@9)
&{
  $servo.write(90)
}
```

CompIno libraries use `.cnl`. A `.cnl` file cannot use `@`, `~`, or `&`. It asks the sketch for board access with `request`.

```text
request writable $pin
request _pin => high()
```

The sketch answers inside `&lib { ... }`:

```text
&lib {
  req writable = writable()
  req high = func ($p) {
    $p = true
  }
  req low = func ($p) {
    $p = false
  }
}
```

`typeof(value)` returns `number`, `string`, `bool`, `array`, `Pin`, `class`, or `E`.
