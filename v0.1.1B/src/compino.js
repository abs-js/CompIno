"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = "0.1.1-beta.0";
const KEYWORDS = new Set([
  "func", "return", "if", "elif", "else", "while", "class", "new", "import",
  "from", "export", "writable", "readable", "and", "or", "xor", "Main",
  "request", "req", "typeof", "True", "False", "true", "false", "E", "Pin",
]);

class CompileError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.file + ":" + e.line + ":" + e.col + " " + e.code + " " + e.message).join("\n"));
    this.errors = errors;
  }
}

function compileFile(filePath, options) {
  const source = fs.readFileSync(filePath, "utf8");
  return compile(source, {
    filename: path.basename(filePath),
    baseDir: path.dirname(filePath),
    detailed: !!(options && options.detailed),
    isLib: filePath.endsWith(".cnl"),
  });
}

function compile(source, options) {
  const opts = options || {};
  const filename = opts.filename || "sketch.cno";
  const errors = [];
  const log = [];
  const fail = (code, line, col, message, hint) => {
    errors.push({ file: filename, code, line: line || 1, col: col || 1, message, hint: hint || "" });
  };
  const tokens = tokenize(source, filename, fail);
  if (opts.detailed) log.push("tokens: " + tokens.length);
  const ast = parse(tokens, filename, fail);
  if (opts.isLib) checkLibrary(tokens, filename, fail);
  const imported = loadImports(ast, opts.baseDir || process.cwd(), fail, log, opts.detailed);
  check(ast, imported, fail);
  if (errors.length) {
    const err = new CompileError(errors);
    err.log = log;
    throw err;
  }
  const code = generate(ast, imported, filename, log);
  if (opts.detailed) log.push("features: " + (code.features || []).join(", "));
  return { code: code.text, log, ast, errors, features: code.features };
}

function tokenize(source, filename, fail) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (type, value, l, c) => tokens.push({ type, value, line: l, col: c });
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") { line++; col = 1; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; col++; continue; }
    if (ch === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    const sl = line;
    const sc = col;
    if (ch === '"') {
      i++; col++;
      let s = "";
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          const n = source[i + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n || "";
          i += 2; col += 2; continue;
        }
        if (source[i] === '"') { closed = true; i++; col++; break; }
        if (source[i] === "\n") { line++; col = 1; } else col++;
        s += source[i]; i++;
      }
      if (!closed) fail("E003", sl, sc, "Unterminated string", "Close the quote on the same line.");
      push("string", s, sl, sc);
      continue;
    }
    if (ch === "$") {
      i++; col++;
      const id = readIdent(source, i);
      if (!id) fail("E001", sl, sc, "Expected a name after $");
      i += id.length; col += id.length;
      push("var", id, sl, sc);
      continue;
    }
    if (ch === "@" || ch === "~") {
      const analog = ch === "~";
      i++; col++;
      let num = "";
      while (i < source.length && /[0-9]/.test(source[i])) { num += source[i]; i++; col++; }
      if (!num) fail("E001", sl, sc, "Expected a pin number after " + ch);
      push(analog ? "apin" : "pin", Number(num || 0), sl, sc);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let num = "";
      while (i < source.length && /[0-9.]/.test(source[i])) { num += source[i]; i++; col++; }
      push("number", Number(num), sl, sc);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const id = readIdent(source, i);
      i += id.length; col += id.length;
      if (id === "True" || id === "true") push("bool", true, sl, sc);
      else if (id === "False" || id === "false") push("bool", false, sl, sc);
      else if (KEYWORDS.has(id)) push(id, id, sl, sc);
      else push("ident", id, sl, sc);
      continue;
    }
    const three = source.slice(i, i + 3);
    const pair = source.slice(i, i + 2);
    if (three === "<=>") { push("swap", "<=>", sl, sc); i += 3; col += 3; continue; }
    if (["==", "!=", ">=", "<=", "->", "=>", "+=", "-=", "*=", "/=", "%="].includes(pair)) {
      push(pair, pair, sl, sc); i += 2; col += 2; continue;
    }
    if ("=><+-*/%!(){}[],.:&".includes(ch)) { push(ch, ch, sl, sc); i++; col++; continue; }
    fail("E002", sl, sc, "Unexpected character " + JSON.stringify(ch));
    i++; col++;
  }
  tokens.push({ type: "eof", value: "", line, col });
  return tokens;
}

function readIdent(source, i) {
  if (!/[A-Za-z_]/.test(source[i] || "")) return "";
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
  return source.slice(i, j);
}

function parse(tokens, filename, fail) {
  let p = 0;
  const peek = () => tokens[p] || tokens[tokens.length - 1];
  const next = () => tokens[p++] || tokens[tokens.length - 1];
  const at = (t) => peek().type === t;
  const eat = (t) => {
    if (!at(t)) {
      const tok = peek();
      fail("E002", tok.line, tok.col, "Expected " + t + " but found " + tok.type);
      return tok;
    }
    return next();
  };
  const skipTo = (types) => {
    while (!at("eof") && !types.includes(peek().type)) next();
  };

  function parseProgram() {
    const body = [];
    while (!at("eof")) {
      try {
        body.push(parseStatement());
      } catch (err) {
        fail("E001", peek().line, peek().col, err.message || "Could not parse statement");
        skipTo(["}", "eof"]);
        if (at("}")) next();
      }
    }
    return { type: "program", body };
  }

  function parseBlock() {
    eat("{");
    const body = [];
    while (!at("}") && !at("eof")) body.push(parseStatement());
    if (!at("}")) fail("E001", peek().line, peek().col, "Missing closing brace", "Every { needs a }.");
    else eat("}");
    return body;
  }

  function parseStatement() {
    if (at("&")) {
      const t = next();
      if (at("ident") && peek().value === "lib") { next(); return { type: "lib", body: parseBlock(), line: t.line }; }
      return { type: "loop", body: parseBlock(), line: t.line };
    }
    if (at("if")) return parseIf();
    if (at("while")) return parseWhile();
    if (at("func")) return parseFunc();
    if (at("class")) return parseClass();
    if (at("import")) return parseImport();
    if (at("export")) { next(); return { type: "export", name: eat("ident").value, line: peek().line }; }
    if (at("return")) {
      const t = next();
      if (at("}") || at("eof")) return { type: "return", expr: null, line: t.line };
      return { type: "return", expr: parseExpression(), line: t.line };
    }
    if (at("writable") || at("readable")) {
      const kind = next().type;
      eat("(");
      const pin = parseExpression();
      eat(")");
      return { type: kind, pin, line: pin.line };
    }
    if (at("req")) {
      const t = next();
      const name = next().value;
      eat("=");
      if (at("func")) return { type: "req", name, expr: parseFunc(), line: t.line };
      return { type: "req", name, expr: parseExpression(), line: t.line };
    }
    if (at("request")) return parseRequest();
    if (at("Main")) { next(); return { type: "main", name: next().value, line: peek().line }; }
    if (at("var")) {
      const a = next();
      if (at(":")) { next(); return { type: "chain", a: a.value, b: eat("var").value, line: a.line, col: a.col }; }
      if (at("->")) { next(); return { type: "move", from: a.value, to: eat("var").value, line: a.line, col: a.col }; }
      if (at("swap")) { next(); return { type: "swap", a: a.value, b: eat("var").value, line: a.line }; }
      if (at("=") || at("+=") || at("-=") || at("*=") || at("/=") || at("%=")) {
        const op = next().type;
        return { type: "assign", left: { type: "var", name: a.value }, op, right: parseExpression(), line: a.line };
      }
      p--;
    }
    const expr = parseExpression();
    if (at("=") || at("+=") || at("-=") || at("*=") || at("/=") || at("%=")) {
      const op = next().type;
      return { type: "assign", left: expr, op, right: parseExpression(), line: expr.line || 1 };
    }
    return { type: "expr", expr };
  }

  function parseIf() {
    const t = eat("if");
    eat("("); const cond = parseExpression(); eat(")");
    const then = parseBlock();
    const elifs = [];
    while (at("elif")) {
      next(); eat("("); const c = parseExpression(); eat(")");
      elifs.push({ cond: c, body: parseBlock() });
    }
    let els = null;
    if (at("else")) { next(); els = parseBlock(); }
    return { type: "if", cond, then, elifs, else: els, line: t.line };
  }

  function parseWhile() {
    const t = eat("while");
    eat("("); const cond = parseExpression(); eat(")");
    return { type: "while", cond, body: parseBlock(), line: t.line };
  }

  function parseFunc() {
    const t = eat("func");
    let name = "anon";
    if (at("ident") || at("var")) name = next().value;
    eat("(");
    const params = [];
    if (!at(")")) {
      params.push(eat("var").value);
      while (at(",")) { next(); params.push(eat("var").value); }
    }
    eat(")");
    return { type: "func", name, params, body: parseBlock(), line: t.line };
  }

  function parseClass() {
    const t = eat("class");
    const name = eat("ident").value;
    eat("{");
    const fields = [];
    const methods = [];
    let main = null;
    while (!at("}") && !at("eof")) {
      if (at("Main")) { next(); main = next().value; continue; }
      if (at("func")) { methods.push(parseFunc()); continue; }
      if (at("ident") && tokens[p + 1] && tokens[p + 1].type === "(") {
        const mname = next().value;
        eat("(");
        const params = [];
        if (!at(")")) {
          params.push(eat("var").value);
          while (at(",")) { next(); params.push(eat("var").value); }
        }
        eat(")");
        methods.push({ type: "func", name: mname, params, body: parseBlock(), line: t.line });
        continue;
      }
      if (at("var") || at("ident")) {
        const tok = next();
        if (at("=")) { next(); fields.push({ name: tok.value, init: parseExpression() }); }
        else fields.push({ name: tok.value, init: null });
        continue;
      }
      if (at("request")) { methods.push({ type: "func", name: "_inline", params: [], body: [parseRequest()], line: t.line }); continue; }
      fail("E002", peek().line, peek().col, "Unexpected token in class: " + peek().type);
      next();
    }
    eat("}");
    return { type: "class", name, fields, methods, main, line: t.line };
  }

  function parseImport() {
    const t = eat("import");
    const name = eat("ident").value;
    eat("from");
    const from = eat("string").value;
    return { type: "import", name, from, line: t.line };
  }

  function parseRequest() {
    const t = eat("request");
    if ((at("ident") || at("writable") || at("readable")) && tokens[p + 1] && tokens[p + 1].type !== "=>") {
      const name = next().value;
      return { type: "request", name, arg: parseExpression(), line: t.line };
    }
    const value = parsePostfix();
    if (at("=>")) {
      next();
      return { type: "requestPut", value, call: parsePostfix(), line: t.line };
    }
    return { type: "request", name: "anything", arg: value, line: t.line };
  }

  function parseExpression() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    while (at("or") || at("xor")) { const op = next().type; left = { type: "binary", op, left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (at("and")) { next(); left = { type: "binary", op: "and", left, right: parseCmp() }; }
    return left;
  }
  function parseCmp() {
    let left = parseAdd();
    while (at("==") || at("!=") || at(">") || at("<") || at(">=") || at("<=")) {
      const op = next().type; left = { type: "binary", op, left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (at("+") || at("-")) { const op = next().type; left = { type: "binary", op, left, right: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (at("*") || at("/") || at("%")) { const op = next().type; left = { type: "binary", op, left, right: parseUnary(), line: left.line }; }
    return left;
  }
  function parseUnary() {
    if (at("!")) { const t = next(); return { type: "unary", op: "!", expr: parseUnary(), line: t.line }; }
    return parsePut();
  }
  function parsePut() {
    let left = parsePostfix();
    if (at("=>")) { next(); left = { type: "put", left, right: parsePostfix() }; }
    return left;
  }
  function parsePostfix() {
    let expr = parsePrimary();
    while (true) {
      if (at("(")) {
        next();
        const args = [];
        if (!at(")")) {
          args.push(parseExpression());
          while (at(",")) { next(); args.push(parseExpression()); }
        }
        eat(")");
        expr = { type: "call", callee: expr, args, line: expr.line };
        continue;
      }
      if (at(".")) {
        next();
        const name = next().value;
        expr = { type: "member", object: expr, name, line: expr.line };
        continue;
      }
      break;
    }
    return expr;
  }
  function parsePrimary() {
    const t = peek();
    if (at("number")) { next(); return { type: "number", value: t.value, line: t.line, col: t.col }; }
    if (at("string")) { next(); return { type: "string", value: t.value, line: t.line }; }
    if (at("bool")) { next(); return { type: "bool", value: t.value, line: t.line }; }
    if (at("E")) { next(); return { type: "E", line: t.line, col: t.col }; }
    if (at("var")) { next(); return { type: "var", name: t.value, line: t.line, col: t.col }; }
    if (at("pin") || at("apin")) { next(); return { type: "pin", n: t.value, analog: t.type === "apin", line: t.line, col: t.col }; }
    if (at("typeof")) { next(); eat("("); const expr = parseExpression(); eat(")"); return { type: "typeof", expr, line: t.line }; }
    if (at("new")) {
      next();
      const name = eat("ident").value;
      eat("(");
      const args = [];
      if (!at(")")) { args.push(parseExpression()); while (at(",")) { next(); args.push(parseExpression()); } }
      eat(")");
      return { type: "new", name, args, line: t.line };
    }
    if (at("[")) {
      next();
      const items = [];
      if (!at("]")) { items.push(parseExpression()); while (at(",")) { next(); if (at("]")) break; items.push(parseExpression()); } }
      eat("]");
      return { type: "array", items, line: t.line };
    }
    if (at("(")) { next(); const expr = parseExpression(); eat(")"); return expr; }
    if (at("ident") || at("writable") || at("readable")) { next(); return { type: "ident", name: t.value, line: t.line }; }
    fail("E002", t.line, t.col, "Expected an expression, found " + t.type);
    next();
    return { type: "E", line: t.line, col: t.col };
  }
  return parseProgram();
}

function checkLibrary(tokens, filename, fail) {
  for (const tok of tokens) {
    if (tok.type === "pin" || tok.type === "apin" || tok.type === "&") {
      fail("E010", tok.line, tok.col, "A .cnl library cannot use pins or the loop block", "Ask the sketch with request, and answer it in &lib.");
    }
  }
}

function loadImports(ast, baseDir, fail, log, detailed) {
  const imported = [];
  for (const stmt of ast.body) {
    if (stmt.type !== "import") continue;
    if (stmt.from.endsWith(".cnl")) {
      const full = path.resolve(baseDir, stmt.from);
      if (!fs.existsSync(full)) {
        fail("E013", stmt.line, 1, "Cannot import " + stmt.from, "Check the path relative to the sketch.");
        continue;
      }
      const src = fs.readFileSync(full, "utf8");
      const libErrors = [];
      const libFail = (code, line, col, message, hint) => libErrors.push({ file: stmt.from, code, line, col, message, hint });
      const libTokens = tokenize(src, stmt.from, libFail);
      checkLibrary(libTokens, stmt.from, libFail);
      const libAst = parse(libTokens, stmt.from, libFail);
      for (const item of libErrors) fail(item.code, item.line, item.col, stmt.from + ": " + item.message, item.hint);
      const classes = libAst.body.filter((s) => s.type === "class");
      const exported = new Set(libAst.body.filter((s) => s.type === "export").map((s) => s.name));
      if (exported.size && !exported.has(stmt.name)) fail("E012", stmt.line, 1, stmt.name + " is not exported by " + stmt.from);
      const wanted = classes.find((c) => c.name === stmt.name);
      if (!wanted) fail("E012", stmt.line, 1, "No class " + stmt.name + " in " + stmt.from);
      else imported.push({ kind: "cnl", name: stmt.name, cls: wanted, from: stmt.from });
      if (detailed) log.push("imported " + stmt.name + " from " + stmt.from);
    } else {
      imported.push({ kind: "header", name: stmt.name, from: stmt.from });
      if (detailed) log.push("header " + stmt.from);
    }
  }
  return imported;
}

function check(ast, imported, fail) {
  const funcs = new Set(ast.body.filter((s) => s.type === "func").map((s) => s.name));
  const classes = new Set(ast.body.filter((s) => s.type === "class").map((s) => s.name));
  for (const item of imported) classes.add(item.name);
  const seenFunc = new Set();
  const seenClass = new Set();
  const chains = new Map();
  const dead = new Set();
  const requests = new Set();
  const handlers = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === "func") {
      if (seenFunc.has(stmt.name)) fail("E011", stmt.line, 1, "Duplicate function " + stmt.name);
      seenFunc.add(stmt.name);
    }
    if (stmt.type === "class") {
      if (seenClass.has(stmt.name)) fail("E011", stmt.line, 1, "Duplicate class " + stmt.name);
      seenClass.add(stmt.name);
    }
    if (stmt.type === "lib") for (const s of stmt.body) if (s.type === "req") handlers.add(s.name);
    walk(stmt, (node) => {
      if (!node) return;
      if (node.type === "pin") {
        const max = node.analog ? 21 : 127;
        if (node.n < 0 || node.n > max) {
          fail("E006", node.line, node.col, (node.analog ? "Analog" : "Digital") + " pin " + node.n + " is outside 0.." + max);
        }
      }
      if (node.type === "binary" && (node.op === "/" || node.op === "%") && node.right && node.right.type === "number" && node.right.value === 0) {
        fail("E009", node.line || node.right.line, node.right.col || 1, "Division by zero");
      }
      if (node.type === "call" && node.callee && node.callee.type === "ident") {
        const name = node.callee.name;
        const builtins = new Set(["map", "sleep", "serial", "writable", "readable", "high", "low", "typeof"]);
        if (!builtins.has(name) && !funcs.has(name)) fail("E004", node.line || 1, 1, "Unknown function " + name);
        for (const arg of node.args || []) {
          if (arg.type === "E") fail("E015", arg.line, arg.col, "Cannot pass poison value E into " + name);
        }
      }
      if (node.type === "new" && !classes.has(node.name)) fail("E012", node.line || 1, 1, "Unknown class " + node.name);
      if (node.type === "E" && node.parentUse === "pin") fail("E015", node.line, node.col, "Cannot drive a pin with poison value E");
      if (node.type === "request") requests.add(node.name);
      if (node.type === "requestPut" && node.call && node.call.type === "call" && node.call.callee.type === "ident") requests.add(node.call.callee.name);
      if (node.type === "chain") {
        if (chains.has(node.a) || chains.has(node.b)) fail("E007", node.line, node.col, "fixed chain", "$" + node.a + " or $" + node.b + " is already linked.");
        chains.set(node.a, node.b);
        chains.set(node.b, node.a);
      }
      if (node.type === "move") {
        if (dead.has(node.from)) fail("E008", node.line, node.col, "Use after move", "$" + node.from + " was already moved.");
        dead.add(node.from);
      }
      if (node.type === "var" && dead.has(node.name)) fail("E008", node.line, node.col, "Use after move", "$" + node.name + " no longer holds a value.");
    });
  }
  for (const item of imported) {
    if (!item.cls) continue;
    walk(item.cls, (node) => {
      if (node.type === "request") requests.add(node.name);
      if (node.type === "requestPut" && node.call && node.call.callee && node.call.callee.type === "ident") requests.add(node.call.callee.name);
    });
  }
  for (const name of requests) {
    if (!handlers.has(name)) fail("E014", 1, 1, "Request " + name + " has no handler", "Define it in &lib { req " + name + " = ... }.");
  }
}

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) for (const item of val) walk(item, fn);
    else if (val && typeof val === "object" && val.type) walk(val, fn);
  }
}

function generate(ast, imported, filename, log) {
  const features = new Set();
  const use = (name) => features.add(name);
  const classes = ast.body.filter((s) => s.type === "class").concat(imported.filter((i) => i.kind === "cnl").map((i) => i.cls));
  const funcs = ast.body.filter((s) => s.type === "func");
  const headers = imported.filter((i) => i.kind === "header");
  const nativeVars = new Map();
  const classVars = new Map();
  const lines = [];
  const indentOf = (n) => "  ".repeat(n);

  function cstr(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  }
  function cpp(name) { return "v_" + String(name).replace(/[^A-Za-z0-9_]/g, "_"); }
  function field(name) { return String(name).replace(/^_/, ""); }

  function ex(node) {
    if (!node) return "0";
    if (node.type === "number") return String(node.value);
    if (node.type === "bool") return node.value ? "true" : "false";
    if (node.type === "string") return cstr(node.value);
    if (node.type === "E") { use("poison"); return "cin_poison()"; }
    if (node.type === "var") return cpp(node.name);
    if (node.type === "pin") {
      use("pin");
      return node.analog ? "analogRead(" + node.n + ")" : "digitalRead(" + node.n + ")";
    }
    if (node.type === "unary" && node.op === "!") return "(!" + truth(node.expr) + ")";
    if (node.type === "binary") return "(" + ex(node.left) + " " + cop(node.op) + " " + ex(node.right) + ")";
    if (node.type === "array") {
      use("array");
      return "cin_array(" + node.items.length + ", " + node.items.map(ex).join(", ") + ")";
    }
    if (node.type === "typeof") { use("typeof"); return "cin_typeof(" + ex(node.expr) + ")"; }
    if (node.type === "call") return callOf(node);
    if (node.type === "member") return ex(node.object) + "." + node.name;
    if (node.type === "new") return "/* new " + node.name + " */";
    if (node.type === "put") { use("put"); return "cin_put(" + ex(node.left) + ")"; }
    if (node.type === "ident") return node.name === "Pin" ? cstr("Pin") : "fn_" + node.name;
    return "0";
  }
  function truth(node) {
    if (node.type === "bool") return node.value ? "true" : "false";
    if (node.type === "pin") return ex(node);
    return "(" + ex(node) + ")";
  }
  function cop(op) {
    return { and: "&&", or: "||", xor: "!=" }[op] || op;
  }
  function callOf(node) {
    const c = node.callee;
    if (c.type === "ident") {
      if (c.name === "sleep") return "delay(" + ex(node.args[0]) + ")";
      if (c.name === "serial") { use("serial"); return "Serial.println(" + ex(node.args[0]) + ")"; }
      if (c.name === "map") { use("map"); return "map(" + node.args.map(ex).join(", ") + ")"; }
      if (c.name === "writable") return pinMode(node.args[0], "OUTPUT");
      if (c.name === "readable") return pinMode(node.args[0], "INPUT");
      if (c.name === "high") return writePin(node.args[0], "HIGH");
      if (c.name === "low") return writePin(node.args[0], "LOW");
      return "fn_" + c.name + "(" + node.args.map(ex).join(", ") + ")";
    }
    if (c.type === "member" && c.object.type === "var") {
      return cpp(c.object.name) + "." + c.name + "(" + node.args.map(ex).join(", ") + ")";
    }
    return ex(c) + "()";
  }
  function pinMode(node, mode) {
    use("pin");
    if (node && node.type === "pin") return "pinMode(" + node.n + ", " + mode + ")";
    return "pinMode(" + ex(node) + ", " + mode + ")";
  }
  function writePin(node, level) {
    use("pin");
    if (node && node.type === "pin") {
      return node.analog ? "analogWrite(" + node.n + ", " + level + ")" : "digitalWrite(" + node.n + ", " + level + ")";
    }
    return "digitalWrite(" + ex(node) + ", " + level + ")";
  }

  function emitStmt(stmt, pad, out) {
    const p = indentOf(pad);
    if (!stmt) return;
    if (stmt.type === "writable") { out.push(p + pinMode(stmt.pin, "OUTPUT") + ";"); return; }
    if (stmt.type === "readable") { out.push(p + pinMode(stmt.pin, "INPUT") + ";"); return; }
    if (stmt.type === "assign") {
      if (stmt.left.type === "pin") {
        const level = stmt.right.type === "bool" ? (stmt.right.value ? "HIGH" : "LOW") : ex(stmt.right);
        out.push(p + writePin(stmt.left, level) + ";");
        return;
      }
      if (stmt.left.type === "var") {
        const id = cpp(stmt.left.name);
        if (classVars.has(stmt.left.name) || nativeVars.has(stmt.left.name)) return;
        if (stmt.right.type === "array") {
          use("array");
          stmt.right.items.forEach((item, i) => out.push(p + id + "[" + i + "] = " + ex(item) + ";"));
          return;
        }
        const op = stmt.op === "=" ? "=" : stmt.op;
        out.push(p + id + " " + op + " " + ex(stmt.right) + ";");
        return;
      }
      if (stmt.left.type === "ident") { out.push(p + field(stmt.left.name) + " = " + ex(stmt.right) + ";"); return; }
      out.push(p + ex(stmt.left) + " = " + ex(stmt.right) + ";");
      return;
    }
    if (stmt.type === "expr") {
      if (stmt.expr.type === "new") return;
      out.push(p + ex(stmt.expr) + ";");
      return;
    }
    if (stmt.type === "return") { out.push(p + "return " + (stmt.expr ? ex(stmt.expr) : "0") + ";"); return; }
    if (stmt.type === "if") {
      out.push(p + "if (" + truth(stmt.cond) + ") {");
      for (const s of stmt.then) emitStmt(s, pad + 1, out);
      for (const b of stmt.elifs || []) {
        out.push(p + "} else if (" + truth(b.cond) + ") {");
        for (const s of b.body) emitStmt(s, pad + 1, out);
      }
      if (stmt.else) {
        out.push(p + "} else {");
        for (const s of stmt.else) emitStmt(s, pad + 1, out);
      }
      out.push(p + "}");
      return;
    }
    if (stmt.type === "while") {
      out.push(p + "while (" + truth(stmt.cond) + ") {");
      for (const s of stmt.body) emitStmt(s, pad + 1, out);
      out.push(p + "}");
      return;
    }
    if (stmt.type === "move") {
      use("poison");
      out.push(p + cpp(stmt.to) + " = " + cpp(stmt.from) + ";");
      out.push(p + cpp(stmt.from) + " = cin_poison();");
      return;
    }
    if (stmt.type === "swap") {
      out.push(p + "{ auto cin_tmp = " + cpp(stmt.a) + "; " + cpp(stmt.a) + " = " + cpp(stmt.b) + "; " + cpp(stmt.b) + " = cin_tmp; }");
      return;
    }
    if (stmt.type === "chain") { out.push(p + "/* chain $" + stmt.a + " : $" + stmt.b + " share " + cpp(stmt.a) + " */"); return; }
    if (stmt.type === "request") {
      use("request");
      out.push(p + "cin_req_" + stmt.name + "(" + pinArg(stmt.arg) + ");");
      return;
    }
    if (stmt.type === "requestPut") {
      use("request");
      const name = stmt.call && stmt.call.type === "call" && stmt.call.callee.type === "ident" ? stmt.call.callee.name : "anything";
      out.push(p + "cin_req_" + name + "(" + pinArg(stmt.value) + ");");
      return;
    }
    if (stmt.type === "req") {
      use("request");
      if (stmt.expr.type === "call" && stmt.expr.callee.type === "ident") {
        out.push(p + "cin_req_" + stmt.name + " = cin_builtin_" + stmt.expr.callee.name + ";");
      } else if (stmt.expr.type === "func") {
        out.push(p + "cin_req_" + stmt.name + " = cin_req_impl_" + stmt.name + ";");
      }
    }
  }

  function pinArg(node) {
    if (node && node.type === "pin") return String(node.n);
    if (node && node.type === "var") return cpp(node.name);
    if (node && node.type === "ident") return field(node.name);
    return ex(node);
  }

  const setup = [];
  const loop = [];
  const reqImpl = [];
  const reqNames = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === "assign" && stmt.right && stmt.right.type === "new") {
      const header = headers.find((h) => h.name === stmt.right.name);
      const cls = classes.find((c) => c.name === stmt.right.name);
      if (header) nativeVars.set(stmt.left.name, stmt.right);
      if (cls) classVars.set(stmt.left.name, stmt.right);
    }
    if (stmt.type === "lib") {
      for (const s of stmt.body) if (s.type === "req") reqNames.add(s.name);
    }
  }
  walk(ast, (node) => {
    if (node.type === "request") reqNames.add(node.name);
    if (node.type === "requestPut" && node.call && node.call.callee && node.call.callee.type === "ident") reqNames.add(node.call.callee.name);
  });

  for (const stmt of ast.body) {
    if (["func", "class", "import", "export"].includes(stmt.type)) continue;
    if (stmt.type === "loop") { for (const s of stmt.body) emitStmt(s, 1, loop); continue; }
    if (stmt.type === "lib") { for (const s of stmt.body) emitStmt(s, 1, setup); continue; }
    if (stmt.type === "assign" && stmt.right && stmt.right.type === "new" && (nativeVars.has(stmt.left.name) || classVars.has(stmt.left.name))) continue;
    emitStmt(stmt, 1, setup);
  }

  for (const stmt of ast.body) {
    if (stmt.type !== "lib") continue;
    for (const s of stmt.body) {
      if (s.type !== "req" || s.expr.type !== "func") continue;
      const fn = s.expr;
      const param = fn.params[0] || "p";
      reqImpl.push("void cin_req_impl_" + s.name + "(int " + cpp(param) + ") {");
      for (const body of fn.body) {
        if (body.type === "assign" && body.left.type === "var" && body.right.type === "bool") {
          reqImpl.push("  digitalWrite(" + cpp(param) + ", " + (body.right.value ? "HIGH" : "LOW") + ");");
        } else emitStmt(body, 1, reqImpl);
      }
      reqImpl.push("}");
    }
  }

  const declared = new Map();
  function noteKind(name, node) {
    if (!node) return;
    if (node.type === "string") declared.set(name, "string");
    else if (node.type === "array") declared.set(name, "array:" + node.items.length);
    else if (node.type === "bool" && declared.get(name) !== "string") declared.set(name, "bool");
    else if (!declared.has(name)) declared.set(name, "long");
  }
  function collectAssigned(body) {
    for (const s of body || []) {
      if (!s) continue;
      if (s.type === "assign" && s.left && s.left.type === "var" && !classVars.has(s.left.name) && !nativeVars.has(s.left.name)) noteKind(s.left.name, s.right);
      if (s.type === "if") { collectAssigned(s.then); for (const b of s.elifs || []) collectAssigned(b.body); collectAssigned(s.else); }
      if (s.type === "while" || s.type === "loop") collectAssigned(s.body);
    }
  }
  collectAssigned(ast.body);

  const out = [];
  out.push("/* Generated by CompIno " + VERSION + " from " + filename + " */");
  out.push("#include <Arduino.h>");
  for (const h of headers) out.push(h.from.includes("/") ? '#include "' + h.from + '"' : "#include <" + h.from + ">");
  if (features.has("poison")) out.push("static int cin_poison() { return 0; }");
  if (reqNames.size) {
    use("request");
    for (const name of reqNames) out.push("void (*cin_req_" + name + ")(int) = nullptr;");
    if (setup.some((l) => l.includes("cin_builtin_writable"))) out.push("void cin_builtin_writable(int p) { pinMode(p, OUTPUT); }");
    if (setup.some((l) => l.includes("cin_builtin_readable"))) out.push("void cin_builtin_readable(int p) { pinMode(p, INPUT); }");
  }
  for (const [name, expr] of nativeVars) {
    out.push(expr.name + " " + cpp(name) + ";");
    const pin = (expr.args || []).find((a) => a.type === "pin");
    if (expr.name === "Servo" && pin) setup.unshift("  " + cpp(name) + ".attach(" + pin.n + ");");
  }
  for (const [name, kind] of declared) {
    if (kind === "string") out.push("String " + cpp(name) + ";");
    else if (kind === "bool") out.push("bool " + cpp(name) + " = false;");
    else if (String(kind).startsWith("array:")) out.push("long " + cpp(name) + "[" + kind.split(":")[1] + "];");
    else out.push("long " + cpp(name) + " = 0;");
  }
  for (const fn of funcs) {
    out.push("long fn_" + fn.name + "(" + fn.params.map((p) => "long " + cpp(p)).join(", ") + ") {");
    const body = [];
    for (const s of fn.body) emitStmt(s, 1, body);
    if (!body.some((l) => l.includes("return "))) body.push("  return 0;");
    out.push(...body);
    out.push("}");
  }
  for (const cls of classes) out.push(...emitClass(cls));
  for (const [name, expr] of classVars) {
    const args = (expr.args || []).map((a) => a.type === "pin" ? String(a.n) : ex(a)).join(", ");
    out.push(expr.name + " " + cpp(name) + " = " + expr.name + "(" + args + ");");
  }
  out.push(...reqImpl);
  out.push("void setup() {");
  if (features.has("serial")) out.push("  Serial.begin(9600);");
  out.push(...(setup.length ? setup : ["  /* setup */"]));
  out.push("}");
  out.push("void loop() {");
  out.push(...(loop.length ? loop : ["  /* empty loop */"]));
  out.push("}");
  log.push("emitted features: " + [...features].join(", "));
  return { text: out.join("\n") + "\n", features: [...features] };

  function emitClass(cls) {
    const fields = cls.fields.slice();
    for (const m of cls.methods) {
      for (const s of m.body) {
        if (s.type === "assign" && s.left && (s.left.type === "ident" || s.left.type === "var") && String(s.left.name).startsWith("_")) {
          if (!fields.some((f) => f.name === s.left.name)) fields.push({ name: s.left.name, init: null });
        }
      }
    }
    const main = cls.methods.find((m) => field(m.name) === field(cls.main || ""));
    const text = [];
    text.push("class " + cls.name + " {");
    text.push("public:");
    for (const f of fields) text.push("  long " + field(f.name) + ";");
    text.push("  " + cls.name + "() {");
    for (const f of fields) text.push("    " + field(f.name) + " = " + (f.init ? ex(f.init) : "0") + ";");
    text.push("  }");
    if (main) {
      text.push("  " + cls.name + "(" + main.params.map((p) => "long " + cpp(p)).join(", ") + ") {");
      for (const f of fields) text.push("    " + field(f.name) + " = " + (f.init ? ex(f.init) : "0") + ";");
      for (const s of main.body) {
        if (s.type === "assign" && s.left.type === "ident") text.push("    " + field(s.left.name) + " = " + (s.right.type === "var" ? cpp(s.right.name) : ex(s.right)) + ";");
        else emitStmt(s, 2, text);
      }
      text.push("  }");
    }
    for (const m of cls.methods) {
      if (main && m === main) continue;
      text.push("  void " + field(m.name) + "(" + m.params.map((p) => "long " + cpp(p)).join(", ") + ") {");
      for (const s of m.body) {
        if (s.type === "requestPut") text.push("    cin_req_" + (s.call.callee.name) + "(" + field(s.value.name) + ");");
        else if (s.type === "request") text.push("    cin_req_" + s.name + "(" + pinArg(s.arg) + ");");
        else emitStmt(s, 2, text);
      }
      text.push("  }");
    }
    text.push("};");
    return text;
  }
}

module.exports = { compile, compileFile, CompileError, VERSION };
