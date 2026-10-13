#!/usr/bin/env python3
"""
Pull AWRE / TruMedia game-video links for every BC TrackMan game.

TruMedia's GameVideo query is keyed by the TrackMan GameID. This asks for each BC
game once, stores TruMedia's answer as-is in site/data/video-tm/<GameID>.json
(kept between runs by the workflow cache), and lets scripts/build.py match the
clips to pitches. Games with no video yet are asked again after a few days.

Settings: scripts/video.json. Credentials: the same three TruMedia secrets.
If anything is missing or TruMedia can't be reached, this exits quietly.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build      # noqa: E402  (reads data/ the same way the site build does)
import trumedia   # noqa: E402  (sign-in + query helper)

CONFIG = Path(__file__).resolve().parent / "video.json"
OUT = build.OUT_DIR / "video-tm"


def log(*a):
    print(*a, flush=True)


def safe(gid: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", gid)


def bc_games() -> list[str]:
    df, *_ = build.load_all()
    if df.empty:
        return []
    bc = df["PitcherTeam"].isin(build.BC_CODES) | df["BatterTeam"].isin(build.BC_CODES)
    g = df.loc[bc, ["GameID", "Date"]].dropna(subset=["GameID"]).drop_duplicates("GameID")
    g = g.sort_values("Date", ascending=False)       # newest games first
    return [str(x) for x in g["GameID"] if str(x).strip()]


def main():
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    tcfg = cfg.get("trumedia", {})
    OUT.mkdir(parents=True, exist_ok=True)
    report_file = build.OUT_DIR / "video-tm-report.json"
    report = {"ran": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status": "", "asked": 0,
              "with_video": 0, "errors": {}, "columns": []}

    def finish(status):
        report["status"] = status
        report_file.write_text(json.dumps(report, indent=1))
        log(f"TruMedia video: {status}")

    if not cfg.get("enabled", True) or not tcfg.get("enabled", True):
        for f in OUT.glob("*.json"):
            f.unlink()
        return finish("disabled in scripts/video.json")
    user, site, master = (os.environ.get(k, "").strip() for k in
                          ("TRUMEDIA_USERNAME", "TRUMEDIA_SITENAME", "TRUMEDIA_MASTER_TOKEN"))
    if not (user and site and master):
        return finish("skipped: TruMedia secrets are not set in the repository")

    games = bc_games()
    now = datetime.now(timezone.utc)
    recheck = timedelta(days=float(tcfg.get("recheck_days", 4)))
    todo = []
    for gid in games:
        f = OUT / f"{safe(gid)}.json"
        if f.exists():
            try:
                old = json.loads(f.read_text())
                if old.get("rows"):
                    continue                       # already have clips for this game
                if now - datetime.fromisoformat(old["pulled"]) < recheck:
                    continue                       # asked recently, nothing yet
            except (ValueError, KeyError):
                pass
        todo.append(gid)
    todo = todo[: int(tcfg.get("max_games_per_run", 60))]
    if not todo:
        return finish(f"up to date ({len(games)} BC games checked earlier)")

    try:
        tm = trumedia.TruMedia(user, site, master)
    except Exception as e:
        return finish(f"could not sign in to TruMedia ({str(e)[:200]})")

    cols_seen = set()
    for gid in todo:
        rec = {"gid": gid, "pulled": now.isoformat(timespec="seconds"), "columns": [], "rows": []}
        try:
            df = tm.query("GameVideo", {"trackmanGameID": gid})
            df = df.where(df.notna(), None)
            rec["columns"] = [str(c) for c in df.columns]
            rec["rows"] = df.to_dict(orient="records")
            cols_seen.update(rec["columns"])
            report["with_video"] += bool(rec["rows"])
            log(f"  {gid}: {len(rec['rows'])} rows")
        except Exception as e:
            rec["error"] = str(e)[:300]
            report["errors"][gid] = rec["error"]
            log(f"  ! {gid}: {rec['error']}")
        report["asked"] += 1
        (OUT / f"{safe(gid)}.json").write_text(json.dumps(rec, default=str))
        if report["asked"] == 5 and len(report["errors"]) == 5:
            report["columns"] = sorted(cols_seen)
            return finish("stopped: TruMedia refused the first 5 games (see errors); check that video is part of your TruMedia access")
    report["columns"] = sorted(cols_seen)
    finish(f"asked TruMedia about {report['asked']} game(s); {report['with_video']} had video")


if __name__ == "__main__":
    sys.exit(main())
