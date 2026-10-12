# BirdballSavant

A Baseball Savant–style site for Boston College Baseball TrackMan data: hitting and
pitching leaderboards, percentile rankings, pitch arsenals, movement and location
charts, spray charts, game pages and a pitch search with CSV export.

The site rebuilds itself every time you upload new TrackMan files.

---

## One-time setup (about 5 minutes)

1. **Create the repository.** On GitHub, click **New repository**, name it
   `BirdballSavant`, and create it (no README needed).
2. **Upload this project.** On the empty repo page, click **uploading an existing file**,
   then drag in everything from this folder: `data`, `scripts`, `site`, `README.md`,
   `.gitignore` and the `.github` folder. Commit to `main`.
   - The `.github` folder is hidden on Mac and Windows. On a Mac press
     <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> in Finder to show it. If drag-and-drop
     skips it, create the file in GitHub instead: **Add file → Create new file**, name it
     `.github/workflows/deploy.yml`, and paste in the contents of that file.
3. **Turn on GitHub Pages.** Go to **Settings → Pages**. Under **Build and deployment →
   Source**, choose **GitHub Actions**.
4. **Run the first build.** Go to the **Actions** tab, choose **Build and publish
   BirdballSavant**, and click **Run workflow**. After 1–2 minutes the run shows a link
   to the live site, usually `https://<your-username>.github.io/BirdballSavant/`.

## Adding new games

1. Open the `data` folder in the repository.
2. Click **Add file → Upload files** and drop in TrackMan exports (`.csv`, `.xlsx`, or `.xls`).
3. Click **Commit changes**.

That's it. GitHub Actions rebuilds the site and it updates in about two minutes.
You can watch progress in the **Actions** tab (green check = live).

Things the build handles for you:

- **Single games or season files both work.** If the same pitch shows up in more than
  one file (for example a per-game CSV and a combined season file), it is only
  counted once.
- **Seasons are assigned by game date.** January–July games are "Spring <year>",
  August–December games are "Fall <year>". File names don't matter.
- **New opponents** show up with their TrackMan team code (e.g. `ABC_XYZ`). To give
  them a proper name, edit `scripts/teams.json` in GitHub and add a line.
- A file that isn't a TrackMan export is skipped, and the **Data status** page on the
  site lists every file and how many rows were read from it.

### Games without TrackMan (results files)

For a game with no TrackMan file, you can upload a results sheet instead: one row per BC
plate appearance with these columns:

| Batter | Balls | Strikes | Result |
|---|---|---|---|
| Solier, Julio | 1 | 1 | L9 |
| Solier, Julio | 1 | 2 | K |
| Gallo, Luke | 0 | 0 | SAC F9 |

- **Put the date and opponent in the file name**, e.g. `2026-09-26 URI Results.xlsx` or
  `9.26.26vsURI.xlsx`. For a road game put `@` (or `at`) before the opponent, e.g.
  `2026-09-24_@URI_Results.xls`. For a doubleheader add `Game 2`. (A `Date` or `Opponent` column
  works too.) A file with no date is skipped.
- **Results** use scorebook notation: `1B` `2B` `3B` `HR`, `K`/`KL`, `BB`, `HBP`,
  ground outs like `6-3` or `4-6-3`, `F8` (fly), `L9` (liner), `P5` (popup), `E6`,
  `FC`, `SAC 1-3` (sac bunt), `SAC F9` (sac fly).
- These plate appearances count toward PA, AB, H, AVG/OBP/SLG, wOBA, K%, BB% and
  GB/LD/FB rates. They are left out of anything that needs tracking (exit velocity,
  xwOBA, swing/chase/whiff rates, pitch counts).
- Batter names are matched to TrackMan names automatically, so small typos like
  "Mainolfy" → "Mainolfi" are fixed. The **Data status** page shows every match so you
  can check it. To force a spelling, add it to `scripts/aliases.json`.
- Don't upload a results file for a game that also has a TrackMan file, or those plate
  appearances will count twice.

### Offensive execution chart (weekly)

Each week, download the execution chart sheet as CSV (File → Download → .csv) and upload
it to `data/`. The site reads the "Updated through" date at the top of the sheet, matches
each jersey number to a player with `scripts/roster.json`, and shows it on the Hitting
leaderboard's **Execution** tab and on each hitter's page. The `T` row is the team line and
the `G` row is the staff goal. If an older chart for the same season is still in `data/`,
the one with the newest "Updated through" date wins, so you can either replace the file or
add a new one.

**2K Win %** on that tab = plate appearances that reached two strikes and did not end in a
strikeout, from TrackMan games plus results-only games.

### Roster and corrections

- `scripts/roster.json`: jersey numbers, positions, class and bio from the official roster.
  Update it when the roster changes (new numbers are needed to match the execution chart).
- `scripts/corrections.json`: confirmed TrackMan tagging mistakes (for example a strikeout
  tagged on a 2-0 count). Each fix is applied on every build and listed on the Data status page.

GitHub's web uploader accepts files up to 25 MB each. Per-game TrackMan CSVs are well
under that. For a larger combined file, upload it as `.xlsx` (much smaller than CSV)
or split it.

## Privacy

GitHub Pages on a free account requires a **public** repository, which means anyone
with the link can see the site and download the raw files in `data/`. If the data must
stay private, options include a GitHub Enterprise organization (private Pages), or
hosting the `site` folder behind a login with a service such as Cloudflare Pages +
Cloudflare Access.

## Running it on your own computer

```bash
pip install -r scripts/requirements.txt
python scripts/build.py          # reads data/, writes site/data/
python -m http.server -d site    # then open http://localhost:8000
```

## How the numbers are calculated

See the **Glossary** page on the site. In short: wOBA uses MLB linear weights; expected
stats (xBA, xSLG, xwOBA) come from a model of exit velocity and launch angle fit on every
tracked batted ball in the data; barrels use the Statcast definition; percentiles rank
players against qualified BC players in the same season.

## Project layout

```
data/                     TrackMan exports (upload new files here)
scripts/build.py          turns data/ into site/data/*.json
scripts/teams.json        team code → display name
site/                     the website (index.html, app.js, app.css)
.github/workflows/        GitHub Actions: build + publish on every upload
```
