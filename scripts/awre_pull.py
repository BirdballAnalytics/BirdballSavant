#!/usr/bin/env python3
"""
Pull AWRE video links for BC games (AWRE Air "exchange" API, v2).

  1. schedule   GET /team/{team_id}/schedule?game_type=a&year=YYYY   every BC game, practice, scrimmage
  2. event      GET /event/{performance_data_key}                     every pitch in that game, with its
                                                                      TrackMan PitchUID and AWRE pitch key
  3. angles     GET /team/{team_id}/clip/{pitch key}/angles           the video for that pitch, one link
                                                                      per camera angle

Everything is saved in site/data/video-awre/<game>.json (kept between runs by the workflow cache),
so each run only asks about games and pitches it hasn't finished. scripts/video.py then attaches
the clips to the matching pitches on the site by PitchUID.

API key: GitHub repository secret AWRE_API_KEY (never put it in a file). Team id and settings:
scripts/awre.json.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path(__file__).resolve().parent / "awre.json"
OUT = ROOT / "site" / "data" / "video-awre"
REPORT = ROOT / "site" / "data" / "video-awre-report.json"
API = "https://www.pitchaware.com/api/exchange/v2"


def log(*a):
    print(*a, flush=True)


class OutOfTime(Exception):
    pass


class AWRE:
    def __init__(self, key, budget_min, delay):
        self.h = {"Authorization": f"Api-Key {key}", "Accept": "application/json"}
        self.deadline = time.time() + 60 * budget_min
        self.delay, self.last, self.calls = delay, 0.0, 0

    def get(self, path, params=None):
        for attempt, wait in enumerate([15, 40, 90, None]):
            if time.time() > self.deadline:
                raise OutOfTime()
            gap = self.delay - (time.time() - self.last)
            if gap > 0:
                time.sleep(gap)
            self.last = time.time()
            self.calls += 1
            try:
                r = requests.get(API + path, headers=self.h, params=params, timeout=60)
            except requests.RequestException as e:
                if wait is None:
                    raise RuntimeError(f"no answer from AWRE ({type(e).__name__})")
                time.sleep(5)
                continue
            if r.status_code == 429 and wait is not None:
                log(f"    AWRE says too many requests; waiting {wait}s")
                time.sleep(wait)
                continue
            if r.status_code in (502, 503, 504) and wait is not None:
                time.sleep(5)
                continue
            if r.status_code in (401, 403):
                raise PermissionError(f"AWRE refused the API key (HTTP {r.status_code}): {r.text[:200]}")
            if r.status_code == 404:
                return None
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r.json()
        raise RuntimeError("AWRE kept refusing requests (429)")


def main():
    cfg = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"ran": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status": "", "games": 0,
              "games_done": 0, "pitches": 0, "pitches_with_video": 0, "requests": 0, "errors": []}

    def finish(status):
        report["status"] = status
        REPORT.write_text(json.dumps(report, indent=1))
        log(f"AWRE: {status}")

    if not cfg.get("enabled", True):
        for f in OUT.glob("*.json"):
            f.unlink()
        return finish("disabled in scripts/awre.json")
    key = os.environ.get("AWRE_API_KEY", "").strip()
    team = str(cfg.get("team_id", "")).strip()
    if not key:
        return finish("skipped: the AWRE_API_KEY secret is not set in the repository")
    if not team:
        return finish("skipped: no team_id in scripts/awre.json")
    api = AWRE(key, float(cfg.get("time_limit_minutes", 20)), float(cfg.get("request_delay_seconds", 0.3)))
    now = datetime.now(timezone.utc)
    years = sorted(set(int(y) for y in cfg.get("years", [])) | {now.year}, reverse=True)

    try:
        # 1. schedule
        games = []
        for y in years:
            s = api.get(f"/team/{team}/schedule", {"game_type": cfg.get("game_type", "a"), "year": y}) or {}
            games += s.get("games", [])
        games = sorted({g["performance_data_key"]: g for g in games if g.get("performance_data_key")}.values(),
                       key=lambda g: g.get("game_time") or g.get("date") or "", reverse=True)
        report["games"] = len(games)
        log(f"  schedule: {len(games)} games/sessions for team {team} ({', '.join(map(str, years))})")

        for g in games:
            mg = g["performance_data_key"]
            f = OUT / f"{mg}.json"
            rec = json.loads(f.read_text()) if f.exists() else {}
            stamp = g.get("video_last_modified") or g.get("data_last_modified")
            if rec.get("complete") and rec.get("video_last_modified") == stamp:
                report["games_done"] += 1
                report["pitches"] += len(rec.get("pitches", []))
                report["pitches_with_video"] += sum(1 for p in rec.get("pitches", []) if p.get("clips"))
                continue
            if rec.get("video_last_modified") != stamp:
                rec = {"game": mg, "date": g.get("date"), "opponent": (g.get("opponent") or {}).get("name"),
                       "owner": (g.get("owner_team") or {}).get("name"), "video_last_modified": stamp,
                       "pitches": rec.get("pitches", []), "complete": False}
            # 2. every pitch in the game
            if not rec["pitches"]:
                ev = (api.get(f"/event/{mg}") or {}).get("data") or {}
                rec["pitches"] = [{
                    "uid": p.get("pitchuid"), "key": p.get("performance_data_key"),
                    "date": ev.get("game_date") or g.get("date"),
                    "inn": p.get("inning_number"), "half": p.get("top_or_bottom"),
                    "pa": p.get("paofinning"), "ppa": p.get("pitchofpa"),
                    "batter": p.get("batter_name"), "pitcher": p.get("pitcher_name"),
                    "b": p.get("balls"), "s": p.get("strikes"),
                } for p in ev.get("pitch_events", []) if p.get("performance_data_key")]
                f.write_text(json.dumps(rec, separators=(",", ":")))
            # 3. video angles for each pitch not fetched yet
            todo = [p for p in rec["pitches"] if "clips" not in p]
            log(f"  {g.get('date')} vs {rec.get('opponent') or '?'} ({mg}): {len(rec['pitches'])} pitches, {len(todo)} to fetch")
            try:
                for k, p in enumerate(todo):
                    a = api.get(f"/team/{team}/clip/{p['key']}/angles") or {}
                    p["clips"] = [[c.get("perspective") or "Video", c.get("video_url"), c.get("thumbnail_url")]
                                  for c in a.get("clips", []) if c.get("video_url")]
                    if k % 25 == 24:
                        f.write_text(json.dumps(rec, separators=(",", ":")))
            finally:   # time limit or error: keep every pitch fetched so far
                f.write_text(json.dumps(rec, separators=(",", ":")))
            rec["complete"] = True
            f.write_text(json.dumps(rec, separators=(",", ":")))
            report["games_done"] += 1
            report["pitches"] += len(rec["pitches"])
            report["pitches_with_video"] += sum(1 for p in rec["pitches"] if p.get("clips"))
    except OutOfTime:
        report["requests"] = api.calls
        return finish(f"time limit reached; {report['games_done']} of {report['games']} games done, "
                      "the rest are picked up next run")
    except PermissionError as e:
        report["requests"] = api.calls
        return finish(str(e))
    except Exception as e:
        report["errors"].append(str(e)[:300])
        report["requests"] = api.calls
        return finish(f"stopped on an error: {str(e)[:200]}")
    report["requests"] = api.calls
    finish(f"up to date: {report['games_done']} games, {report['pitches_with_video']:,} pitches with video")


if __name__ == "__main__":
    sys.exit(main())
