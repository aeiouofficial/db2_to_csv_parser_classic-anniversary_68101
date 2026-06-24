# DB2 → CSV Parser — WoW Classic Anniversary (build 68101)
<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/7e2ed47c-6a66-4200-a9b3-ff1a94eef13b" />

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Build](https://img.shields.io/badge/WoW%20build-2.5.5.68101-orange.svg)](#)
[![Status](https://img.shields.io/badge/status-working-success.svg)](#)

A small, self-contained command-line tool that streams the client database (`.db2`) tables for **World of Warcraft Classic — Burning Crusade Anniversary, build `2.5.5.68101`** directly from Blizzard's CASC CDN, decodes them, and writes them out as clean CSV.

No game installation required. No bundled game data. Point it at the CDN, get CSV.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Output](#output)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [The decoder patch](#the-decoder-patch)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Legal & disclaimer](#legal--disclaimer)
- [License](#license)

---

## Features
<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/802d4f97-8d4a-42b0-8be8-fbd77c38f4c2" />

- **Fully self-contained** — pulls the lib, applies its fix, and fetches data on its own. A fresh clone just works.
- **Streams straight from the CDN** — no local WoW install, no manual file extraction.
- **Correct string-array decoding** — ships a patch for `@rhyster/wow-casc-dbc` that fixes packed string-array columns (e.g. `liquidtype.Texture[6]`) that the upstream library mis-decodes.
- **Full or single-table export** — export everything, or just one table for a quick smoke test.
- **Inventory + budget verification** — tracks parse status per table and validates output budgets.
- **Windows one-click launcher** — `start.bat` menu for install + export.

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js 18+** | Tested up to Node 25. |
| **Internet access** | Reaches the Blizzard CDN (region `eu`). |
| **~150 MB free disk** | CDN archives + decoded CSV output. |

## Installation
<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/45ac2aeb-8126-4dad-9215-932873be536d" />

```bash
git clone <your-repo-url>
cd db2_to_csv_parser_classic-anniversary_68101
npm install
```

`npm install` runs `patch-package` automatically (via the `postinstall` hook), which re-applies the bundled fix in `patches/` to `@rhyster/wow-casc-dbc`.

> ⚠️ **The patch is mandatory.** Without it, string-array columns fail to decode and affected tables error out.

## Usage

### Windows — one-click launcher

Double-click **`start.bat`** (or run it from a terminal). It checks Node, installs dependencies on first run, and shows a menu:

```
[1] Voll-Export : all tables       -> assets\db\68101\
[2] Smoke-Test  : liquidtype only  (fast)
[3] Verify      : inventory + budgets
[4] Inventory   : rebuild table inventory from the CDN
[0] Exit
```

### npm scripts (cross-platform)

```bash
npm run export:verbose      # full export of all tables, with progress log
npm run export              # full export, quiet
npm run export:liquidtype   # single-table smoke test
npm run inventory           # (re)build the table inventory from the CDN
npm run verify              # validate the current inventory + budgets
```

### Direct CLI

```bash
node tools/export-wow-db2-csv.mjs --table=liquidtype --profile=bc_anniversary_68101
node tools/export-wow-db2-csv.mjs --csv --build=68101 --profile=bc_anniversary_68101
node tools/export-wow-db2-csv.mjs --verify
```

> CLI flags are parsed as `--key=value`. Use `--build=68101`, **not** `--build 68101`.

## Output

```
assets/db/68101/<table>.csv                     decoded tables (comma-delimited, LF)
assets/db/68101/manifest.json                   per-run manifest
server/data/asset-pipeline/db2-inventory.json    discovery + parse status (regenerated)
```

A typical full run resolves ~1,297 discovered tables: ~916 parsed `ok`, the remainder `notFound` (not shipped in this build), `0` required failures.

## Project structure

```
.
├── tools/
│   ├── export-wow-db2-csv.mjs        # CLI entry point
│   └── run-db2-export-verbose.mjs    # full export with progress logging
├── server/
│   └── asset-pipeline/
│       ├── db2-cdn-export-service.mjs # core: CDN fetch + decode + CSV write
│       └── cdn-cache.mjs              # CDN response cache
├── data/
│   ├── db2-build-profiles.json        # build profile (bc_anniversary_68101)
│   └── required-tables.json           # tables required for a healthy run
├── patches/
│   └── @rhyster+wow-casc-dbc+2.15.10.patch
├── .gitignore
├── package.json
├── start.bat                          # Windows launcher
├── LICENSE
└── README.md
```

## How it works

1. **`tools/export-wow-db2-csv.mjs`** (CLI) calls **`server/asset-pipeline/db2-cdn-export-service.mjs`** (core service).
2. The service uses **`@rhyster/wow-casc-dbc`** (`CASCClient` + `WDCReader` + `DBDParser`) to fetch each `.db2` straight from the CDN and decode it against the matching DBD layout.
3. Decoded rows are written to CSV, and an inventory records each table's status (`ok` / `notFound` / `encrypted` / …).

## The decoder patch

Upstream `@rhyster/wow-casc-dbc` reads packed **string-array** columns (N × 32-bit string-table offsets) as a single wide integer, which collapses arrays such as `Texture[6]`. The bundled patch:

- splits the packed value into 32-bit offsets and resolves each against the string table, and
- loosens the `DBDParser` assertion so string columns may be a string **or** an array of strings.

It is persisted with [`patch-package`](https://www.npmjs.com/package/patch-package) (`patches/@rhyster+wow-casc-dbc+2.15.10.patch`) and re-applied on every `npm install`.

## Configuration

- **`data/db2-build-profiles.json`** — the `bc_anniversary_68101` profile (BuildConfig, CDNConfig, region, DBD revision, budgets).
- **`data/required-tables.json`** — tables that must parse for a run to be considered healthy.

To target a different build, add a new profile and pass `--profile=<name>`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ENOENT … db2-inventory.json` on first full export | Already handled — the runner treats a missing inventory as empty. If you see this, update `tools/run-db2-export-verbose.mjs`. |
| All rows fail with `Missing string for string column …` | The decoder patch was not applied. Run `npx patch-package` and re-check `patches/`. |
| CDN/connection errors | Confirm internet access; the profile uses region `eu`. |
| Brand-new Node major version misbehaves | The tool targets Node 18+. If a very new Node release breaks a dependency, try an LTS release. |

## Legal & disclaimer

This is an **unofficial, fan-made research and interoperability tool**. It is **not affiliated with, endorsed by, or sponsored by Blizzard Entertainment, Inc.** World of Warcraft and all related data are trademarks and copyrights of Blizzard Entertainment.

- This repository ships **no game data**. Running the tool downloads data from Blizzard's own public CDN.
- The decoded output (`assets/db/**`) is **Blizzard's copyrighted game data** and is deliberately excluded from version control (see `.gitignore`). **Do not redistribute extracted data.**
- Use only in accordance with the Blizzard End User License Agreement / Terms of Service and applicable law.

## License

Released under the **MIT License**. See [`LICENSE`](LICENSE) for the full text.

The MIT license covers **this tool's source code only** — not any data fetched or produced with it, and not the third-party `@rhyster/wow-casc-dbc` dependency (which retains its own license).
