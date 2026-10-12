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
            q += "&filters=" + urllib.parse.quote(f"({filters})", safe="()'")
        url = f"{API}/v1/mlbapi/custom/baseball/DirectedQuery/{fmt}.csv?{q}&token={self.tok}"
        for attempt in range(3):
            res = requests.get(url, timeout=TIMEOUT)
            if res.status_code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            if res.status_code != 200:
                raise QueryError(res.status_code, res.text[:4000])
            text = res.text.strip()
            if not text:
                return pd.DataFrame()
            return pd.read_csv(io.StringIO(text))
        raise QueryError(res.status_code, res.text[:4000])


def error_text(body: str) -> str:
    """TruMedia errors can come back as a Tomcat HTML page; keep just the message."""
    if "<" in body:
        m = re.search(r"<b>(?:Message|Description)</b>\s*(.*?)</p>", body, re.S | re.I)
        body = m.group(1) if m else re.sub(r"<style.*?</style>|<[^>]+>", " ", body, flags=re.S)
    return re.sub(r"\s+", " ", body).strip()[:400]


class QueryError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {error_text(body)}")
        self.status = status


def all_teams(tm: TruMedia, year: int, report: dict) -> pd.DataFrame | None:
    """Documented query: AllTeams.csv?seasonYear=YYYY. Used for team IDs (per-team fallback)."""
    try:
        t = tm.query("AllTeams", {"seasonYear": year})
    except QueryError as e:
        report["all_teams_error"] = str(e)
        log(f"    AllTeams query failed: {e}")
        return None
    report["all_teams_columns"] = list(t.columns)[:40]
    report["all_teams_rows"] = len(t)
    log(f"    AllTeams: {len(t)} teams; columns {list(t.columns)[:25]}")
    return t


def team_ids(teams: pd.DataFrame, cfg: dict, p4: dict) -> list[str]:
    idc = next((c for c in teams.columns if c.lower() in ("teamid", "id", "team_id")), None)
    if idc is None:
        return []
    df = teams
    lg = next((c for c in df.columns if c.lower() in ("gameleague", "league", "teamleague", "level", "teamlevel", "seasonlevel", "division")), None)
    if lg is not None and df[lg].astype(str).str.upper().eq("D1").any():
        df = df[df[lg].astype(str).str.upper().eq("D1")]
    return [str(int(x)) if isinstance(x, float) and x == x else str(x) for x in df[idc].dropna().unique()]


class Strategy:
    """One way of asking TruMedia for every D1 player's season line."""
    def __init__(self, name, run):
        self.name, self.run = name, run


def strategies(tm, year, cfg, rep_year, p4):
    base = {"seasonYear": year, "seasonType": cfg.get("seasonType", "REG"), "format": "RAW"}
    filt = cfg.get("filter")
    out = [
        Strategy("PlayerTotals, all D1", lambda cols, qual=None: tm.query("PlayerTotals", {**base, **({"qualification": qual} if qual else {})}, cols, filt)),
        Strategy("PlayerSeasons, all D1", lambda cols, qual=None: tm.query("PlayerSeasons", {**base, **({"qualification": qual} if qual else {})}, cols, filt)),
    ]
    cache = {}

    def by_team(cols, qual=None, sample=False):
        if "ids" not in cache:
            t = all_teams(tm, year, rep_year)
            cache["ids"] = team_ids(t, cfg, p4) if t is not None else []
            rep_year["teams_for_pull"] = len(cache["ids"])
        ids = cache["ids"]
        if not ids:
            raise QueryError(0, "no team IDs available from AllTeams")
        batches = [ids[i:i + 10] for i in range(0, len(ids), 10)]
        if sample:
            batches = batches[:1]
        frames = []
        for b in batches:
            p = {**base, "teamId": ",".join(b)}
            if qual:
                p["qualification"] = qual
            frames.append(tm.query("PlayerTotals", p, cols))
        return pd.concat([f for f in frames if not f.empty], ignore_index=True) if frames else pd.DataFrame()

    out.append(Strategy("PlayerTotals, team by team", by_team))
    return out


def pull_side(tm: TruMedia, year: int, cfg: dict, side: str, report: dict, strat_list, chosen: dict) -> pd.DataFrame | None:
    """Find a query format TruMedia accepts (probing with one basic stat), then pull the
    full column list; if that is rejected, test columns one at a time."""
    cols = cfg[f"{side}_columns"]
    probe = "PA" if side == "hitting" else "IP"
    order = ([chosen["s"]] if chosen.get("s") else []) + [s for s in strat_list if s is not chosen.get("s")]
    attempts = report.setdefault("attempts", [])
    for st in order:
        try:
            run = (lambda c, q=None: st.run(c, q, sample=True)) if st.name.endswith("team by team") else st.run
            test = run([probe])
            if test is None or test.empty:
                attempts.append(f"{st.name}: no rows")
                log(f"    {st.name}: accepted but returned no rows")
                continue
        except QueryError as e:
            attempts.append(f"{st.name}: {e}")
            log(f"    {st.name}: {e}")
            continue
        chosen["s"] = st
        report["query"] = st.name
        log(f"    using {st.name}")
        try:
            df = st.run(cols)
            report["columns_ok"], report["columns_rejected"] = cols, []
            return df
        except QueryError as e:
            log(f"    full column list rejected ({e}); checking columns one by one")
        good, bad = [], []
        for c in cols:
            try:
                (lambda cc: st.run(cc, None, sample=True) if st.name.endswith("team by team") else st.run(cc))([c])
                good.append(c)
            except QueryError:
                bad.append(c)
        report["columns_ok"], report["columns_rejected"] = good, bad
        log(f"    accepted {len(good)} columns, rejected {bad}")
        return st.run(good) if good else None
    return None


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
        strats, chosen = strategies(tm, year, cfg, yr, p4), {}
        out = {"year": year, "pulled": report["ran"], "qualify": cfg.get("qualify", {}),
               "percentile_map": cfg.get("percentile_map", {})}
        try:
            for side in ("hitting", "pitching"):
                srep = yr.setdefault(side, {})
                log(f"  {year} {side}: pulling")
                df = pull_side(tm, year, cfg, side, srep, strats, chosen)
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
