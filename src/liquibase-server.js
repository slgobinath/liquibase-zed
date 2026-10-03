// Minimal LSP server for Liquibase changelogs:
//  - go-to-definition for `file:` / `file="..."` includes (resolved like the classpath),
//  - find-references for table and column names across the workspace,
//  - diagnostics for unknown keys in YAML changelogs.
const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");
const { validate } = require("./liquibase-validate.js");

const docs = new Map();
let roots = [];

const FILE_VALUE = /\b(?:file|path)\s*(?::|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#,}]+))/g;
const RESOURCE_ROOTS = ["", "src/main/resources", "src/test/resources"];

function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveTarget(value, docPath) {
  const bases = [];
  for (let dir = path.dirname(docPath); ; dir = path.dirname(dir)) {
    bases.push(dir);
    if (dir === path.dirname(dir)) break;
  }
  bases.push(...roots);
  for (const base of bases) {
    for (const sub of RESOURCE_ROOTS) {
      const candidate = path.join(base, sub, value.replace(/^classpath:/, ""));
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function definition(uri, position) {
  const text = docs.get(uri);
  if (text === undefined) return null;
  const line = text.split(/\r?\n/)[position.line] ?? "";
  FILE_VALUE.lastIndex = 0;
  let m;
  while ((m = FILE_VALUE.exec(line))) {
    const value = m[1] ?? m[2] ?? m[3];
    const start = m.index + m[0].lastIndexOf(value);
    if (position.character < start || position.character > start + value.length) continue;
    const target = resolveTarget(value, fileURLToPath(uri));
    if (!target) return null;
    const zero = { line: 0, character: 0 };
    return {
      uri: pathToFileURL(target).toString(),
      range: { start: zero, end: zero },
    };
  }
  return null;
}

// ---- find references --------------------------------------------------------------

const TABLE_KEYS = new Set(["tableName", "baseTableName", "referencedTableName", "oldTableName", "newTableName"]);
const COLUMN_KEYS = new Set(["columnName", "columnNames", "baseColumnNames", "referencedColumnNames", "oldColumnName", "newColumnName"]);
const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", "out", ".gradle", ".idea"]);
const CHANGELOG_EXT = /\.(ya?ml|xml|sql|json)$/i;

// Yields {kind, name, start, end} for every table/column name mentioned on a line.
function mentions(lines, i) {
  const line = lines[i];
  const out = [];
  const add = (kind, value, from) => {
    let offset = from;
    for (const part of value.split(",")) {
      const name = part.trim().replace(/^["'`]|["'`]$/g, "");
      if (name) {
        const start = line.indexOf(name, offset);
        if (start >= 0) out.push({ kind, name, start, end: start + name.length });
      }
      offset += part.length + 1;
    }
  };
  const kindOf = (key, nameIsColumn) =>
    TABLE_KEYS.has(key) ? "table" : COLUMN_KEYS.has(key) || (key === "name" && nameIsColumn) ? "column" : null;

  const yaml = /^(\s*(?:-\s+)*)([A-Za-z]+):\s+(\S.*?)\s*$/.exec(line);
  if (yaml) {
    let nameIsColumn = false;
    if (yaml[2] === "name") {
      const indent = yaml[1].length;
      for (let j = i - 1; j >= 0; j--) {
        const prev = /^(\s*(?:-\s+)*)(\S.*)$/.exec(lines[j]);
        if (!prev || prev[1].length >= indent) continue;
        nameIsColumn = /^column:\s*$/.test(prev[2]);
        break;
      }
      // `- column:` followed by `name:` on a deeper line, or `column:` directly above
    }
    const kind = kindOf(yaml[2], nameIsColumn);
    if (kind) add(kind, yaml[3], line.indexOf(yaml[3], yaml[0].indexOf(yaml[2]) + yaml[2].length));
  }
  const attr = /([A-Za-z]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attr.exec(line))) {
    const kind = kindOf(m[1], /<column\b/.test(line));
    if (kind) add(kind, m[2], m.index + m[0].indexOf('"') + 1);
  }
  return out;
}

function listChangelogFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length > 20000) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (CHANGELOG_EXT.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  roots.forEach(walk);
  return files;
}

function readText(file) {
  const open = docs.get(pathToFileURL(file).toString());
  if (open !== undefined) return open;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function references(uri, position) {
  const text = docs.get(uri);
  if (text === undefined) return null;
  const lines = text.split(/\r?\n/);
  const here = mentions(lines, position.line).find(
    (x) => position.character >= x.start && position.character <= x.end,
  );
  if (!here) return null;

  const results = [];
  for (const file of listChangelogFiles()) {
    const content = readText(file);
    if (content === null || !/databaseChangeLog|dbchangelog|liquibase/i.test(content)) continue;
    const fileLines = content.split(/\r?\n/);
    const fileUri = pathToFileURL(file).toString();
    for (let i = 0; i < fileLines.length; i++) {
      for (const x of mentions(fileLines, i)) {
        if (x.kind === here.kind && x.name === here.name) {
          results.push({
            uri: fileUri,
            range: { start: { line: i, character: x.start }, end: { line: i, character: x.end } },
          });
        }
      }
    }
  }
  return results;
}

// ---- diagnostics ------------------------------------------------------------------

const timers = new Map();
function publishDiagnostics(uri) {
  clearTimeout(timers.get(uri));
  timers.set(
    uri,
    setTimeout(() => {
      const text = docs.get(uri);
      if (text === undefined || !/\.ya?ml$/i.test(uri)) return;
      let diagnostics = [];
      try {
        diagnostics = validate(text);
      } catch {
        // never let a parser problem take the server down
      }
      send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
    }, 250),
  );
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      roots = (params.workspaceFolders || []).map((f) => fileURLToPath(f.uri));
      if (!roots.length && params.rootUri) roots = [fileURLToPath(params.rootUri)];
      send({
        id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true, referencesProvider: true },
          serverInfo: { name: "liquibase-server" },
        },
      });
      break;
    case "textDocument/didOpen":
      docs.set(params.textDocument.uri, params.textDocument.text);
      publishDiagnostics(params.textDocument.uri);
      break;
    case "textDocument/didChange":
      docs.set(params.textDocument.uri, params.contentChanges[params.contentChanges.length - 1].text);
      publishDiagnostics(params.textDocument.uri);
      break;
    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      break;
    case "textDocument/definition":
      send({ id, result: definition(params.textDocument.uri, params.position) });
      break;
    case "textDocument/references":
      send({ id, result: references(params.textDocument.uri, params.position) });
      break;
    case "shutdown":
      send({ id, result: null });
      break;
    case "exit":
      process.exit(0);
      break;
    default:
      if (id !== undefined) send({ id, result: null });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.slice(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
