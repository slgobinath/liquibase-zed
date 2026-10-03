// Keyword validation for Liquibase YAML changelogs, driven by liquibase-model.json
// (generated from dbchangelog-latest.xsd by tools/gen_model.py).
const YAML = require("yaml");
const model = require("./liquibase-model.json");

const attrs = (name) => new Set(model[name]?.attrs ?? []);
const children = (name) => new Set(model[name]?.children ?? []);

// YAML-only wrapper keys that hold a list of child elements.
const WRAPPERS = {
  changes: children("changeSet"),
  columns: new Set(["column"]),
  params: new Set(["param"]),
  where: new Set(),
};
// Keys that carry free text / values inside an element rather than structure.
const TEXT_KEYS = new Set(["rollback", "comment", "sql", "procedureText", "procedureBody", "text", "value", "path", "file"]);

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function suggest(key, candidates) {
  let best = null;
  let bestDist = Math.max(2, Math.floor(key.length / 3));
  for (const c of candidates) {
    const d = distance(key.toLowerCase(), c.toLowerCase());
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function validate(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, prettyErrors: false });
  const diagnostics = [];
  const pos = (offset) => {
    const { line, col } = lineCounter.linePos(offset);
    return { line: line - 1, character: col - 1 };
  };

  for (const err of doc.errors) {
    diagnostics.push({
      range: { start: pos(err.pos[0]), end: pos(err.pos[1]) },
      severity: 1,
      source: "liquibase",
      message: err.message.split("\n")[0],
    });
  }

  const root = doc.contents;
  if (!YAML.isMap(root)) return diagnostics;
  const top = root.items.find((p) => YAML.isScalar(p.key) && p.key.value === "databaseChangeLog");
  if (!top) return diagnostics; // not a changelog

  const report = (keyNode, message) => {
    const [start, end] = keyNode.range;
    diagnostics.push({
      range: { start: pos(start), end: pos(end) },
      severity: 2,
      source: "liquibase",
      message,
    });
  };

  const unknown = (keyNode, owner, allowed) => {
    const key = String(keyNode.value);
    const hint = suggest(key, allowed);
    report(
      keyNode,
      `Unknown key '${key}' in ${owner}` + (hint ? `. Did you mean '${hint}'?` : ""),
    );
  };

  // Checks the keys of one map belonging to element `name`.
  const checkKeys = (name, map, extraAllowed = new Set()) => {
    const a = attrs(name);
    const c = children(name);
    for (const pair of map.items) {
      if (!YAML.isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      if (a.has(key) || extraAllowed.has(key)) continue;
      if (c.has(key)) {
        checkElement(key, pair.value);
      } else if (WRAPPERS[key] !== undefined && YAML.isSeq(pair.value)) {
        for (const item of pair.value.items) checkItem(item, WRAPPERS[key], key);
      } else if (key === name || TEXT_KEYS.has(key)) {
        continue;
      } else {
        unknown(pair.key, `'${name}'`, [...a, ...c, ...Object.keys(WRAPPERS)]);
      }
    }
  };

  // An item of a list: a map whose keys are child elements (or attributes of the parent).
  const checkItem = (item, allowed, owner) => {
    if (!YAML.isMap(item)) return;
    for (const pair of item.items) {
      if (!YAML.isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      if (allowed.has(key)) checkElement(key, pair.value);
      else if (TEXT_KEYS.has(key)) continue;
      else unknown(pair.key, `'${owner}'`, [...allowed]);
    }
  };

  const checkElement = (name, value) => {
    if (!model[name]) return;
    if (YAML.isMap(value)) {
      checkKeys(name, value);
    } else if (YAML.isSeq(value)) {
      // e.g. preConditions / rollback / and: a list mixing attributes and child elements.
      const allowed = new Set([...children(name)]);
      for (const item of value.items) {
        if (!YAML.isMap(item)) continue;
        for (const pair of item.items) {
          if (!YAML.isScalar(pair.key)) continue;
          const key = String(pair.key.value);
          if (attrs(name).has(key) || TEXT_KEYS.has(key)) continue;
          if (allowed.has(key)) checkElement(key, pair.value);
          else unknown(pair.key, `'${name}'`, [...allowed, ...attrs(name)]);
        }
      }
    }
  };

  if (YAML.isSeq(top.value)) {
    const allowed = children("databaseChangeLog");
    for (const item of top.value.items) checkItem(item, allowed, "databaseChangeLog");
  }
  return diagnostics;
}

module.exports = { validate };
