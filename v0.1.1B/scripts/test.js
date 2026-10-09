"use strict";

const assert = require("assert");
const path = require("path");
const { compileFile, compile, CompileError } = require("../src/compino");

const root = path.join(__dirname, "..");
function run(name) {
  return compileFile(path.join(root, "examples", name), {}).code;
}

const blink = run("blink.cno");
assert(blink.includes("pinMode(7, OUTPUT)"), "blink pinMode");
assert(blink.includes("digitalWrite(7, HIGH)"), "blink write");
assert(!blink.includes("CVal"), "blink must not emit the value runtime");
assert(!blink.includes("Serial.begin"), "blink does not use serial");

const basics = run("basics.cno");
assert(basics.includes("String v_text;"), "string var");
assert(basics.includes("fn_add"), "function");
assert(basics.includes("Serial.println"), "serial");
assert(basics.includes("delay(1000)"), "sleep");
assert(!basics.includes("cin_req_"), "basics has no requests");

const servo = run("servo.cno");
assert(servo.includes("#include <Servo.h>"));
assert(servo.includes("v_servo.attach(9);"));
assert(servo.includes("v_servo.write(10);"));
assert(!servo.includes("CVal"));

const led = run("index.cno");
assert(led.includes("class Switch"));
assert(led.includes("v_led.turnOn()"));
assert(led.includes("cin_req_high"));
assert(led.includes("digitalWrite"));
assert(!led.includes("struct CVal"));

function fails(source, code) {
  try {
    compile(source, { filename: "bad.cno" });
    assert.fail("expected " + code);
  } catch (err) {
    assert(err instanceof CompileError, "CompileError");
    assert(err.errors.some((e) => e.code === code), err.message);
  }
}

fails("func f ($a) {}\nfunc f ($a) {}\n", "E011");
fails("$n = 1 / 0\n", "E009");
fails("writable(@400)\n", "E006");
fails("$a = 1\n$a:$b\n$a:$c\n", "E007");
fails("$a = 1\n$a -> $b\nserial($a)\n", "E008");
fails("serial(missing())\n", "E004");
fails("serial(E)\n", "E015");

console.log("ok: slim sketches and error codes");
