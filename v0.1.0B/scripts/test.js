"use strict";

const assert = require("assert");
const path = require("path");
const { compileFile } = require("../src/compino");

const root = path.join(__dirname, "..");

function compile(name) {
  return compileFile(path.join(root, "examples", name), {}).code;
}

const blink = compile("blink.cno");
assert(blink.includes("cWritable(cPin(7))"), "blink should set pin 7 as output");
assert(blink.includes("cWritePin(7"), "blink should drive pin 7");
assert(blink.includes("void loop()"), "blink should have loop");

const basics = compile("basics.cno");
assert(basics.includes("fn_somar"), "basics should emit somar");
assert(basics.includes("Serial.println"), "basics should print");
assert(basics.includes("delay("), "basics should sleep");

const servo = compile("servo.cno");
assert(servo.includes("#include <Servo.h>"), "servo include");
assert(servo.includes("Servo v_servo;"), "servo object");
assert(servo.includes("v_servo.attach(9);"), "servo attach");
assert(servo.includes("v_servo.write(10);"), "servo write");

const led = compile("index.cno");
assert(led.includes("class Liga"), "imported class");
assert(led.includes("cin_req_writable"), "writable request");
assert(led.includes("cin_req_high"), "high request");
assert(led.includes("v_led.ligar()"), "ligar call");
assert(led.includes("digitalWrite"), "pin write in runtime or request");

console.log("ok: 4 examples compiled");
