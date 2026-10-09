"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = "0.1.0-beta.0";

const KEYWORDS = new Set([
  "func", "return", "if", "elif", "else", "while", "class", "new", "import",
  "from", "export", "writable", "readable", "and", "or", "xor", "Main",
  "request", "req", "typeof", "True", "False", "true", "false", "E", "Pin",
]);

function compileFile(filePath, options) {
  const opts = options || {};
  const source = fs.readFileSync(filePath, "utf8");
  const base = path.dirname(filePath);
  return compile(source, {
    filename: path.basename(filePath),
    baseDir: base,
    detailed: !!opts.detailed,
    isLib: filePath.endsWith(".cnl"),
  });
}

function compile(source, options) {
  const opts = options || {};
  const log = [];
  const filename = opts.filename || "sketch.cno";
  const tokens = tokenize(source, filename);
  if (opts.detailed) log.push("tokens: " + tokens.length);
  const ast = parse(tokens, filename);
  if (opts.detailed) log.push("statements: " + ast.body.length);
  const imported = loadImports(ast, opts.baseDir || process.cwd(), opts.detailed ? log : null);
  const code = generate(ast, {
    filename,
    imported,
    detailed: !!opts.detailed,
    log,
  });
  return { code, log, ast };
}

function loadImports(ast, baseDir, log) {
  const imported = [];
  for (const stmt of ast.body) {
    if (stmt.type !== "import") continue;
    const from = stmt.from;
    if (from.endsWith(".cnl")) {
      const full = path.resolve(baseDir, from);
      if (!fs.existsSync(full)) {
        throw new Error("Cannot import " + from + " (file not found: " + full + ")");
      }
      const src = fs.readFileSync(full, "utf8");
      const libAst = parse(tokenize(src, from), from);
      const classes = libAst.body.filter((s) => s.type === "class");
      const exported = new Set(
        libAst.body.filter((s) => s.type === "export").map((s) => s.name)
      );
      const picked = classes.filter((c) => exported.size === 0 || exported.has(c.name));
      const wanted = picked.find((c) => c.name === stmt.name) || picked[0];
      if (!wanted) throw new Error("No class " + stmt.name + " exported from " + from);
      imported.push({ kind: "cnl", name: stmt.name, cls: wanted, from });
      if (log) log.push("imported class " + wanted.name + " from " + from);
    } else {
      imported.push({ kind: "header", name: stmt.name, from });
      if (log) log.push("imported header " + stmt.name + " from " + from);
    }
  }
  return imported;
}

function tokenize(source, filename) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (type, value, l, c) => tokens.push({ type, value, line: l, col: c });

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      line++;
      col = 1;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      col++;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (ch === '"') {
      i++;
      col++;
      let s = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") {
          const n = source[i + 1];
          if (n === "n") s += "\n";
          else if (n === "t") s += "\t";
          else if (n === '"') s += '"';
          else if (n === "\\") s += "\\";
          else s += n || "";
          i += 2;
          col += 2;
          continue;
        }
        if (source[i] === "\n") {
          line++;
          col = 1;
        } else col++;
        s += source[i];
        i++;
      }
      if (source[i] !== '"') throw err(filename, startLine, startCol, "Unterminated string");
      i++;
      col++;
      push("string", s, startLine, startCol);
      continue;
    }
    if (ch === "$") {
      i++;
      col++;
      const id = readIdent(source, i);
      if (!id) throw err(filename, startLine, startCol, "Expected name after $");
      i += id.length;
      col += id.length;
      push("var", id, startLine, startCol);
      continue;
    }
    if (ch === "@" || ch === "~") {
      const analog = ch === "~";
      i++;
      col++;
      let num = "";
      while (i < source.length && /[0-9]/.test(source[i])) {
        num += source[i];
        i++;
        col++;
      }
      if (!num) throw err(filename, startLine, startCol, "Expected pin number");
      push(analog ? "apin" : "pin", Number(num), startLine, startCol);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] || ""))) {
      let num = "";
      while (i < source.length && /[0-9.]/.test(source[i])) {
        num += source[i];
        i++;
        col++;
      }
      push("number", Number(num), startLine, startCol);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const id = readIdent(source, i);
      i += id.length;
      col += id.length;
      if (id === "True" || id === "true") push("bool", true, startLine, startCol);
      else if (id === "False" || id === "false") push("bool", false, startLine, startCol);
      else if (KEYWORDS.has(id)) push(id, id, startLine, startCol);
      else push("ident", id, startLine, startCol);
      continue;
    }
    const two = source.slice(i, i + 3);
    const pair = source.slice(i, i + 2);
    if (two === "<=>") {
      push("swap", "<=>", startLine, startCol);
      i += 3;
      col += 3;
      continue;
    }
    if (pair === "==" || pair === "!=" || pair === ">=" || pair === "<=" || pair === "->" || pair === "=>" || pair === "+=" || pair === "-=" || pair === "*=" || pair === "/=" || pair === "%=") {
      push(pair, pair, startLine, startCol);
      i += 2;
      col += 2;
      continue;
    }
    const singles = {
      "=": "=",
      ">": ">",
      "<": "<",
      "+": "+",
      "-": "-",
      "*": "*",
      "/": "/",
      "%": "%",
      "!": "!",
      "(": "(",
      ")": ")",
      "{": "{",
      "}": "}",
      "[": "[",
      "]": "]",
      ",": ",",
      ".": ".",
      ":": ":",
      "&": "&",
    };
    if (singles[ch]) {
      push(ch, ch, startLine, startCol);
      i++;
      col++;
      continue;
    }
    throw err(filename, startLine, startCol, "Unexpected character " + JSON.stringify(ch));
  }
  tokens.push({ type: "eof", value: "", line, col });
  return tokens;
}

function readIdent(source, i) {
  let j = i;
  if (!/[A-Za-z_]/.test(source[j] || "")) return "";
  j++;
  while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
  return source.slice(i, j);
}

function err(filename, line, col, message) {
  return new Error(filename + ":" + line + ":" + col + " " + message);
}

function parse(tokens, filename) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const at = (type) => peek().type === type;
  const eat = (type) => {
    if (!at(type)) {
      const t = peek();
      throw err(filename, t.line, t.col, "Expected " + type + " but found " + t.type);
    }
    return next();
  };

  function parseProgram() {
    const body = [];
    while (!at("eof")) body.push(parseStatement());
    return { type: "program", body };
  }

  function parseBlock() {
    eat("{");
    const body = [];
    while (!at("}") && !at("eof")) body.push(parseStatement());
    eat("}");
    return body;
  }

  function parseStatement() {
    if (at("&")) {
      next();
      if (at("ident") && peek().value === "lib") {
        next();
        return { type: "lib", body: parseBlock() };
      }
      return { type: "loop", body: parseBlock() };
    }
    if (at("if")) return parseIf();
    if (at("while")) return parseWhile();
    if (at("func")) return parseFunc();
    if (at("class")) return parseClass();
    if (at("import")) return parseImport();
    if (at("export")) {
      next();
      const name = eat("ident").value;
      return { type: "export", name };
    }
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
      return { type: kind, pin };
    }
    if (at("req")) {
      next();
      const nameTok = next();
      const name = nameTok.value;
      eat("=");
      if (at("func")) {
        const fn = parseFunc();
        return { type: "req", name, expr: fn };
      }
      const expr = parseExpression();
      return { type: "req", name, expr };
    }
    if (at("request")) return parseRequest();
    if (at("Main")) {
      next();
      const name = at("ident") ? next().value : eat("var").value;
      return { type: "main", name };
    }
    if (at("var")) {
      const a = next();
      if (at(":")) {
        next();
        const b = eat("var");
        return { type: "chain", a: a.value, b: b.value, line: a.line };
      }
      if (at("->")) {
        next();
        const b = eat("var");
        return { type: "move", from: a.value, to: b.value, line: a.line };
      }
      if (at("swap")) {
        next();
        const b = eat("var");
        return { type: "swap", a: a.value, b: b.value, line: a.line };
      }
      if (at("=") || at("+=") || at("-=") || at("*=") || at("/=") || at("%=")) {
        const op = next().type;
        const right = parseExpression();
        return { type: "assign", left: { type: "var", name: a.value }, op, right, line: a.line };
      }
      p--;
    }
    if (at("ident") && tokens[p + 1] && tokens[p + 1].type === "(") {
      const name = peek().value;
      if (name.startsWith("_") || name === "ligar" || true) {
        const maybe = parseExpression();
        return { type: "expr", expr: maybe };
      }
    }
    const expr = parseExpression();
    if (at("=") || at("+=") || at("-=") || at("*=") || at("/=") || at("%=")) {
      const op = next().type;
      const right = parseExpression();
      return { type: "assign", left: expr, op, right, line: expr.line || 0 };
    }
    return { type: "expr", expr };
  }

  function parseIf() {
    const t = eat("if");
    eat("(");
    const cond = parseExpression();
    eat(")");
    const then = parseBlock();
    const elifs = [];
    while (at("elif")) {
      next();
      eat("(");
      const c = parseExpression();
      eat(")");
      elifs.push({ cond: c, body: parseBlock() });
    }
    let els = null;
    if (at("else")) {
      next();
      els = parseBlock();
    }
    return { type: "if", cond, then, elifs, else: els, line: t.line };
  }

  function parseWhile() {
    const t = eat("while");
    eat("(");
    const cond = parseExpression();
    eat(")");
    return { type: "while", cond, body: parseBlock(), line: t.line };
  }

  function parseFunc() {
    const t = eat("func");
    let name = "anon";
    if (at("ident") || at("var")) {
      name = next().value;
    }
    eat("(");
    const params = [];
    if (!at(")")) {
      params.push(eat("var").value);
      while (at(",")) {
        next();
        params.push(eat("var").value);
      }
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
      if (at("Main")) {
        next();
        main = at("ident") ? next().value : eat("var").value;
        continue;
      }
      if (at("func")) {
        methods.push(parseFunc());
        continue;
      }
      if (at("ident") && tokens[p + 1] && tokens[p + 1].type === "(") {
        const mname = next().value;
        eat("(");
        const params = [];
        if (!at(")")) {
          params.push(eat("var").value);
          while (at(",")) {
            next();
            params.push(eat("var").value);
          }
        }
        eat(")");
        methods.push({ type: "func", name: mname, params, body: parseBlock(), line: t.line });
        continue;
      }
      if (at("var") || at("ident")) {
        const tok = next();
        const fname = tok.value;
        if (at("=")) {
          next();
          fields.push({ name: fname, init: parseExpression() });
        } else {
          fields.push({ name: fname, init: null });
        }
        continue;
      }
      if (at("request")) {
        methods.push({ type: "func", name: "_request_stmt", params: [], body: [parseRequest()], line: t.line });
        continue;
      }
      const bad = peek();
      throw err(filename, bad.line, bad.col, "Unexpected token in class: " + bad.type);
    }
    eat("}");
    return { type: "class", name, fields, methods, main, line: t.line };
  }

  function parseImport() {
    eat("import");
    const name = eat("ident").value;
    eat("from");
    const from = eat("string").value;
    return { type: "import", name, from };
  }

  function parseRequest() {
    const t = eat("request");
    const nameToken = at("ident") || at("writable") || at("readable");
    if (nameToken && tokens[p + 1] && tokens[p + 1].type !== "=>") {
      const name = next().value;
      const arg = parseExpression();
      return { type: "request", name, arg, line: t.line };
    }
    const value = parsePostfix();
    if (at("=>")) {
      next();
      const call = parsePostfix();
      return { type: "requestPut", value, call, line: t.line };
    }
    return { type: "request", name: "anything", arg: value, line: t.line };
  }

  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (at("or") || at("xor")) {
      const op = next().type;
      const right = parseAnd();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseCmp();
    while (at("and")) {
      next();
      const right = parseCmp();
      left = { type: "binary", op: "and", left, right };
    }
    return left;
  }

  function parseCmp() {
    let left = parseAdd();
    while (at("==") || at("!=") || at(">") || at("<") || at(">=") || at("<=")) {
      const op = next().type;
      const right = parseAdd();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (at("+") || at("-")) {
      const op = next().type;
      const right = parseMul();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (at("*") || at("/") || at("%")) {
      const op = next().type;
      const right = parseUnary();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (at("!")) {
      const t = next();
      return { type: "unary", op: "!", expr: parseUnary(), line: t.line };
    }
    if (at("-") && (atNumberAhead())) {
      next();
      const n = eat("number");
      return { type: "number", value: -n.value, line: n.line };
    }
    return parsePut();
  }

  function atNumberAhead() {
    return tokens[p + 1] && tokens[p + 1].type === "number";
  }

  function parsePut() {
    let left = parsePostfix();
    if (at("=>")) {
      next();
      const right = parsePostfix();
      left = { type: "put", left, right };
    }
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
          while (at(",")) {
            next();
            args.push(parseExpression());
          }
        }
        eat(")");
        expr = { type: "call", callee: expr, args };
        continue;
      }
      if (at(".")) {
        next();
        const name = at("ident") ? next().value : eat("var").value;
        expr = { type: "member", object: expr, name };
        continue;
      }
      break;
    }
    return expr;
  }

  function parsePrimary() {
    const t = peek();
    if (at("number")) {
      next();
      return { type: "number", value: t.value, line: t.line };
    }
    if (at("string")) {
      next();
      return { type: "string", value: t.value, line: t.line };
    }
    if (at("bool")) {
      next();
      return { type: "bool", value: t.value, line: t.line };
    }
    if (at("E")) {
      next();
      return { type: "E", line: t.line };
    }
    if (at("var")) {
      next();
      return { type: "var", name: t.value, line: t.line };
    }
    if (at("pin")) {
      next();
      return { type: "pin", n: t.value, analog: false, line: t.line };
    }
    if (at("apin")) {
      next();
      return { type: "pin", n: t.value, analog: true, line: t.line };
    }
    if (at("typeof")) {
      next();
      eat("(");
      const expr = parseExpression();
      eat(")");
      return { type: "typeof", expr, line: t.line };
    }
    if (at("new")) {
      next();
      const name = eat("ident").value;
      eat("(");
      const args = [];
      if (!at(")")) {
        args.push(parseExpression());
        while (at(",")) {
          next();
          args.push(parseExpression());
        }
      }
      eat(")");
      return { type: "new", name, args, line: t.line };
    }
    if (at("[")) {
      next();
      const items = [];
      if (!at("]")) {
        items.push(parseExpression());
        while (at(",")) {
          next();
          if (at("]")) break;
          items.push(parseExpression());
        }
      }
      eat("]");
      return { type: "array", items, line: t.line };
    }
    if (at("(")) {
      next();
      const expr = parseExpression();
      eat(")");
      return expr;
    }
    if (at("ident") || at("writable") || at("readable")) {
      const tok = next();
      return { type: "ident", name: tok.value, line: tok.line };
    }
    throw err(filename, t.line, t.col, "Expected expression, found " + t.type);
  }

  return parseProgram();
}

function generate(ast, opts) {
  const imported = opts.imported || [];
  const lines = [];
  const indent = { n: 0 };
  const emit = (s) => lines.push("  ".repeat(indent.n) + s);
  const classes = [];
  const funcs = [];
  const setup = [];
  const loop = [];
  const reqFns = [];
  const globals = new Map();
  const kinds = new Map();
  const chains = new Map();
  const scopes = [];
  let tmpId = 0;
  const tmp = () => "cin_tmp_" + tmpId++;

  for (const item of imported) {
    if (item.kind === "cnl") classes.push(item.cls);
  }
  for (const stmt of ast.body) {
    if (stmt.type === "class") classes.push(stmt);
    if (stmt.type === "func") funcs.push(stmt);
  }

  function cppName(name) {
    return "v_" + String(name).replace(/[^A-Za-z0-9_]/g, "_");
  }
  function fieldName(name) {
    return String(name).replace(/^_/, "");
  }
  function fnName(name) {
    return "fn_" + String(name).replace(/[^A-Za-z0-9_]/g, "_");
  }
  function cstr(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
  }

  function declare(name) {
    const id = cppName(name);
    if (!globals.has(name)) globals.set(name, id);
    return globals.get(name);
  }

  function resolve(name) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return scopes[i].get(name);
    }
    if (chains.has(name)) return chains.get(name);
    return declare(name);
  }

  function expr(node) {
    if (!node) return "cE()";
    switch (node.type) {
      case "number":
        return "cNum(" + Number(node.value) + ")";
      case "string":
        return "cStr(" + cstr(node.value) + ")";
      case "bool":
        return "cBool(" + (node.value ? "true" : "false") + ")";
      case "E":
        return "cE()";
      case "var":
        return resolve(node.name);
      case "pin":
        return node.analog ? "cAPin(" + node.n + ")" : "cPin(" + node.n + ")";
      case "array": {
        const items = node.items.map(expr);
        const id = tmp();
        return "([&]() { CVal " + id + " = cArrayN(" + items.length + "); " +
          items.map((it, i) => id + ".arr.items[" + i + "] = " + it + ";").join(" ") +
          " return " + id + "; })()";
      }
      case "unary":
        if (node.op === "!") return "cNot(" + expr(node.expr) + ")";
        return expr(node.expr);
      case "binary":
        return bin(node.op, expr(node.left), expr(node.right));
      case "typeof":
        return "cStr(cTypeName(" + expr(node.expr) + "))";
      case "call":
        return callExpr(node);
      case "member":
        return memberExpr(node);
      case "new":
        return newExpr(node);
      case "put":
        return putExpr(node);
      case "ident": {
        if (node.name === "Pin") return 'cStr("Pin")';
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (scopes[i].has(node.name)) return scopes[i].get(node.name);
        }
        return fnName(node.name);
      }
      default:
        return "cE()";
    }
  }

  function bin(op, l, r) {
    const map = {
      "+": "cAdd",
      "-": "cSub",
      "*": "cMul",
      "/": "cDiv",
      "%": "cMod",
      "==": "cEq",
      "!=": "cNe",
      ">": "cGt",
      "<": "cLt",
      ">=": "cGe",
      "<=": "cLe",
      and: "cAnd",
      or: "cOr",
      xor: "cXor",
    };
    const fn = map[op];
    if (!fn) return "cE()";
    return fn + "(" + l + ", " + r + ")";
  }

  function callExpr(node) {
    const c = node.callee;
    if (c.type === "ident") {
      if (c.name === "map") return mapCall(node.args);
      if (c.name === "sleep") return "cSleep(" + expr(node.args[0] || { type: "number", value: 0 }) + ")";
      if (c.name === "serial") return "cSerial(" + expr(node.args[0] || { type: "string", value: "" }) + ")";
      if (c.name === "writable") return "cWritable(" + (node.args[0] ? expr(node.args[0]) : "cE()") + ")";
      if (c.name === "readable") return "cReadable(" + (node.args[0] ? expr(node.args[0]) : "cE()") + ")";
      if (c.name === "high") return "cHigh(" + (node.args[0] ? expr(node.args[0]) : "cE()") + ")";
      if (c.name === "low") return "cLow(" + (node.args[0] ? expr(node.args[0]) : "cE()") + ")";
      return fnName(c.name) + "(" + node.args.map(expr).join(", ") + ")";
    }
    if (c.type === "member") {
      const obj = c.object;
      const method = c.name;
      if (obj.type === "var") {
        const native = kinds.get(obj.name) === "native";
        const args = (native ? node.args.map(rawArg) : node.args.map(expr)).join(", ");
        return resolve(obj.name) + "." + method + "(" + args + ")";
      }
      return "(" + expr(obj) + ")." + method + "(" + node.args.map(expr).join(", ") + ")";
    }
    return "cE()";
  }

  function rawArg(node) {
    if (node.type === "pin") return String(node.n);
    if (node.type === "number") return String(node.value);
    if (node.type === "string") return cstr(node.value);
    if (node.type === "bool") return node.value ? "true" : "false";
    return "cAsNum(" + expr(node) + ")";
  }

  function mapCall(args) {
    if (args.length >= 5) {
      return "cMap(" + args.slice(0, 5).map(expr).join(", ") + ")";
    }
    if (args.length === 4) {
      return "cMap(" + expr(args[0]) + ", " + expr(args[1]) + ", " + expr(args[2]) + ", cNum(0), " + expr(args[3]) + ")";
    }
    return "cE()";
  }

  function memberExpr(node) {
    if (node.object.type === "var") {
      return resolve(node.object.name) + "." + node.name;
    }
    return "(" + expr(node.object) + ")." + node.name;
  }

  function newExpr(node) {
    const header = imported.find((i) => i.kind === "header" && i.name === node.name);
    if (header) {
      return "/* native " + node.name + " constructed in setup */ cE()";
    }
    return node.name + "(" + node.args.map(expr).join(", ") + ")";
  }

  function putExpr(node) {
    const right = node.right;
    if (right.type === "call" || right.type === "ident") {
      const name = right.type === "ident" ? right.name : right.callee.type === "ident" ? right.callee.name : null;
      if (name) {
        return "cPutCall(" + expr(node.left) + ", " + fnName(name) + ")";
      }
    }
    return "cPut(" + expr(node.left) + ", " + expr(right) + ")";
  }

  function emitStmt(stmt, bucket) {
    const into = (s) => bucket.push(s);
    switch (stmt.type) {
      case "assign": {
        const right = stmt.op === "=" ? expr(stmt.right) : compound(stmt);
        if (stmt.left.type === "var") {
          const id = resolve(stmt.left.name);
          into("cSet(" + id + ", " + right + ");");
        } else if (stmt.left.type === "pin") {
          if (stmt.left.analog) into("cWriteAPin(" + stmt.left.n + ", " + right + ");");
          else into("cWritePin(" + stmt.left.n + ", " + right + ");");
        } else if (stmt.left.type === "ident") {
          into(resolve(stmt.left.name) + " = " + right + ";");
        } else if (stmt.left.type === "member" && stmt.left.object.type === "var") {
          into(resolve(stmt.left.object.name) + "." + stmt.left.name + " = " + right + ";");
        } else {
          into("cSet(" + expr(stmt.left) + ", " + right + ");");
        }
        break;
      }
      case "move": {
        const from = resolve(stmt.from);
        const to = resolve(stmt.to);
        into("cSet(" + to + ", " + from + ");");
        into("cPoison(" + from + ");");
        break;
      }
      case "swap": {
        const a = resolve(stmt.a);
        const b = resolve(stmt.b);
        const t = tmp();
        into("{ CVal " + t + " = " + a + "; cSet(" + a + ", " + b + "); cSet(" + b + ", " + t + "); }");
        break;
      }
      case "chain": {
        if (chains.has(stmt.a) || chains.has(stmt.b)) {
          throw new Error("fixed chain");
        }
        const id = declare(stmt.a);
        chains.set(stmt.b, id);
        chains.set(stmt.a, id);
        globals.set(stmt.b, id);
        into("/* chain $" + stmt.a + " : $" + stmt.b + " */");
        break;
      }
      case "expr":
        into(expr(stmt.expr) + ";");
        break;
      case "return":
        into("return " + (stmt.expr ? expr(stmt.expr) : "cE()") + ";");
        break;
      case "writable":
        into("cWritable(" + expr(stmt.pin) + ");");
        break;
      case "readable":
        into("cReadable(" + expr(stmt.pin) + ");");
        break;
      case "if": {
        into("if (cTruthy(" + expr(stmt.cond) + ")) {");
        for (const s of stmt.then) emitStmt(s, bucket.map ? bucket : inner(bucket));
        // re-emit properly below
        break;
      }
      default:
        break;
    }
  }

  function compound(stmt) {
    const op = stmt.op[0];
    const left = expr(stmt.left);
    const right = expr(stmt.right);
    return bin(op, left, right);
  }

  function emitBlock(body, pad) {
    const out = [];
    for (const stmt of body) emitSmart(stmt, out, pad);
    return out;
  }

  function emitSmart(stmt, out, pad) {
    const pfx = pad || "";
    if (stmt.type === "if") {
      out.push(pfx + "if (cTruthy(" + expr(stmt.cond) + ")) {");
      out.push(...emitBlock(stmt.then, pfx + "  "));
      for (const branch of stmt.elifs || []) {
        out.push(pfx + "} else if (cTruthy(" + expr(branch.cond) + ")) {");
        out.push(...emitBlock(branch.body, pfx + "  "));
      }
      if (stmt.else) {
        out.push(pfx + "} else {");
        out.push(...emitBlock(stmt.else, pfx + "  "));
      }
      out.push(pfx + "}");
      return;
    }
    if (stmt.type === "while") {
      out.push(pfx + "while (cTruthy(" + expr(stmt.cond) + ")) {");
      out.push(...emitBlock(stmt.body, pfx + "  "));
      out.push(pfx + "}");
      return;
    }
    if (stmt.type === "request") {
      out.push(pfx + "cin_req_" + stmt.name + "(" + expr(stmt.arg) + ");");
      return;
    }
    if (stmt.type === "requestPut") {
      const call = stmt.call;
      const name = call.type === "call" && call.callee.type === "ident" ? call.callee.name : "anything";
      out.push(pfx + "cin_req_" + name + "(" + expr(stmt.value) + ");");
      return;
    }
    if (stmt.type === "req") {
      if (stmt.expr.type === "call" && stmt.expr.callee.type === "ident" && (stmt.expr.callee.name === "writable" || stmt.expr.callee.name === "readable")) {
        out.push(pfx + "cin_req_" + stmt.name + " = cin_builtin_" + stmt.expr.callee.name + ";");
      } else if (stmt.expr.type === "ident" && (stmt.expr.name === "writable" || stmt.expr.name === "readable")) {
        out.push(pfx + "cin_req_" + stmt.name + " = cin_builtin_" + stmt.expr.name + ";");
      } else if (stmt.expr.type === "func") {
        const impl = "cin_req_impl_" + stmt.name;
        reqFns.push({ name: stmt.name, expr: stmt.expr, impl });
        out.push(pfx + "cin_req_" + stmt.name + " = " + impl + ";");
      } else {
        const impl = "cin_req_impl_" + stmt.name;
        reqFns.push({ name: stmt.name, expr: stmt.expr, impl });
        out.push(pfx + "cin_req_" + stmt.name + " = " + impl + ";");
      }
      return;
    }
    const bucket = [];
    emitStmt(stmt, bucket);
    for (const line of bucket) out.push(pfx + line);
  }

  function collectAssignTargets(body, set) {
    for (const stmt of body || []) {
      if (!stmt) continue;
      if (stmt.type === "assign" && stmt.left && stmt.left.type === "var") set.add(stmt.left.name);
      if (stmt.type === "move") {
        set.add(stmt.from);
        set.add(stmt.to);
      }
      if (stmt.type === "swap" || stmt.type === "chain") {
        set.add(stmt.a);
        set.add(stmt.b);
      }
      if (stmt.type === "if") {
        collectAssignTargets(stmt.then, set);
        for (const b of stmt.elifs || []) collectAssignTargets(b.body, set);
        collectAssignTargets(stmt.else, set);
      }
      if (stmt.type === "while") collectAssignTargets(stmt.body, set);
      if (stmt.type === "loop" || stmt.type === "lib") collectAssignTargets(stmt.body, set);
      if (stmt.type === "func") collectAssignTargets(stmt.body, set);
    }
  }

  const assigned = new Set();
  collectAssignTargets(ast.body, assigned);
  for (const name of assigned) declare(name);

  const headerIncludes = [];
  const nativeSetup = [];
  const nativeGlobals = [];
  for (const item of imported) {
    if (item.kind !== "header") continue;
    const inc = item.from.includes("/") ? '#include "' + item.from + '"' : "#include <" + item.from + ">";
    headerIncludes.push(inc);
  }

  for (const stmt of ast.body) {
    if (stmt.type !== "assign") continue;
    if (stmt.right && stmt.right.type === "new") {
      const header = imported.find((i) => i.kind === "header" && i.name === stmt.right.name);
      if (header && stmt.left.type === "var") {
        const id = declare(stmt.left.name);
        kinds.set(stmt.left.name, "native");
        nativeGlobals.push(stmt.right.name + " " + id + ";");
        globals.set(stmt.left.name, id);
        const pinArg = (stmt.right.args || []).find((a) => a.type === "pin");
        if (stmt.right.name === "Servo" && pinArg) {
          nativeSetup.push(id + ".attach(" + pinArg.n + ");");
        } else if (stmt.right.args && stmt.right.args.length) {
          nativeSetup.push("/* constructed " + stmt.right.name + " */");
        }
      }
    }
    if (stmt.right && stmt.right.type === "new" && stmt.left.type === "var") {
      const cls = classes.find((c) => c.name === stmt.right.name);
      if (cls) {
        const id = declare(stmt.left.name);
        kinds.set(stmt.left.name, "class");
        nativeGlobals.push(cls.name + " " + id + " = " + cls.name + "(" + stmt.right.args.map(expr).join(", ") + ");");
      }
    }
  }

  function collectFieldWrites(stmt, fields) {
    if (!stmt) return;
    if (stmt.type === "assign" && stmt.left && (stmt.left.type === "ident" || stmt.left.type === "var")) {
      const n = stmt.left.name;
      if (String(n).startsWith("_") && !fields.some((f) => f.name === n || fieldName(f.name) === fieldName(n))) {
        fields.push({ name: n, init: null });
      }
    }
    if (stmt.type === "if") {
      for (const s of stmt.then) collectFieldWrites(s, fields);
      for (const b of stmt.elifs || []) for (const s of b.body) collectFieldWrites(s, fields);
      for (const s of stmt.else || []) collectFieldWrites(s, fields);
    }
    if (stmt.type === "while") for (const s of stmt.body) collectFieldWrites(s, fields);
    if (stmt.type === "requestPut" && stmt.value && stmt.value.type === "ident" && String(stmt.value.name).startsWith("_")) {
      const n = stmt.value.name;
      if (!fields.some((f) => f.name === n)) fields.push({ name: n, init: null });
    }
  }

  function emitClass(cls) {
    const out = [];
    out.push("class " + cls.name + " {");
    out.push("public:");
    const fields = cls.fields.slice();
    for (const m of cls.methods) {
      for (const s of m.body) collectFieldWrites(s, fields);
    }
    for (const f of fields) out.push("  CVal " + fieldName(f.name) + ";");
    const mainMethod = cls.methods.find((m) => m.name === cls.main || fieldName(m.name) === fieldName(cls.main || "_"));
    const ctorBody = (method) => {
      const scope = new Map();
      for (const p of method ? method.params : []) scope.set(p, cppName(p));
      for (const f of fields) {
        scope.set(f.name, fieldName(f.name));
        if (fieldName(f.name) !== f.name && !scope.has(fieldName(f.name))) {
          scope.set(fieldName(f.name), fieldName(f.name));
        }
      }
      scopes.push(scope);
      const lines = [];
      for (const f of fields) {
        if (f.init) lines.push("    " + fieldName(f.name) + " = " + expr(f.init) + ";");
        else lines.push("    " + fieldName(f.name) + " = cE();");
      }
      if (method) lines.push(...emitBlock(method.body, "    "));
      scopes.pop();
      return lines;
    };
    out.push("  " + cls.name + "() {");
    out.push(...ctorBody(null));
    out.push("  }");
    if (mainMethod) {
      const params = mainMethod.params.map((p) => "CVal " + cppName(p)).join(", ");
      out.push("  " + cls.name + "(" + params + ") {");
      out.push(...ctorBody(mainMethod));
      out.push("  }");
    }
    for (const m of cls.methods) {
      if (mainMethod && m === mainMethod) continue;
      const params = m.params.map((p) => "CVal " + cppName(p)).join(", ");
      const scope = new Map();
      for (const p of m.params) scope.set(p, cppName(p));
      for (const f of fields) {
        scope.set(f.name, fieldName(f.name));
        if (!scope.has(fieldName(f.name))) scope.set(fieldName(f.name), fieldName(f.name));
        if (!scope.has("_" + fieldName(f.name))) scope.set("_" + fieldName(f.name), fieldName(f.name));
      }
      scopes.push(scope);
      out.push("  CVal " + fieldName(m.name) + "(" + params + ") {");
      const body = emitBlock(m.body, "    ");
      if (!body.some((l) => l.includes("return "))) body.push("    return cBool(true);");
      out.push(...body);
      out.push("  }");
      scopes.pop();
    }
    out.push("};");
    return out;
  }
  function fieldNameSafe(n) { return n; }
  function fName() { return ""; }

  function rewriteFieldAssigns(text, fields) {
    return text;
  }

  const classLines = [];
  for (const cls of classes) classLines.push(...emitClass(cls), "");

  const funcLines = [];
  for (const fn of funcs) {
    const params = fn.params.map((p) => "CVal " + cppName(p)).join(", ");
    const scope = new Map();
    for (const p of fn.params) scope.set(p, cppName(p));
    scopes.push(scope);
    funcLines.push("CVal " + fnName(fn.name) + "(" + params + ") {");
    const body = emitBlock(fn.body, "  ");
    if (!body.some((l) => l.includes("return "))) body.push("  return cE();");
    funcLines.push(...body);
    funcLines.push("}");
    funcLines.push("");
    scopes.pop();
  }

  const setupLines = [];
  const loopLines = [];
  const libLines = [];
  for (const stmt of ast.body) {
    if (stmt.type === "loop") setupLines.push(...[]); 
    if (stmt.type === "func" || stmt.type === "class" || stmt.type === "import" || stmt.type === "export") continue;
    if (stmt.type === "loop") {
      loopLines.push(...emitBlock(stmt.body, "  "));
      continue;
    }
    if (stmt.type === "lib") {
      libLines.push(...emitBlock(stmt.body, "  "));
      continue;
    }
    if (stmt.type === "assign" && stmt.right && stmt.right.type === "new") {
      const header = imported.some((i) => i.kind === "header" && i.name === stmt.right.name);
      const cls = classes.some((c) => c.name === stmt.right.name);
      if (header || cls) continue;
    }
    setupLines.push(...emitBlock([stmt], "  "));
  }

  const reqNames = new Set(["writable", "readable", "high", "low", "anything"]);
  for (const stmt of ast.body) {
    if (stmt.type === "lib") {
      for (const s of stmt.body) if (s.type === "req") reqNames.add(s.name);
    }
  }
  walkRequests(ast.body, reqNames);
  for (const cls of classes) walkRequests([cls], reqNames);

  const reqImpls = [];
  for (const req of reqFns) {
    if (!req.expr || req.expr.type !== "func") continue;
    const fn = req.expr;
    const scope = new Map();
    for (const p of fn.params) scope.set(p, cppName(p));
    scopes.push(scope);
    reqImpls.push("void cin_req_impl_" + req.name + "(" + fn.params.map((p) => "CVal " + cppName(p)).join(", ") + ") {");
    const body = emitBlock(fn.body, "  ");
    reqImpls.push(...(body.length ? body : ["  /* empty request */"]));
    reqImpls.push("}");
    scopes.pop();
  }

  const output = [];
  output.push("/* Generated by CompIno " + VERSION + " from " + opts.filename + " */");
  output.push("#include <Arduino.h>");
  for (const inc of headerIncludes) output.push(inc);
  output.push(runtime());
  for (const name of reqNames) {
    output.push("void (*cin_req_" + name + ")(CVal) = nullptr;");
  }
  output.push("void cin_builtin_writable(CVal p) { cWritable(p); }");
  output.push("void cin_builtin_readable(CVal p) { cReadable(p); }");
  output.push("");
  for (const g of nativeGlobals) output.push(g);
  const seen = new Set();
  for (const [name, id] of globals) {
    if (kinds.get(name) === "native" || kinds.get(name) === "class") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    output.push("CVal " + id + " = cE(); /* $" + name + " */");
  }
  output.push("");
  output.push(...classLines);
  output.push(...funcLines);
  output.push(...reqImpls);
  output.push("void setup() {");
  output.push("  Serial.begin(9600);");
  for (const line of nativeSetup) output.push("  " + line);
  for (const line of setupLines) output.push(line);
  for (const line of libLines) output.push(line);
  output.push("}");
  output.push("");
  output.push("void loop() {");
  if (loopLines.length === 0) output.push("  /* empty loop */");
  for (const line of loopLines) output.push(line);
  output.push("}");
  output.push("");
  return output.join("\n");
}

function walkRequests(body, set) {
  for (const stmt of body || []) {
    if (!stmt) continue;
    if (stmt.type === "request") set.add(stmt.name);
    if (stmt.type === "requestPut" && stmt.call && stmt.call.type === "call" && stmt.call.callee.type === "ident") {
      set.add(stmt.call.callee.name);
    }
    if (stmt.type === "if") {
      walkRequests(stmt.then, set);
      for (const b of stmt.elifs || []) walkRequests(b.body, set);
      walkRequests(stmt.else, set);
    }
    if (stmt.type === "while" || stmt.type === "loop" || stmt.type === "lib" || stmt.type === "func") {
      walkRequests(stmt.body, set);
    }
    if (stmt.type === "class") {
      for (const m of stmt.methods) walkRequests(m.body, set);
    }
  }
}

function genReqFunc(req) {
  if (!req.expr || req.expr.type !== "func") return [];
  return genInlineFunc(req.name, req.expr);
}

function genInlineFunc(name, exprNode) {
  const fn = exprNode;
  const params = (fn.params || ["p"]).map((p) => "CVal " + "v_" + p).join(", ");
  const lines = ["void cin_req_impl_" + name + "(" + (params || "CVal p") + ") {"];
  lines.push("  /* request handler " + name + " */");
  lines.push("}");
  return lines;
}

function runtime() {
  return `
struct CArr;
struct CVal;

struct CArr {
  CVal* items;
  int len;
};

enum CType { C_E = 0, C_NUM, C_STR, C_BOOL, C_ARR, C_OBJ };

struct CVal {
  CType type;
  double num;
  String str;
  bool boolean;
  int pin;
  bool analog;
  CArr arr;
  String objName;
  CVal() : type(C_E), num(0), boolean(false), pin(-1), analog(false) { arr.items = nullptr; arr.len = 0; }
};

static CVal cE() { return CVal(); }
static CVal cNum(double n) { CVal v; v.type = C_NUM; v.num = n; v.boolean = n != 0; return v; }
static CVal cBool(bool b) { CVal v; v.type = C_BOOL; v.boolean = b; v.num = b ? 1 : 0; return v; }
static CVal cStr(const String& s) { CVal v; v.type = C_STR; v.str = s; v.boolean = s.length() > 0; return v; }
static CVal cPin(int n) { CVal v = cNum(0); v.pin = n; v.analog = false; v.objName = "Pin"; return v; }
static CVal cAPin(int n) { CVal v = cNum(analogRead(n)); v.pin = n; v.analog = true; v.objName = "Pin"; return v; }
static bool cIsE(const CVal& v) { return v.type == C_E; }
static double cAsNum(const CVal& v) { return v.type == C_STR ? v.str.toDouble() : v.num; }
static bool cTruthy(const CVal& v) {
  if (v.pin >= 0 && !v.analog) return digitalRead(v.pin) == HIGH;
  if (v.pin >= 0 && v.analog) return analogRead(v.pin) > 0;
  if (v.type == C_E) return false;
  if (v.type == C_BOOL) return v.boolean;
  if (v.type == C_STR) return v.str.length() > 0;
  if (v.type == C_ARR) return v.arr.len > 0;
  return v.num != 0;
}
static const char* cTypeName(const CVal& v) {
  if (v.type == C_E) return "E";
  if (v.pin >= 0) return "Pin";
  if (v.type == C_STR) return "string";
  if (v.type == C_BOOL) return "bool";
  if (v.type == C_ARR) return "array";
  if (v.type == C_OBJ) return "class";
  return "number";
}
static void cPoison(CVal& v) { v = cE(); }
static void cWritePin(int pin, const CVal& value) { digitalWrite(pin, cTruthy(value) ? HIGH : LOW); }
static void cWriteAPin(int pin, const CVal& value) { analogWrite(pin, (int)cAsNum(value)); }
static void cSet(CVal& slot, const CVal& value) {
  if (value.type == C_E) { slot = cE(); return; }
  if (slot.pin >= 0) {
    if (slot.analog) analogWrite(slot.pin, (int)cAsNum(value));
    else digitalWrite(slot.pin, cTruthy(value) ? HIGH : LOW);
    int pin = slot.pin; bool analog = slot.analog;
    slot = value; slot.pin = pin; slot.analog = analog; slot.objName = "Pin";
    return;
  }
  slot = value;
}
static CVal cWritable(const CVal& p) { if (p.pin >= 0) pinMode(p.pin, OUTPUT); return p; }
static CVal cReadable(const CVal& p) { if (p.pin >= 0) pinMode(p.pin, INPUT); return p; }
static CVal cHigh(const CVal& p) { if (p.pin >= 0) digitalWrite(p.pin, HIGH); return cBool(true); }
static CVal cLow(const CVal& p) { if (p.pin >= 0) digitalWrite(p.pin, LOW); return cBool(false); }
static CVal cSleep(const CVal& ms) { delay((unsigned long)cAsNum(ms)); return ms; }
static CVal cSerial(const CVal& v) {
  if (v.type == C_E) Serial.println("[E]");
  else if (v.type == C_STR) Serial.println(v.str);
  else if (v.type == C_BOOL) Serial.println(v.boolean ? "True" : "False");
  else Serial.println(v.num);
  return v;
}
static CVal cMap(const CVal& v, const CVal& a, const CVal& b, const CVal& c, const CVal& d) {
  return cNum(map((long)cAsNum(v), (long)cAsNum(a), (long)cAsNum(b), (long)cAsNum(c), (long)cAsNum(d)));
}
static CVal cAdd(const CVal& a, const CVal& b) {
  if (cIsE(a) || cIsE(b)) return cE();
  if (a.type == C_STR || b.type == C_STR) return cStr(a.type == C_STR ? a.str + String(cAsNum(b)) : String(cAsNum(a)) + b.str);
  return cNum(cAsNum(a) + cAsNum(b));
}
static CVal cSub(const CVal& a, const CVal& b) { if (cIsE(a) || cIsE(b)) return cE(); return cNum(cAsNum(a) - cAsNum(b)); }
static CVal cMul(const CVal& a, const CVal& b) { if (cIsE(a) || cIsE(b)) return cE(); return cNum(cAsNum(a) * cAsNum(b)); }
static CVal cDiv(const CVal& a, const CVal& b) { if (cIsE(a) || cIsE(b) || cAsNum(b) == 0) return cE(); return cNum(cAsNum(a) / cAsNum(b)); }
static CVal cMod(const CVal& a, const CVal& b) { if (cIsE(a) || cIsE(b) || cAsNum(b) == 0) return cE(); return cNum((long)cAsNum(a) % (long)cAsNum(b)); }
static CVal cEq(const CVal& a, const CVal& b) {
  if (a.type == C_STR || b.type == C_STR) return cBool(a.str == b.str);
  return cBool(cAsNum(a) == cAsNum(b));
}
static CVal cNe(const CVal& a, const CVal& b) { return cBool(!cTruthy(cEq(a, b))); }
static CVal cGt(const CVal& a, const CVal& b) { return cBool(cAsNum(a) > cAsNum(b)); }
static CVal cLt(const CVal& a, const CVal& b) { return cBool(cAsNum(a) < cAsNum(b)); }
static CVal cGe(const CVal& a, const CVal& b) { return cBool(cAsNum(a) >= cAsNum(b)); }
static CVal cLe(const CVal& a, const CVal& b) { return cBool(cAsNum(a) <= cAsNum(b)); }
static CVal cAnd(const CVal& a, const CVal& b) { return cBool(cTruthy(a) && cTruthy(b)); }
static CVal cOr(const CVal& a, const CVal& b) { return cBool(cTruthy(a) || cTruthy(b)); }
static CVal cXor(const CVal& a, const CVal& b) { return cBool(cTruthy(a) != cTruthy(b)); }
static CVal cNot(const CVal& a) { return cBool(!cTruthy(a)); }
static CVal cArrayN(int n) {
  CVal v; v.type = C_ARR; v.arr.len = n; v.arr.items = new CVal[n > 0 ? n : 1];
  for (int i = 0; i < n; i++) v.arr.items[i] = cE();
  return v;
}
static CVal cPut(const CVal& left, const CVal& right) {
  if (cIsE(left) || cIsE(right)) return cE();
  if (right.type == C_NUM && left.type == C_ARR) {
    double s = cAsNum(right);
    for (int i = 0; i < left.arr.len; i++) s += cAsNum(left.arr.items[i]);
    return cNum(s);
  }
  if (right.type == C_STR) {
    String s = right.str;
    if (left.type == C_ARR) { for (int i = 0; i < left.arr.len; i++) s = String(cAsNum(left.arr.items[i])) + s; return cStr(s); }
    return cStr(left.str + right.str);
  }
  if (right.type == C_ARR) {
    CVal v = right;
    return v;
  }
  return right;
}
typedef CVal (*CFn)(CVal);
static CVal cPutCall(const CVal& left, CFn fn) {
  if (!fn || cIsE(left)) return cE();
  if (left.type == C_ARR) {
    CVal acc = cE();
    for (int i = 0; i < left.arr.len; i++) acc = fn(left.arr.items[i]);
    return acc;
  }
  return fn(left);
}
`.trim();
}

module.exports = { compile, compileFile, tokenize, parse, VERSION };
