# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Aritoys89/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Aritoys89/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads the sealed DefiLlama snapshot of 758 protocols and ranks the ones that record no token yet by an implied launch value derived from the snapshot itself — TVL times a category multiple computed from tokenised peers' market-cap/TVL ratios (winsorised, shrunk toward the global median), adjusted for 7-day growth, time running without a token, and chain breadth. The board holds 198 pre-token protocols covering all 40 watchlist slugs, each with a concrete farm plan; the dashboard adds sortable and filterable views, a per-protocol detail view with the model's four-factor breakdown and live peer comparables, and the tokenised protocols as a separate comparables table.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=k7c6ejze&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
