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

import pandas as pd
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


def bc_games(spring_only=True) -> list[str]:
    """BC TrackMan games, newest first. TruMedia's game video covers official NCAA games, so by
    default fall games (Aug-Dec) and private scrimmages are skipped."""
    df, *_ = build.load_all()
    if df.empty:
        return []
    bc = df["PitcherTeam"].isin(build.BC_CODES) | df["BatterTeam"].isin(build.BC_CODES)
    g = df.loc[bc, ["GameID", "Date"]].dropna(subset=["GameID"]).drop_duplicates("GameID").copy()
    g["d"] = pd.to_datetime(g["GameID"].astype(str).str[:8], format="%Y%m%d", errors="coerce")
    g["d"] = g["d"].fillna(pd.to_datetime(g["Date"], errors="coerce", format="mixed"))
    if spring_only:
        g = g[g["d"].dt.month.between(1, 7) & ~g["GameID"].astype(str).str.contains("Private", case=False)]
    g = g.sort_values("d", ascending=False)
    return [str(x) for x in g["GameID"] if str(x).strip()]


# TruMedia's documented call is GameVideo.csv?trackmanGameID=<id>. If TruMedia rejects it
# ("Failed Requirement Group" = a required parameter is missing), these variants are tried
# once on one game and the first one TruMedia accepts is used for the rest.
def variants(gid):
    yr = gid[:4] if gid[:4].isdigit() else None
    out = [{"trackmanGameID": gid}, {"trackmanGameId": gid}]
    if yr:
        out += [{"trackmanGameID": gid, "seasonYear": yr},
                {"trackmanGameID": gid, "seasonYear": yr, "seasonType": "REG"},
                {"trackmanGameID": gid, "seasonYear": yr, "seasonType": "REG", "format": "RAW"}]
    return out


def main():
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    tcfg = cfg.get("trumedia", {})
    OUT.mkdir(parents=True, exist_ok=True)
    report_file = build.OUT_DIR / "video-tm-report.json"
    report = {"ran": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status": "", "asked": 0,
              "with_video": 0, "empty": 0, "errors": {}, "columns": [], "sample": None, "games_known": 0}

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

    games = bc_games(tcfg.get("spring_only", True))
    report["games_known"] = len(games)
    manual = os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"   # Run workflow button: ask again now
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
                if not old.get("error") and not manual and now - datetime.fromisoformat(old["pulled"]) < recheck:
                    continue                       # asked recently, TruMedia had nothing yet
            except (ValueError, KeyError):
                pass
        todo.append(gid)
    todo = todo[: int(tcfg.get("max_games_per_run", 60))]
    if not todo:
        return finish(f"up to date ({len(games)} BC games checked earlier)")

    try:
        tm = trumedia.TruMedia(user, site, master, float(tcfg.get("time_limit_minutes", 10)), 1.5)
    except Exception as e:
        return finish(f"could not sign in to TruMedia ({str(e)[:200]})")

    # find a form of the request TruMedia accepts, using the newest game
    probe, chosen, attempts = todo[0], None, []
    for k, v in enumerate(variants(probe)):
        try:
            tm.query("GameVideo", v)
            chosen = k
            break
        except trumedia.OutOfTime as e:
            report["attempts"] = attempts
            return finish(f"stopped before finishing: {e}")
        except Exception as e:
            attempts.append(f"{', '.join(v)}: {str(e)[:160]}")
            log(f"  GameVideo with {', '.join(v)}: {str(e)[:160]}")
    report["attempts"] = attempts
    if chosen is None:
        report["probe_game"] = probe
        return finish(f"TruMedia rejected every form of the GameVideo request for {probe}. "
                      "Ask ncaasupport@trumedianetworks.com which parameters GameVideo needs and whether "
                      "video is included in BC's API access (send them this error).")
    report["request"] = ", ".join(variants(probe)[chosen])
    log(f"  using GameVideo with {report['request']}")

    cols_seen = set()
    for gid in todo:
        rec = {"gid": gid, "pulled": now.isoformat(timespec="seconds"), "columns": [], "rows": []}
        try:
            df = tm.query("GameVideo", variants(gid)[chosen])
            df = df.where(df.notna(), None)
            rec["columns"] = [str(c) for c in df.columns]
            rec["rows"] = df.to_dict(orient="records")
            cols_seen.update(rec["columns"])
            report["with_video"] += bool(rec["rows"])
            report["empty"] += not rec["rows"]
            if rec["rows"] and report["sample"] is None:
                report["sample"] = {"gid": gid, "columns": rec["columns"],
                                    "rows": [{k: str(v)[:160] for k, v in r.items()} for r in rec["rows"][:3]]}
            log(f"  {gid}: {len(rec['rows'])} rows" + (f"; columns: {rec['columns']}" if rec["rows"] and report["with_video"] == 1 else ""))
        except trumedia.OutOfTime as e:
            report["time_limit_hit"] = True
            log(f"  ! {e}")
            break
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
    finish(f"asked TruMedia about {report['asked']} game(s): {report['with_video']} returned video rows, "
           f"{report['empty']} returned nothing, {len(report['errors'])} errors")


if __name__ == "__main__":
    sys.exit(main())
