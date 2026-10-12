#!/usr/bin/env python3
"""
Pull NCAA D1 player-season stats from the TruMedia baseball API for
BirdballSavant's NCAA research page and Power 4 percentile rankings.

Credentials are read from environment variables (GitHub repository secrets):
    TRUMEDIA_USERNAME, TRUMEDIA_SITENAME, TRUMEDIA_MASTER_TOKEN
Settings live in scripts/trumedia.json. If the pull is disabled, credentials are
missing, or TruMedia can't be reached, this script exits quietly and the site
builds exactly as before (any previously pulled files are kept).

Writes site/data/ncaa-<year>.json and site/data/ncaa-report.json.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path(__file__).resolve().parent / "trumedia.json"
OUT = ROOT / "site" / "data"
API = os.environ.get("TRUMEDIA_API_BASE", "https://api.trumedianetworks.com").rstrip("/")
TIMEOUT = 180

ID_CANDIDATES = {
    "id": ["playerId", "playerID", "PlayerId", "player_id", "id"],
    "name": ["playerFullName", "fullName", "playerName", "PlayerName", "name", "abbrevName"],
    "team": ["newestTeamName", "teamName", "TeamName", "team", "newestTeamAbbrevName", "teamAbbrevName"],
    "teamId": ["newestTeamId", "teamId", "TeamId", "team_id"],
    "conf": ["conference", "conferenceName", "newestTeamConference", "teamConference", "conf", "league"],
    "pos": ["pos", "position", "primaryPosition", "playerPosition"],
    "year": ["seasonYear", "season", "year"],
    "bats": ["batsHand", "bats", "batHand"],
    "throws": ["throwsHand", "throws", "throwHand"],
}


def log(*a):
    print(*a, flush=True)


def norm(s: str) -> str:
    s = str(s).lower().replace("&", " and ").replace("st.", "state")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


class TruMedia:
    def __init__(self, username, sitename, master):
        res = requests.post(f"{API}/v1/siteadmin/api/createTempPBToken",
                            headers={"Content-Type": "application/json"},
                            data=json.dumps({"username": username, "sitename": sitename, "token": master}),
                            timeout=60)
        res.raise_for_status()
        tok = res.json().get("pbTempToken")
        if not tok:
            raise RuntimeError("TruMedia did not return a token (check username, site name and master token)")
        self.tok = tok

    def query(self, fmt: str, params: dict, columns: list[str] | None = None, filters: str | None = None) -> pd.DataFrame:
        q = "&".join(f"{k}={urllib.parse.quote(str(v), safe=',')}" for k, v in params.items())
        if columns:
            q += "&columns=" + urllib.parse.quote(",".join(f"[{c}]" for c in columns))
        if filters:
            q += "&filters=" + urllib.parse.quote(f"({filters})", safe="()")
        url = f"{API}/v1/mlbapi/custom/baseball/DirectedQuery/{fmt}.csv?{q}&token={self.tok}"
        for attempt in range(3):
            res = requests.get(url, timeout=TIMEOUT)
            if res.status_code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            if res.status_code != 200:
                raise QueryError(res.status_code, res.text[:300])
            text = res.text.strip()
            if not text:
                return pd.DataFrame()
            return pd.read_csv(io.StringIO(text))
        raise QueryError(res.status_code, res.text[:300])


class QueryError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status = status


def pull_side(tm: TruMedia, year: int, cfg: dict, side: str, report: dict) -> pd.DataFrame | None:
    """Pull one side (hitting/pitching). If TruMedia rejects the column list, test each
    column on its own and keep the ones it accepts."""
    cols = cfg[f"{side}_columns"]
    params = {"seasonYear": year, "seasonType": cfg.get("seasonType", "REG"), "format": "RAW"}
    filt = cfg.get("filter")
    try:
        df = tm.query("PlayerSeasons", params, cols, filt)
        report["columns_ok"] = cols
        report["columns_rejected"] = []
        return df
    except QueryError as e:
        log(f"    full column list rejected ({e}); checking columns one by one")
    good, bad = [], []
    for c in cols:
        try:
            tm.query("PlayerSeasons", {**params, "qualification": "[PA] >= 100" if side == "hitting" else "[IP] >= 30"}, [c], filt)
            good.append(c)
        except QueryError:
            bad.append(c)
    report["columns_ok"], report["columns_rejected"] = good, bad
    log(f"    accepted {len(good)} columns, rejected {bad}")
    if not good:
        return None
    return tm.query("PlayerSeasons", params, good, filt)


def pick(df, role):
    for c in ID_CANDIDATES[role]:
        if c in df.columns:
            return c
    low = {c.lower(): c for c in df.columns}
    for c in ID_CANDIDATES[role]:
        if c.lower() in low:
            return low[c.lower()]
    return None


def p4_lookup(cfg):
    names = {}
    for conf, teams in cfg.get("power4", {}).items():
        for t in teams:
            names[norm(t)] = (conf, t)
            for a in cfg.get("team_aliases", {}).get(t, []):
                names[norm(a)] = (conf, t)
    return names


def tidy(df: pd.DataFrame, cfg: dict, side: str, p4: dict, report: dict):
    ids = {role: pick(df, role) for role in ID_CANDIDATES}
    report["id_columns"] = {k: v for k, v in ids.items() if v}
    if not ids["name"]:
        raise RuntimeError(f"no player-name column in TruMedia response; columns were {list(df.columns)[:30]}")
    stat_cols = [c for c in cfg[f"{side}_columns"] if c in df.columns]
    # TruMedia may echo columns without brackets or with different case
    lower = {c.lower(): c for c in df.columns}
    for c in cfg[f"{side}_columns"]:
        if c not in stat_cols and c.lower() in lower:
            df = df.rename(columns={lower[c.lower()]: c})
            stat_cols.append(c)
    rows = []
    confs_found = {}
    for rec in df.to_dict("records"):
        team = str(rec.get(ids["team"], "") or "") if ids["team"] else ""
        conf_raw = str(rec.get(ids["conf"], "") or "") if ids["conf"] else ""
        conf, canon = None, None
        if conf_raw:
            cr = norm(conf_raw)
            for c in cfg.get("power4", {}):
                if cr == norm(c) or cr.startswith(norm(c) + " "):
                    conf = c
        hit = p4.get(norm(team))
        if hit:
            conf = conf or hit[0]
            canon = hit[1]
        if conf:
            confs_found.setdefault(conf, set()).add(canon or team)
        vals = []
        for c in stat_cols:
            v = rec.get(c)
            if isinstance(v, str):
                v = v.replace("%", "").replace(",", "").strip()
            try:
                v = float(v)
                v = None if v != v else round(v, 4)
            except (TypeError, ValueError):
                v = None
            vals.append(v)
        rows.append([
            str(rec.get(ids["id"], "")) if ids["id"] else "",
            str(rec.get(ids["name"], "")),
            team,
            str(rec.get(ids["teamId"], "")) if ids["teamId"] else "",
            conf_raw or (conf or ""),
            1 if conf else 0,
            str(rec.get(ids["pos"], "") or "") if ids["pos"] else "",
            str(rec.get(ids["bats"] if side == "hitting" else ids["throws"], "") or "") if (ids["bats"] if side == "hitting" else ids["throws"]) else "",
            *vals,
        ])
    report["power4_teams_matched"] = {c: len(t) for c, t in confs_found.items()}
    expected = {c: len(t) for c, t in cfg.get("power4", {}).items()}
    report["power4_teams_missing"] = {c: sorted(set(cfg["power4"][c]) - confs_found.get(c, set()))
                                      for c in expected if set(cfg["power4"][c]) - confs_found.get(c, set())}
    return {"fields": ["id", "name", "team", "teamId", "conf", "p4", "pos", "hand"], "stats": stat_cols, "rows": rows}


def main():
    cfg = json.loads(CONFIG.read_text())
    report = {"ran": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status": "", "years": {}}
    OUT.mkdir(parents=True, exist_ok=True)

    def finish(status):
        report["status"] = status
        (OUT / "ncaa-report.json").write_text(json.dumps(report, indent=1))
        log(f"TruMedia: {status}")

    if not cfg.get("enabled"):
        for f in OUT.glob("ncaa-[0-9]*.json"):
            f.unlink()   # turning the pull off also takes TruMedia data off the site
        return finish("disabled in scripts/trumedia.json")
    user, site, master = (os.environ.get(k, "").strip() for k in
                          ("TRUMEDIA_USERNAME", "TRUMEDIA_SITENAME", "TRUMEDIA_MASTER_TOKEN"))
    if not (user and site and master):
        return finish("skipped: TruMedia secrets are not set in the repository")
    try:
        tm = TruMedia(user, site, master)
    except Exception as e:
        return finish(f"could not sign in to TruMedia ({str(e)[:200]})")

    p4 = p4_lookup(cfg)
    ok_years = 0
    for year in cfg.get("seasons", []):
        yr = report["years"].setdefault(str(year), {})
        out = {"year": year, "pulled": report["ran"], "qualify": cfg.get("qualify", {}),
               "percentile_map": cfg.get("percentile_map", {})}
        try:
            for side in ("hitting", "pitching"):
                srep = yr.setdefault(side, {})
                log(f"  {year} {side}: pulling")
                df = pull_side(tm, year, cfg, side, srep)
                if df is None or df.empty:
                    srep["rows"] = 0
                    continue
                out[side] = tidy(df, cfg, side, p4, srep)
                srep["rows"] = len(out[side]["rows"])
                srep["power4_rows"] = sum(r[5] for r in out[side]["rows"])
                log(f"    {srep['rows']} players ({srep['power4_rows']} Power 4); "
                    f"Power 4 teams matched: {srep.get('power4_teams_matched')}")
                if srep.get("power4_teams_missing"):
                    log(f"    ! Power 4 teams not found (add aliases in trumedia.json): {srep['power4_teams_missing']}")
            if out.get("hitting") or out.get("pitching"):
                (OUT / f"ncaa-{year}.json").write_text(json.dumps(out, separators=(",", ":")))
                ok_years += 1
        except Exception as e:
            yr["error"] = str(e)[:300]
            log(f"  ! {year}: {e}")
    finish(f"pulled {ok_years} of {len(cfg.get('seasons', []))} seasons" if ok_years else "no seasons pulled; see errors")


if __name__ == "__main__":
    sys.exit(main())
