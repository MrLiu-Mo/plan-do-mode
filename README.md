# dsh-plan-do · Plan & Do

> A DSH mode that teaches you to build a small idea yourself: the AI coaches and reviews, but never writes your code for you.

Install it and a new preset, **Plan & Do**, shows up in the preset picker. It turns *capture idea → clarify → spec → tech breakdown → pick a path → learn by building → ship* into a state machine with hard constraints. The model has no write tools, so your project code can only come from you.

[中文版 README](README.zh.md)

## Status

v0.1.0, all acceptance items A1–A9 passed (A9 verified by a real install on 2026-11-26). Node 24, zero dependencies, 423 tests, CI green on ubuntu and windows.

## Install

Installing the plugin needs a session that has `plugin_manager` (creation mode). Running tests and writing code do not.

**1. From the release tarball** — no npm account needed:

```bash
dsh plugin --profile <profile> add -w "https://github.com/MrLiu-Mo/plan-do-mode/releases/download/v0.1.0/dsh-plan-do-0.1.0.tgz"
```

**2. From a local directory** (dev / first verification):

```text
plugin_manager action=install_bundle target=<absolute path to this repo>
```

**3. From npm** — has version numbers, so upgrades are one command:

```bash
dsh plugin --profile <profile> add dsh-plan-do
```

Then **new session → preset picker → Plan & Do**.

`--profile` is required; the CLI passes everything after it through to pnpm. A desktop profile is managed exclusively by the Electron app, so use install method 1 or 2 there.

**Uninstall** — in a session with `plugin_manager`, run `plugin_manager action=remove_bundle`, or `dsh plugin --profile <profile> remove dsh-plan-do` for a non-desktop profile. The preset and its 8 tools disappear; `~/.plando/` and each project's `.plando/` stay. Uninstalling never deletes your data.

## Use

1. New session, pick **Plan & Do**.
2. Tell it your idea, or have it park the idea in the idea bank (`~/.plando/ideas.json`, shared across projects).
3. `plando_status` tells you where you are, what the next step is, and whether you are stuck. The flow only advances through `plando_transition`; illegal moves are refused and recorded.
4. Artifacts (`IDEA.md`, `TECH.md`, `HANDOFF.md`, `CHANGE-GUIDE.md`, task cards) are rendered by the plugin from `.plando/state.json`, never hand-written by the model — so the state cannot lie.

## How it works

The preset = 8 `plando_*` tools + read-only file tools (`read` / `glob` / `grep`) + a persona prompt. The model **cannot see** `write` / `edit` / `bash` / `pwsh` / `subagent`.

Eleven stages:

| Stage | What happens |
|---|---|
| `inbox` | idea parked, no project yet |
| `clarify` | what "done" looks like, what you will *not* do, who uses it, open assumptions |
| `idea` | spec frozen, `IDEA.md` rendered |
| `tech` | tech breakdown, `TECH.md` rendered; refused if it blows the budget |
| `decide` | pick a path: timeboxed spike / build directly / hand off to AI and only review |
| `verify` | one timeboxed spike, one assumption, evidence required |
| `build` | learn → do → verify, one card at a time |
| `ship` | final review: runs offline, and you can explain what you changed |
| `done` / `handoff` / `dropped` | three terminal states |

Eight tools: `plando_status`, `plando_project` (open/list/init), `plando_idea` (add/list/pick/park/drop), `plando_clarify` (≤2 rounds), `plando_transition` (the only way to advance), `plando_card` (start/done/downgrade/evidence), `plando_check` (runs commands already declared in `.plando/checks.json`), `plando_scaffold` (writes whitelisted config files only).

Two guards keep the AI from writing your code:

1. **Structural** — the preset mounts no write tools at all (`dsh-tool-fs` with `write: false, edit: false`). The model does not have them.
2. **Runtime** — `ctx.tools.guard()` refuses every world-changing tool outside `build`, and says which stage you are in and what to do instead. If the state cannot be read, write-class tools fail closed; read tools pass; `plando_*` validates its own stage. The capability list lives in `lib/policy.js`; extend it with `guardExtraDeny`.

Configuration (`plan-do-mode.config` in `cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `dataRoot` | `~/.plando` | root of the idea bank and project index |
| `autoCommit` | `false` | commit mode artifacts only (never `git add -A`) |
| `budget` | `{ mustUnderstand: 5, totalMinutes: 600 }` | caps for `owner=user` items and total minutes |
| `sizeThresholdMinutes` | `300` | above this the project is "large" and `decide` recommends a timeboxed spike first; snapshotted into `state.tech.threshold` at init |
| `guardExtraDeny` | `[]` | extra tool names to deny |

## Capabilities

This package does two things a scanner will flag, and they are real:

- **`shell`** — `plando_check` executes commands, but only commands you declared in `.plando/checks.json`; it accepts nothing ad-hoc. Every command must clear five gates: executable allowlist, inline-execution switches (`node -e`, `python -c`, `npm install`, …), file-writing switches (`--test-reporter-destination`, `--cpu-prof-dir`, …), path arguments that point outside the project, and `npx` is not a laundering prefix (`npx node -e` is refused like `node -e`).
- **`fs-write`** — `plando_scaffold` writes files, but only 7 declarative config files (`package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`), with validated contents, and only for TECH items marked as hand-off-able to AI. The plugin also writes `.plando/` state and artifacts.

**"The AI does not write your code" is a hard constraint inside the mode, not an absence of capability in the package.** It holds because the preset mounts no write tools, because the guard fails closed, and because `autoCommit` defaults to `false`.

Known residual: `node evil.js` and `deno run x.ts` pass the allowlist (they cannot be told apart from "run a check" at the argv level) — but the plugin itself cannot create `.js` / `.ts` files, so exploiting this needs a file you put there yourself. Evidence for a card must include at least one file *you* wrote; mode artifacts and scaffolded config files do not count.

## Docs

| File | Contents |
|---|---|
| [PLAN.md](PLAN.md) | design, acceptance A1–A9, distribution |
| [docs/START-HERE.md](docs/START-HERE.md) | which file to read when |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | the flow as a human reads it: stage exits, the three questions, getting unstuck |
| [docs/CONTRACT.md](docs/CONTRACT.md) | `state.js` contract: stages / events / payloads / error messages |
| [docs/INSTALL.md](docs/INSTALL.md) | install, smoke checklist, uninstall |
| [docs/API-FACTS.md](docs/API-FACTS.md) | verified DSH plugin API facts |
| [docs/DEV-PROMPTS.md](docs/DEV-PROMPTS.md) | round-by-round build prompts |
| [docs/RELEASE.md](docs/RELEASE.md) | release process |

*(The docs are written in Chinese.)*

## Development

Zero dependencies: `lib/` may only `import 'node:*'` and relative siblings. Tests use `node:test`.

```bash
node --test                    # all tests
node scripts/check-docs.mjs    # cross-document consistency
node scripts/verify-pack.mjs   # real npm pack, asserts the files whitelist
node scripts/smoke-pack.mjs    # pack → extract → load → run init→clarify→idea
node scripts/release-check.mjs # metadata, placeholders, clean worktree
```

## License

[MIT](LICENSE)
