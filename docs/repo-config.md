# Repository configuration

`.guided-review.json` sits at the repository root and holds rules for everyone who reviews the repository. Run `gr config --repo` to create or edit it, then commit it.

Every key is optional. An entry that is malformed is ignored, and `gr config --repo` lists those entries after you save.

## Examples

| File | Shows |
| --- | --- |
| [minimal.json](examples/minimal.json) | One entry for each key |
| [typescript-monorepo.json](examples/typescript-monorepo.json) | A generated API client, Storybook stories, and dependency and UI checklists |
| [go-service.json](examples/go-service.json) | Generated code, deploy manifests, and protobuf and migration checklists |
| [python-django.json](examples/python-django.json) | Translation files, pytest helpers, and migration and settings checklists |
| [java-spring.json](examples/java-spring.json) | `.properties` and logging config, Gradle integration-test source sets, and Flyway/Liquibase, dependency and controller checklists |

## Keys

### `kinds`

Overrides how a file is classified. Each rule is `{ "pattern": <glob>, "kind": <kind> }`, and the first rule that matches a file wins. Repository rules take precedence over everything built in, including `.gitattributes`.

| Kind | Effect on the tour |
| --- | --- |
| `logic` | Hand-written code, narrated in full |
| `test` | Grouped into the tests chapter |
| `config` | Grouped into the config chapter |
| `mechanical` | Grouped as low-risk mechanical changes |
| `generated` | Collapsed to a one-line summary |
| `vendored` | Collapsed to a one-line summary, with the version change when it can be found |

Some files are already classified without a rule:

- `vendor/`, `third_party/` and `node_modules/` are vendored.
- Lockfiles, snapshots, `generated/` and `__generated__/` directories, and files with a `Code generated` or `@generated` header are generated.
- `.gitattributes` entries with `linguist-generated` or `linguist-vendored` are honored.

Add a rule only for files these defaults miss.

Migrations, API contracts, dependency and runtime versions, lockfiles, infrastructure, and CI files are also moved into [their own chapters](usage.md#change-aware-chapters) by path. That applies only to files classified as `logic` or `config` (and to lockfiles), so a rule that sets any other kind keeps a file out of those chapters. For example, `{ "pattern": "tools/migrate/**", "kind": "mechanical" }` keeps a migration tool's own source from being read as a database migration.

### `testPatterns`

Extra globs for test files, added to the built-in ones. The built-in globs already cover `*.test.ts`, `*.spec.js`, `test/`, `tests/`, `__tests__/`, `*_test.go`, `test_*.py`, `*_spec.rb`, and `*Test.java`.

### `checklists`

Each checklist is `{ "pattern": <glob>, "items": [<string>, ...] }`. When a chapter touches a path that matches the pattern, the items are attached to that chapter. The agent pre-checks each item, and you can open the list with `i`.

## Globs

- `*` matches within one directory, `**` matches across directories, and `?` matches a single character.
- `{a,b}` matches either alternative.
- A pattern with no `/` matches the file name anywhere, as in `.gitignore`. For example, `*.proto` matches `api/v1/user.proto`.
- A trailing `/` matches everything under that directory.

## Security

Rules are read from the PR's merge base, not from the PR itself, so a PR cannot reclassify its own files. If a PR changes `.guided-review.json` or `.gitattributes`, the briefing flags the change.
