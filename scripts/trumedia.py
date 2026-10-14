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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path(__file__).resolve().parent / "trumedia.json"
OUT = ROOT / "site" / "data"
API = os.environ.get("TRUMEDIA_API_BASE", "https://api.trumedianetworks.com").rstrip("/")
TIMEOUT = 90            # seconds per request
DEFAULT_BUDGET_MIN = 30 # whole NCAA pull stops asking TruMedia after this; what's done is kept

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
    def __init__(self, username, sitename, master, budget_min: float | None = None):
        self.deadline = time.time() + 60 * budget_min if budget_min else None
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
        for attempt in range(2):
            if self.out_of_time():
                raise OutOfTime()
            try:
                res = requests.get(url, timeout=TIMEOUT)
            except requests.RequestException as e:
                if attempt == 0:
                    continue
                raise QueryError(0, f"no answer from TruMedia ({type(e).__name__})")
            if res.status_code in (429, 502, 503, 504) and attempt == 0:
                time.sleep(5)
                continue
            if res.status_code != 200:
                raise QueryError(res.status_code, res.text[:4000])
            text = res.text.strip()
            if not text:
                return pd.DataFrame()
            return pd.read_csv(io.StringIO(text))
        raise QueryError(res.status_code, res.text[:4000])

    def out_of_time(self):
        return self.deadline is not None and time.time() > self.deadline


def error_text(body: str) -> str:
    """TruMedia errors can come back as a Tomcat HTML page; keep just the message."""
    if "<" in body:
        m = re.search(r"<b>(?:Message|Description)</b>\s*(.*?)</p>", body, re.S | re.I)
        body = m.group(1) if m else re.sub(r"<style.*?</style>|<[^>]+>", " ", body, flags=re.S)
    return re.sub(r"\s+", " ", body).strip()[:400]


class QueryError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {error_text(body)}" if status else error_text(body))
        self.status = status


class OutOfTime(QueryError):
    def __init__(self):
        super().__init__(0, "time limit for this run reached; the rest is picked up next run")


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


TEAM_NAME_COLS = ["teamName", "newestTeamName", "fullName", "teamFullName", "name", "displayName", "school",
                  "organization", "abbrevName", "teamAbbrevName", "newestTeamAbbrevName"]
TEAM_ID_COLS = ["teamId", "newestTeamId", "id", "team_id", "TeamId"]
CONF_COLS = ["conference", "conferenceName", "conferenceAbbrevName", "teamConference", "newestTeamConference", "conf", "league", "leagueName"]


def first_col(df, names):
    low = {c.lower(): c for c in df.columns}
    for n in names:
        if n.lower() in low:
            return low[n.lower()]
    return None


def clean_id(v):
    if v is None or (isinstance(v, float) and v != v):
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


class TeamLabeler:
    """Gives every pulled player a team (and conference) when TruMedia's all-D1 query
    leaves them out. Order of preference:
      1. team name already in the response;
      2. team ID in the response, looked up in AllTeams;
      3. one PlayerTotals query per team (Power 4 first) to learn each roster."""

    def __init__(self, tm, year, cfg, p4, report):
        self.tm, self.year, self.cfg, self.p4, self.rep = tm, year, cfg, p4, report
        self.teams = None        # teamId -> {"name", "conf"}
        self.members = None      # playerId or name -> teamId

    def load_teams(self):
        if self.teams is not None:
            return self.teams
        self.teams = {}
        t = all_teams(self.tm, self.year, self.rep)
        if t is None or t.empty:
            return self.teams
        idc, nc, cc = first_col(t, TEAM_ID_COLS), first_col(t, TEAM_NAME_COLS), first_col(t, CONF_COLS)
        lg = next((c for c in t.columns if c.lower() in ("gameleague", "teamleague", "level", "teamlevel", "seasonlevel", "division")), None)
        if lg is not None and t[lg].astype(str).str.upper().eq("D1").any():
            t = t[t[lg].astype(str).str.upper().eq("D1")]
        self.rep["all_teams_used_columns"] = {"id": idc, "name": nc, "conference": cc}
        if idc is None:
            return self.teams
        for rec in t.to_dict("records"):
            tid = clean_id(rec.get(idc))
            if tid:
                self.teams[tid] = {"name": str(rec.get(nc, "") or "") if nc else "",
                                   "conf": str(rec.get(cc, "") or "") if cc else ""}
        return self.teams

    def is_p4(self, info):
        conf = norm(info.get("conf", ""))
        if conf and any(conf == norm(c) or conf.startswith(norm(c) + " ") for c in self.cfg.get("power4", {})):
            return True
        return match_p4(info.get("name", ""), self.p4) is not None

    def load_members(self, key_col_name):
        if self.members is not None:
            return self.members
        teams = self.load_teams()
        # Rosters are saved between runs (site/data/ncaa-rosters-<year>.json, kept by the workflow
        # cache), so each run only asks about teams it hasn't seen or whose roster is a week old.
        cache_f = OUT / f"ncaa-rosters-{self.year}.json"
        try:
            cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
        except ValueError:
            cache = {}
        if cache.get("key") != key_col_name:
            cache = {}
        seen = cache.get("teams", {})          # teamId -> date asked
        self.members = dict(cache.get("members", {}))
        if not teams:
            return self.members
        order = sorted(teams, key=lambda t: not self.is_p4(teams[t]))
        if not self.cfg.get("label_all_teams", True):
            order = [t for t in order if self.is_p4(teams[t])]
        stale = datetime.now(timezone.utc) - timedelta(days=7)
        current = self.year >= datetime.now(timezone.utc).year
        def fresh(t):
            d = seen.get(t)
            return bool(d) and (not current or datetime.fromisoformat(d) > stale)
        todo = [t for t in order if not fresh(t)]
        base = {"seasonYear": self.year, "seasonType": self.cfg.get("seasonType", "REG"), "format": "RAW"}
        done = failed = streak = 0
        log(f"    rosters: {len(order) - len(todo)} of {len(order)} teams saved from earlier runs; asking about {len(todo)} (Power 4 first)")
        try:
            for tid in todo:
                df = None
                for cols in (["PA", "IP"], ["PA"], ["IP"]):
                    try:
                        df = self.tm.query("PlayerTotals", {**base, "teamId": tid}, cols)
                        break
                    except OutOfTime:
                        raise
                    except QueryError:
                        continue
                if df is None:
                    failed += 1
                    streak += 1
                    if streak >= 15:
                        log("    ! 15 roster queries in a row failed; stopping roster lookups for this run")
                        break
                    continue
                done += 1
                streak = 0
                seen[tid] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                kc = first_col(df, [key_col_name]) or pick(df, "id") or pick(df, "name")
                if kc is None:
                    continue
                for v in df[kc].tolist():
                    k = clean_id(v)
                    if k:
                        self.members[k] = tid
        except OutOfTime:
            log("    ! time limit reached during roster lookups; the remaining teams are asked next run")
            self.rep["time_limit_hit"] = True
        cache_f.write_text(json.dumps({"key": key_col_name, "teams": seen, "members": self.members}, separators=(",", ":")))
        self.rep["roster_queries"] = {"teams": len(order), "saved": len(order) - len(todo), "ok": done, "failed": failed,
                                      "players": len(self.members)}
        log(f"    rosters: {done} teams answered this run, {failed} failed, {len(self.members)} players placed")
        return self.members

    def label(self, df: pd.DataFrame, srep: dict) -> pd.DataFrame:
        tcol, idcol = pick(df, "team"), pick(df, "teamId")
        if tcol and df[tcol].astype(str).str.strip().replace("nan", "").ne("").mean() > 0.8:
            srep["team_source"] = "TruMedia response"
            return df
        teams = self.load_teams()
        df = df.copy()
        if idcol and df[idcol].notna().mean() > 0.8 and teams:
            tids = df[idcol].map(clean_id)
            srep["team_source"] = "team ID looked up in AllTeams"
        else:
            key = pick(df, "id") or pick(df, "name")
            members = self.load_members(key)
            tids = df[key].map(clean_id).map(members) if key else pd.Series([None] * len(df))
            srep["team_source"] = "per-team roster queries"
        df["__teamId"] = tids
        df["__team"] = tids.map(lambda t: teams.get(t, {}).get("name", "") if t else "")
        df["__conf"] = tids.map(lambda t: teams.get(t, {}).get("conf", "") if t else "")
        srep["players_with_team"] = int(df["__team"].astype(str).ne("").sum())
        return df


# Words that, right after a Power 4 school name, mean it's a different school (Texas State, Miami (OH)...)
NOT_SAME_SCHOOL = {"state", "st", "southern", "tech", "christian", "atlantic", "international", "baptist", "poly",
                   "city", "valley", "commonwealth", "chicago", "omaha", "arlington", "martin", "northern", "eastern",
                   "western", "central", "a", "oh", "ohio", "gulf", "pine", "fort", "san", "rio", "corpus", "upstate",
                   "wesleyan", "lutheran", "pacific", "coastal", "gwinnett", "southwestern"}
TWO_WORD_MASCOTS = {"tar heels", "blue devils", "demon deacons", "golden bears", "yellow jackets", "fighting irish",
                    "crimson tide", "sun devils", "red raiders", "horned frogs", "golden gophers", "fighting illini",
                    "scarlet knights", "nittany lions", "golden eagles", "black knights"}


def match_p4(name, p4):
    """Power 4 match for a team name, allowing a trailing mascot ('Miami (FL) Hurricanes')."""
    n = norm(name)
    if not n:
        return None
    if n in p4:
        return p4[n]
    best = None
    for k, v in p4.items():
        if n.startswith(k + " ") and (best is None or len(k) > len(best[0])):
            best = (k, v)
    if not best:
        return None
    rest = n[len(best[0]):].split()
    if rest and rest[0] in NOT_SAME_SCHOOL:
        return None
    if len(rest) == 1 or (len(rest) == 2 and " ".join(rest) in TWO_WORD_MASCOTS):
        return best[1]
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
        team = str(rec.get("__team") or (rec.get(ids["team"], "") if ids["team"] else "") or "")
        conf_raw = str(rec.get("__conf") or (rec.get(ids["conf"], "") if ids["conf"] else "") or "")
        if team == "nan":
            team = ""
        if conf_raw == "nan":
            conf_raw = ""
        conf, canon = None, None
        if conf_raw:
            cr = norm(conf_raw)
            aliases = {"ACC": ["atlantic coast", "atlantic coast conference", "acc"], "SEC": ["southeastern", "southeastern conference", "sec"],
                       "Big Ten": ["big ten", "big 10", "b1g", "big ten conference"], "Big 12": ["big 12", "big twelve", "big 12 conference"]}
            for c in cfg.get("power4", {}):
                names = [norm(c)] + [norm(a) for a in aliases.get(c, [])]
                if any(cr == n or cr.startswith(n + " ") for n in names):
                    conf = c
        hit = match_p4(team, p4)
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
            clean_id(rec.get("__teamId")) or (clean_id(rec.get(ids["teamId"])) if ids["teamId"] else ""),
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
        tm = TruMedia(user, site, master, float(cfg.get("time_limit_minutes", DEFAULT_BUDGET_MIN)))
    except Exception as e:
        return finish(f"could not sign in to TruMedia ({str(e)[:200]})")

    p4 = p4_lookup(cfg)
    ok_years = 0
    for year in cfg.get("seasons", []):
        yr = report["years"].setdefault(str(year), {})
        strats, chosen = strategies(tm, year, cfg, yr, p4), {}
        labeler = TeamLabeler(tm, year, cfg, p4, yr)
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
                df = labeler.label(df, srep)
                log(f"    teams from: {srep.get('team_source')}"
                    + (f" ({srep.get('players_with_team')} of {len(df)} players placed)" if 'players_with_team' in srep else ""))
                out[side] = tidy(df, cfg, side, p4, srep)
                srep["rows"] = len(out[side]["rows"])
                srep["power4_rows"] = sum(r[5] for r in out[side]["rows"])
                log(f"    {srep['rows']} players ({srep['power4_rows']} Power 4); "
                    f"Power 4 teams matched: {srep.get('power4_teams_matched')}")
                if srep.get("power4_teams_missing"):
                    log(f"    ! Power 4 teams not found (add aliases in trumedia.json): {srep['power4_teams_missing']}")
            yf = OUT / f"ncaa-{year}.json"
            if tm.out_of_time() and yf.exists():
                log(f"  {year}: time limit reached mid-pull; keeping the last complete {year} pull on the site")
            elif out.get("hitting") or out.get("pitching"):
                yf.write_text(json.dumps(out, separators=(",", ":")))
                ok_years += 1
        except Exception as e:
            yr["error"] = str(e)[:300]
            log(f"  ! {year}: {e}")
        if tm.out_of_time():
            report["time_limit_hit"] = True
            log("  ! time limit reached; earlier pulls are kept and the rest is picked up next run")
            break
    finish(f"pulled {ok_years} of {len(cfg.get('seasons', []))} seasons" if ok_years else "no seasons pulled; see errors")


if __name__ == "__main__":
    sys.exit(main())
