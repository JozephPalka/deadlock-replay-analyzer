# Deadlock Replay Analyzer

Parses a Deadlock `.dem` replay in your browser and looks for the mistakes in it — yours and
your team's. Nothing is uploaded: the file is decoded locally by JavaScript running on your
machine.

## Running it

Double-click **`start.bat`**.

It starts a tiny local web server (plain PowerShell — nothing to install) and opens your
browser at `http://127.0.0.1:8777/`. Leave the black console window open while you use the
app; closing it stops the server.

Then either:

- **Choose replays folder** — point it once at
  `...\Steam\steamapps\common\Deadlock\game\citadel\replays` and it remembers the folder
  between sessions, listing every replay newest-first. Requires Chrome or Edge.
- **Drag a `.dem` file in** — works in any browser.

A 30–40 minute replay takes roughly 30–90 seconds to parse depending on your CPU and the
Detail setting in the top right.

## What it shows

**Overview** — result, scoreboard, the soul-lead graph with objectives marked, and the
findings the analyzer flagged.

**Deaths** — every one of your deaths with the context that actually explains it: how deep in
enemy territory you were, how many living allies were close enough to help, how many enemies
were on you, your souls at the time, and whether anyone on the other team died in the same
window. Plus a map plot of where everyone died.

**Build** — the whole item analysis. Purchase order with running spend, each item's timing
against the average purchase time for your hero, the damage that actually hit you split into
weapon fire versus ability damage, who dealt it, what you owned and how many souls you were
sitting on at each death, and specific suggestions with the evidence that produced them. See
"Where the build advice comes from" below.

**Farm & items** — net worth curves for all twelve players, milestone table at 5/10/15/20/25
minutes, your curve against whichever enemy spent the most early-game time near you, and the
full purchase timeline.

**Teamfights** — kills clustered into fights, with who showed up, who dealt damage, and who
was alive but somewhere else. Isolated single kills are counted as picks rather than fights so
the attendance numbers mean something.

**Macro** — how often your team turned a decisively won fight into an objective, the objective
timeline, how spread out each team was over the match, and deaths taken while already ahead.

**Ask Claude** — one button copies a complete match brief (markdown, usually 15–40 KB) sized
to paste straight into a conversation with Claude for a written review. There is a JSON export
too if you'd rather work with the raw numbers.

**Diagnostics** — what the parser actually found. Start here if a number looks wrong.

## Where the build advice comes from

Two separate sources, deliberately kept apart so you can tell which is which.

**What the replay proves.** Damage taken is split into weapon fire and ability damage by
checking whether each damage event carried an ability id — not by a hardcoded type table, since
Valve's numeric damage types are undocumented and have changed. From there: who dealt the
damage to you, what was hitting you in the eight seconds before each death, how much the enemy
team healed, and how many souls you were sitting on unspent at any moment. None of that is
opinion.

**What real matches say.** Per-item win rate, pick rate and average purchase time for your
hero, from `deadlock-api`'s `/v1/analytics/item-stats`, over the last 30 days. This is what
powers "you bought this five minutes later than most people do" and "these popular items never
appeared in your build". Win rate is correlation, not proof — a losing game buys different
items — and the app says so wherever it shows one.

A suggestion is only raised where both point the same way, and each one carries its evidence.
Item names are matched against the live item list rather than a hardcoded roster, so if a
counter-item cannot be found in the current patch the advice stays generic instead of inventing
a name. If the stats call fails, everything derived from the replay still works and the Build
tab says benchmarking is off.

## How teams and distances are worked out

Neither is hardcoded, because both vary.

**Teams.** Source engine team numbers are not stable across Valve's games or across Deadlock
builds, and a replay's controller list can also contain spectators and casters whose team
values are not playing teams. So the app looks at which team values actually hold a roster and
uses the two most populated, preferring rosters of six. Whichever id is lower is labelled
Amber. If a build stops replicating a team field entirely, the app says so on the Overview tab
rather than quietly showing nonsense.

## How distances work

Deadlock world units mean nothing on their own, and the map file isn't available to a browser.
So the analyzer derives the frame of reference from the match itself: it takes each team's
median position during the first 45 seconds as that team's base, and expresses every position
as a fraction along the base-to-base axis. `0.00` is your own spawn, `0.50` is roughly mid,
`1.00` is standing in the enemy base. Every radius ("allies nearby", "same fight") is a
fraction of that same distance, so nothing breaks if Valve rescales the map.

## If the numbers look wrong

Open **Diagnostics**. It lists every message type the parser saw, how many players it found,
whether the map frame was derived, and — most usefully — a full dump of every replicated field
on a player controller for the game build your replay came from.

Valve renames schema fields between builds. If souls or K/D/A read as zero, the field was
renamed, and the new name will be sitting in that dump. The candidate lists live at the top of
`js/parse.js` (`CTRL_FIELDS`); adding the new name to the right array is usually the whole fix.

Copy the Diagnostics tab into a conversation with Claude and it can tell you which one changed.

## Known limitations

- **Build suggestions are heuristics, not coaching.** They are deliberately conservative and
  every one shows its working. Treat "you took 70% ability damage and never bought spirit
  resist" as a fact and the recommendation attached to it as a starting point for judgement.
- **Lightly tested against real replays.** The analysis layer is covered by 52 automated checks
  against synthetic match data (`node selftest.mjs`), including replays that number teams 0/1
  or 2/3, replays carrying spectators, replays with no positional data and replays with no team
  data at all, plus the full build analysis. The parse layer was written against the parser's published API and the game's
  protobuf definitions. If a game build turns up field names that need adjusting, Diagnostics
  exists for exactly that — and if the report fails to build, the app falls back to showing
  Diagnostics rather than an error alone.
- **Hero and item names** come from the community asset API at `assets.deadlock-api.com`. If
  it's unreachable, everything still works but items show as `Item #1234`.
- **Item purchases** are matched to players through the replay's user-info table. If that
  mapping fails, the count of unmatched purchases appears in Diagnostics.
- **Fight detection is heuristic** — kills within 18 seconds and 13% of the map's length of
  each other are treated as one fight. It is not going to agree with your memory in every case.
- The app needs an internet connection on first load to fetch the parser from jsDelivr and the
  asset names (which are then cached for a week).

## Publishing it to GitHub Pages

The app is fully static and every path in it is relative, so it works from a project subpath
with no changes. A workflow is already included: it runs the self test and only deploys if the
tests pass.

**The easy way** — double-click **`deploy-to-github.bat`** (or run `./deploy-to-github.sh`).
It signs you in if needed, creates the repository, pushes, switches Pages to the Actions
source, and prints the URL. It is safe to run again later to publish updates.

It needs the [GitHub CLI](https://cli.github.com/) installed. Without it, by hand:

```bash
git add -A
git commit -m "Deadlock replay analyzer"
gh repo create deadlock-replay-analyzer --public --source=. --push
```

then **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site lands at
`https://<your-username>.github.io/deadlock-replay-analyzer/`.

Two things worth knowing about the hosted version:

- Pages serves over HTTPS, which is what the folder picker needs, so pointing it at your
  replays folder works there exactly as it does locally.
- Replays are still parsed entirely in your browser. Nothing is uploaded, including on the
  hosted copy — the only network calls are the parser bundle from jsDelivr and the item
  metadata and win rates from deadlock-api.

`start.bat` and `server.ps1` are only needed for running it locally; they are harmless in the
published copy.

## Files

```
start.bat            double-click to run it locally
deploy-to-github.bat double-click to publish it to GitHub Pages
deploy-to-github.sh  same thing for macOS and Linux
server.ps1         local static file server, no admin rights needed
index.html         the app shell
assets/styles.css
js/parse.js        .dem -> structured match data (the deadem wiring)
js/analyze.js      match data -> findings (pure, testable)
js/charts.js       hand-rolled SVG charts
js/ui.js           rendering
js/export.js       the Claude coaching brief
js/names.js        hero/item id -> name
js/build.js        item build analysis and suggestions
selftest.mjs       node selftest.mjs
tools/fixture.mjs  synthetic match used by the tests and the preview
tools/preview.mjs  node tools/preview.mjs -> preview.html
.github/workflows/deploy.yml   tests, then publishes to GitHub Pages
```

## Credits

Parsing by [deadem](https://github.com/Igor-Losev/deadem) (MIT) by Igor Losev.
Hero and item metadata from [deadlock-api](https://deadlock-api.com).
