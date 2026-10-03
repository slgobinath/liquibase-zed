# liquibase-zed

[Liquibase](https://www.liquibase.com) changelog support for the [Zed](https://zed.dev) editor:
syntax highlighting for XML, YAML and formatted-SQL changelogs, plus language servers for
validation, completion, go-to-definition and find-references.

## Features

| | XML | YAML | Formatted SQL |
|---|:-:|:-:|:-:|
| Syntax highlighting | yes | yes | yes, including `--changeset` / `--rollback` directives |
| Validation | XSD validation (LemMinX) | unknown-key warnings with "did you mean" hints | no |
| Completion and hover | from the Liquibase XSD | from the SchemaStore Liquibase schema | no |
| Go to definition on `file:` includes | yes | yes | no |
| Find references for tables and columns | yes | yes | no |

### Go to definition on includes

`cmd+click` on an include path jumps to the file:

```yaml
- include:
    file: db/changelog/reference/tag.yaml   # cmd+click works here
```

Liquibase resolves these paths from the classpath, so they usually don't exist relative to the
project root. The server tries every parent folder of the changelog, then `src/main/resources`
and `src/test/resources` under each parent and under each workspace folder. A leading
`classpath:` prefix is ignored.

### Find references

Place the cursor on a table or column name and run "Find all references". It searches every
`.yaml`, `.yml`, `.xml`, `.sql` and `.json` changelog in the workspace.

- **Tables:** `tableName`, `baseTableName`, `referencedTableName`, `oldTableName`, `newTableName`
- **Columns:** `columnName`, `columnNames`, `baseColumnNames`, `referencedColumnNames`,
  `oldColumnName`, `newColumnName`, and `name` inside a `column`

Matching is by name only. A column name shared by several tables lists the matches in all of them.

### Unknown-key warnings (YAML)

```yaml
databaseChangeLog:
  - changeSet:
      id: 1
      auther: me          # Unknown key 'auther' in 'changeSet'. Did you mean 'author'?
      changes:
        - createTabel:    # Unknown key 'createTabel' in 'changes'. Did you mean 'createTable'?
```

The check is driven by a keyword list generated from Liquibase's official
`dbchangelog-latest.xsd`, so it knows every change type and its attributes. It only runs on files
with a top-level `databaseChangeLog:` key.

The SchemaStore Liquibase JSON schema is not used for validation. It allows any extra key, so it
never flags typos, and it rejects valid changelogs such as numeric changeSet ids. It is still used
for completion and hover.

Known limits:

- A misspelled wrapper key such as `colums:` is reported, but its contents are not checked.
- Values are not type-checked, only keys.
- `rollback:` inside a change such as `sql:` is accepted even though the XSD doesn't list it,
  because Liquibase accepts it.

## Install

The extension is not in the Zed registry yet. To install it as a dev extension, clone this repository and:

1. Install Rust with `rustup`. Zed compiles the extension itself.
2. In Zed, open the command palette and run `zed: install dev extension`.
3. Select the cloned `liquibase-zed` folder.

On first use the extension downloads what the servers need, so it needs network access once:

- **LemMinX** (XML) is downloaded from the
  [`redhat-developer/vscode-xml`](https://github.com/redhat-developer/vscode-xml/releases) releases.
  If `lemminx` is already on your `PATH`, that one is used instead.
- **yaml-language-server** and **yaml** are installed from npm using Zed's bundled Node.

## Make Zed open your files as Liquibase

Zed picks a language from the filename. An extension can match filename suffixes but not folders,
and Zed's built-in YAML, XML and SQL languages take priority over a first-line check.

Files are detected automatically when their name ends with:

- XML: `changelog.xml`, `changelog-master.xml`, `changelog-root.xml`, `liquibase.xml`
- YAML: `changelog.yaml`, `changelog-master.yaml`, `changelog-root.yaml` (and `.yml`)
- SQL: `changelog.sql`

Every other file stays plain YAML, XML or SQL, with no Liquibase servers attached. For typical
layouts such as `src/main/resources/db/changelog/reference/tag.yaml`, tell Zed which folder holds
your changelogs. Add this to your Zed settings (`cmd+,`) or to a project `.zed/settings.json`:

```json
{
  "file_types": {
    "Liquibase YAML": ["**/db/changelog/**/*.yaml", "**/db/changelog/**/*.yml"],
    "Liquibase XML": ["**/db/changelog/**/*.xml"],
    "Liquibase SQL": ["**/db/changelog/**/*.sql"]
  }
}
```

Check the language shown in the status bar. It should say "Liquibase YAML", not "YAML".

## Configuration

Language server settings go under `lsp` in your Zed settings. The IDs are:

| ID | Languages | Purpose |
|---|---|---|
| `liquibase-xml-lsp` | Liquibase XML | LemMinX |
| `liquibase-yaml-lsp` | Liquibase YAML | yaml-language-server (completion, hover) |
| `liquibase-lsp` | Liquibase XML, Liquibase YAML | includes, references, unknown-key warnings |

Settings you provide **replace** the extension's defaults for that server instead of merging with
them. The defaults are:

- **LemMinX:** a file association that validates XML against
  `http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-latest.xsd` when a changelog has no
  `xsi:schemaLocation` of its own, external resource download enabled, and files without any
  grammar ignored.
- **yaml-language-server:** `validate: false`, completion and hover on, using the SchemaStore
  Liquibase schema.

Example, pinning the XML changelogs to a specific XSD version:

```json
{
  "lsp": {
    "liquibase-xml-lsp": {
      "initialization_options": {
        "settings": {
          "xml": {
            "fileAssociations": [
              { "pattern": "**/*.xml", "systemId": "http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.29.xsd" }
            ]
          }
        }
      }
    }
  }
}
```

## Troubleshooting

- **Nothing happens on `cmd+click` or no warnings appear.** Check the status bar language first.
  If it says "YAML" or "XML", add the `file_types` setting above.
- **The language is right but nothing works.** Zed starts a server when a file is opened, so after
  installing or rebuilding the extension, close and reopen the file or run
  `editor: restart language server`.
- **Server errors.** Run `dev: open language server logs` and pick the Liquibase server.
- **A Node `url.parse()` deprecation warning appears in the logs.** It comes from a dependency of
  `yaml-language-server`, not from this extension, and is harmless.

## Development

```
liquibase-zed/
├── extension.toml           # manifest: grammars, language servers
├── src/lib.rs               # Rust/WASM: downloads and launches the servers
├── src/liquibase-server.js  # bundled LSP: includes, references, diagnostics
├── src/liquibase-validate.js# YAML unknown-key validator
├── src/liquibase-model.json # generated keyword list (do not edit by hand)
├── tools/gen_model.py       # regenerates the keyword list from the XSD
└── languages/               # per-language config and tree-sitter queries
```

- Build check: `cargo build --target wasm32-wasip2 --release` (needs
  `rustup target add wasm32-wasip2`).
- Refresh the keyword list after a new Liquibase release: `python3 tools/gen_model.py`.
- The JS files are copied into the extension's work directory at startup, so edit them in `src/`
  and reinstall the dev extension to pick up changes.

## Limitations

- No validation, completion or references for formatted-SQL changelogs.
- JSON changelogs get no Liquibase support. Zed's built-in JSON language server covers them.
- Find references matches by name and does not know which table a column belongs to.
- Tested against Zed on macOS with one real project. Linux and Windows are untested. The LemMinX
  download handles all three platforms, but the others haven't been run.

## License

[MIT](LICENSE)
