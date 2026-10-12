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
