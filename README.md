# makefun-token-radar-comps — Comps Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dewarizha-byte/makefun-token-radar-comps/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dewarizha-byte/makefun-token-radar-comps/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Comps Radar ranks every protocol without a token by **comparable-market implied value**: instead of one fixed multiple, each protocol is priced at the median market-cap-to-TVL ratio of the snapshot's own live tokens in its category, then adjusted for seven-day growth, age with no token, chain reach and TVL stability. It covers the full 40-protocol watchlist plus 160 early pre-token protocols below the floor, writes the ranked `board.json`, a static dashboard (no framework, no network), a per-protocol farm plan with capital, hold time, costs and a risk label, and the judge's `dossier.json`.

## Run it

```sh
node main.ts --input /input/snapshot.json --output /output
```

Node 22+, standard library only. Reads the sealed snapshot (default `/input/snapshot.json`, or a directory, or `--input <file|dir>`), scores it with `lib/model.ts`, and writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory (default `/output`, or `--output <dir>`, or `MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=b2w28t9c&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
