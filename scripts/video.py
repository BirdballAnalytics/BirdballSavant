"""
Match video clips to pitches, at-bats, games and players (used by build.py).

Two sources:
  * TruMedia GameVideo answers saved by scripts/video_pull.py (site/data/video-tm/*.json)
  * AWRE clip lists uploaded to data/video/ (.csv / .xlsx / .xls)

Only links are stored; the video stays on AWRE / TruMedia. Each clip row is
matched as precisely as its columns allow:
  pitch    PitchUID, or GameID + PitchNo, or date/game + inning + half + PA + pitch of PA,
           or date + batter + inning + pitch of PA (or count)
  at-bat   date/game + batter (+ inning, + PA of inning) that points at a single plate appearance
  game     only a date (+ opponent / game number) -> full-game link on the game page
  player   date + player with nothing else -> player's Video list (bullpens, BP, practice)
  other    anything else with a date -> Video page list (practices, scrimmages)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

URL_RE = re.compile(r"^\s*(?:https?:)?//\S+\s*$|^\s*www\.\S+\s*$", re.I)


def fix_url(u: str) -> str:
    u = u.strip()
    if u.startswith("//"):
        return "https:" + u
    if u.lower().startswith("www."):
        return "https://" + u
    return u
VIDEO_EXT = (".csv", ".xlsx", ".xls")
PRACTICE = re.compile(r"(?i)\b(practice|bullpen|pen|bp|batting practice|drill|cage|scrimmage live|lift|workout)\b")

KEYS = {
    "uid": ["pitchuid", "trackmanpitchuid", "trackmanpitchid", "pitchguid", "tmpitchuid", "pitchtrackmanid"],
    "gid": ["gameid", "trackmangameid", "tmgameid"],
    "pno": ["pitchno", "pitchnumber", "gamepitchnumber", "pitchnum", "pitchofgame", "gamepitchno", "pitchseq"],
    "date": ["date", "gamedate", "eventdate", "sessiondate", "day"],
    "inn": ["inning", "inn"],
    "half": ["topbottom", "half", "inninghalf", "topbot", "tb", "topbottominning"],
    "paoi": ["paofinning", "abofinning", "batterofinning", "paininning", "plateappearanceofinning"],
    "ppa": ["pitchofpa", "pitchinpa", "pitchofab", "pitchinab", "pitchnumberinpa", "pitchofplateappearance", "papitchnumber"],
    "batter": ["batter", "hitter", "battername", "hittername", "batterfullname"],
    "pitcher": ["pitcher", "pitchername", "pitcherfullname"],
    "player": ["player", "playername", "athlete", "name", "playerfullname"],
    "balls": ["balls", "ballcount"],
    "strikes": ["strikes", "strikecount"],
    "opp": ["opponent", "opp", "vs", "opponentname"],
    "gnum": ["gamenumber", "game", "gameno", "dh"],
    "angle": ["angle", "camera", "view", "cameraangle", "cam"],
    "title": ["title", "clip", "cliptitle", "description", "label", "notes", "event", "session", "type"],
}


def _n(c) -> str:
    return re.sub(r"[^a-z0-9]", "", str(c).lower())


def pretty(col: str, names: dict) -> str:
    if col in names:
        return names[col]
    s = re.sub(r"(?i)(url|link|href|video|clip)s?$", "", str(col)).strip(" _-")
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s).replace("_", " ").strip()
    return s[:1].upper() + s[1:] if s else "Video"


def name_key(s) -> str | None:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    if not s or s.lower() in ("nan", "none"):
        return None
    if "," in s:
        last, _, first = s.partition(",")
    else:
        parts = s.split(" ")
        first, last = parts[0], parts[-1] if len(parts) > 1 else ""
    last, first = re.sub(r"[^a-z]", "", last.lower()), re.sub(r"[^a-z]", "", first.lower())
    return f"{last}|{first[:1]}" if last else None


def num(v):
    x = pd.to_numeric(pd.Series([v]), errors="coerce").iloc[0]
    return None if pd.isna(x) else float(x)


def text(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("nan", "none", "nat") else s


def half_of(v):
    s = text(v).lower()
    if s.startswith("t") or s in ("1", "away"):
        return "Top"
    if s.startswith("b") or s in ("2", "home"):
        return "Bottom"
    return None


def as_date(v, fallback=None):
    s = text(v)
    if not s:
        return fallback
    d = pd.to_datetime(s, errors="coerce", format="mixed")
    return fallback if pd.isna(d) else d.date()


# ----------------------------------------------------------------------------
def read_table(path: Path) -> pd.DataFrame | None:
    try:
        if path.suffix.lower() == ".csv":
            return pd.read_csv(path, dtype=str, keep_default_na=False)
        frames = [f.fillna("") for f in pd.read_excel(path, sheet_name=None, dtype=str).values() if len(f.columns)]
        return pd.concat(frames, ignore_index=True) if frames else None
    except Exception:
        return None


def clip_rows(df: pd.DataFrame, names: dict):
    """Yield (fields, clips) for each row of a clip table."""
    cols = {k: next((c for c in df.columns if _n(c) in v), None) for k, v in KEYS.items()}
    url_cols = []
    for c in df.columns:
        vals = [text(x) for x in df[c].tolist()]
        vals = [x for x in vals if x]
        if vals and sum(bool(URL_RE.match(x)) for x in vals) >= 0.5 * len(vals):
            url_cols.append(c)
    for rec in df.to_dict("records"):
        clips = []
        for c in url_cols:
            u = text(rec.get(c))
            if URL_RE.match(u):
                lab = text(rec.get(cols["angle"])) if cols["angle"] and len(url_cols) == 1 else ""
                clips.append({"l": lab or pretty(c, names), "u": fix_url(u)})
        if not clips:
            continue
        f = {k: (rec.get(c) if c else None) for k, c in cols.items()}
        yield f, clips


# ----------------------------------------------------------------------------
class Matcher:
    def __init__(self, df: pd.DataFrame, bc_code: str, teams: dict | None = None):
        self.df = df
        self.bc = bc_code
        self.teams = teams or {}
        d = df
        self.idx = d.index
        self.by_uid = {str(u): i for i, u in zip(d.index, d["PitchUID"]) if isinstance(u, str) and u}
        self.by_gid = {g: gg for g, gg in d.groupby("GameID")}
        self.games_on = {}
        for g, gg in self.by_gid.items():
            self.games_on.setdefault(gg["gdate"].iloc[0], []).append(g)
        self.bkey = {i: name_key(n) for i, n in zip(d.index, d["Batter"])}
        self.pkey = {i: name_key(n) for i, n in zip(d.index, d["Pitcher"])}
        # plate-appearance id per row
        pa = d["GameID"].astype(str) + "|" + d["Inning"].astype(str) + "|" + d["Top/Bottom"].astype(str) + "|" + d["PAofInning"].astype(str)
        res = d["nt"].fillna(0).ge(1)
        pa[res] = d.loc[res, "GameID"].astype(str) + "|r" + d.loc[res, "PitchNo"].astype(str)
        self.paid = pa

    def pick_games(self, f, gid_hint):
        gid = text(f.get("gid")) or gid_hint
        if gid:
            return [gid] if gid in self.by_gid else []
        d = as_date(f.get("date"), f.get("_fdate"))
        games = list(self.games_on.get(d, []))
        opp = _n(text(f.get("opp")).replace("@", ""))
        if opp and len(games) > 1:
            def names(g):
                codes = set(self.by_gid[g][["PitcherTeam", "BatterTeam"]].stack().dropna().astype(str)) - {self.bc}
                return {_n(x) for c in codes for x in (c, self.teams.get(c, c))} - {""}
            sub = [g for g in games if any(opp in n or n in opp for n in names(g))]
            games = sub or games
        gn = num(f.get("gnum"))
        if gn and len(games) > 1:
            games = sorted(games)
            games = [games[int(gn) - 1]] if 0 < gn <= len(games) else games
        return games

    def match(self, f, gid_hint=None):
        """-> (kind, target)  kind in pitch|pa|game|player|other|none"""
        uid = text(f.get("uid"))
        if uid and uid in self.by_uid:
            return "pitch", self.by_uid[uid]
        games = self.pick_games(f, gid_hint)
        detail = {k: f.get(k) for k in ("pno", "inn", "half", "paoi", "ppa", "batter", "pitcher", "balls", "strikes")}
        has_detail = any(text(v) for v in detail.values())
        player = name_key(f.get("player"))
        if PRACTICE.search(text(f.get("title"))):
            games = []                               # practice / bullpen clips never attach to a game
        if not games:
            if player:
                return "player", player
            return ("other", None) if (text(f.get("date")) or f.get("_fdate")) else ("none", "no date or game")
        if not has_detail:
            if player:
                return "player", player
            if len(games) == 1:
                return "game", games[0]
            return "none", "more than one game that day; add an Opponent or Game column"
        cand = pd.concat([self.by_gid[g] for g in games])
        pno = num(detail["pno"])
        if pno is not None and len(games) == 1:
            hit = cand[cand["PitchNo"] == pno]
            if len(hit) == 1:
                return "pitch", hit.index[0]
        for k, c in (("inn", "Inning"), ("paoi", "PAofInning"), ("ppa", "PitchofPA"), ("balls", "Balls"), ("strikes", "Strikes")):
            v = num(detail[k])
            if v is not None:
                cand = cand[cand[c] == v]
        h = half_of(detail["half"])
        if h:
            cand = cand[cand["Top/Bottom"] == h]
        def by_name(cand, nk, m):
            sub = cand[[m.get(i) == nk for i in cand.index]]
            if sub.empty:                            # tolerate a different first name / nickname
                last = nk.split("|")[0]
                sub = cand[[(m.get(i) or "").split("|")[0] == last for i in cand.index]]
            return sub

        bk, pk = name_key(detail["batter"]), name_key(detail["pitcher"])
        if bk:
            cand = by_name(cand, bk, self.bkey)
        if pk:
            cand = by_name(cand, pk, self.pkey)
        if player and not bk and not pk:             # a "Player" column: hitter first, then pitcher
            sub = by_name(cand, player, self.bkey)
            cand = sub if not sub.empty else by_name(cand, player, self.pkey)
        if cand.empty:
            return "none", "no pitch in the data matches this clip"
        pitch_level = any(text(detail[k]) for k in ("pno", "ppa", "balls", "strikes"))
        if pitch_level and len(cand) == 1:
            return "pitch", cand.index[0]
        pas = self.paid[cand.index].unique()
        if len(pas) == 1:
            return "pa", cand.index[0]
        return "none", f"matches {len(pas)} at-bats; add Inning or PA of inning"


# ----------------------------------------------------------------------------
def attach(df: pd.DataFrame, root: Path, out_dir: Path, bc_code: str, parse_filename, teams: dict | None = None):
    """Returns (pitch_clips: dict[row index -> list], pa_flag: set[row index], extra dict, report)."""
    cfg_file = root / "scripts" / "video.json"
    cfg = json.loads(cfg_file.read_text()) if cfg_file.exists() else {}
    report = {"enabled": cfg.get("enabled", True), "sources": [], "pitches": 0, "pas": 0, "games": 0,
              "players": 0, "other": 0, "unmatched": []}
    empty = ({}, set(), {"games": {}, "players": {}, "other": []}, report)
    if not cfg.get("enabled", True) or df.empty:
        return empty
    names = cfg.get("angle_names", {})
    tmrep = out_dir / "video-tm-report.json"
    if tmrep.exists():
        try:
            report["trumedia"] = json.loads(tmrep.read_text())
        except ValueError:
            pass

    m = Matcher(df, bc_code, teams)
    pitch, pa_rows = {}, set()
    games, players, other = {}, {}, []

    def add(lst, clips, src, extra=None):
        for c in clips:
            c = {**c, "s": src, **(extra or {})}
            if not any(x["u"] == c["u"] for x in lst):
                lst.append(c)

    def take(f, clips, src, gid_hint, srep):
        kind, tgt = m.match(f, gid_hint)
        srep[kind] = srep.get(kind, 0) + 1
        d = as_date(f.get("date"), f.get("_fdate"))
        title = text(f.get("title"))
        if kind == "pitch":
            add(pitch.setdefault(tgt, []), clips, src)
        elif kind == "pa":
            add(pitch.setdefault(tgt, []), clips, src, {"a": 1})
            pa_rows.add(tgt)
        elif kind == "game":
            add(games.setdefault(tgt, []), clips, src)
        elif kind == "player":
            add(players.setdefault(tgt, []), clips, src, {"d": d.isoformat() if d else "", "t": title})
        elif kind == "other":
            add(other, clips, src, {"d": d.isoformat() if d else "", "t": title or text(f.get("player"))})
        else:
            if len(report["unmatched"]) < 60:
                report["unmatched"].append({"src": srep["file"], "why": tgt,
                                            "row": {k: text(v) for k, v in f.items() if text(v) and not k.startswith("_")}})

    # TruMedia (AWRE game video by TrackMan GameID)
    tm_dir = out_dir / "video-tm"
    if tm_dir.exists() and cfg.get("trumedia", {}).get("enabled", True):
        srep = {"file": "TruMedia GameVideo", "rows": 0}
        raw_rows, raw_cols = 0, set()
        for fpath in sorted(tm_dir.glob("*.json")):
            try:
                rec = json.loads(fpath.read_text())
            except ValueError:
                continue
            if not rec.get("rows"):
                continue
            t = pd.DataFrame(rec["rows"])
            raw_rows += len(t)
            raw_cols.update(map(str, t.columns))
            for f, clips in clip_rows(t, names):
                srep["rows"] += 1
                take(f, clips, "TruMedia", rec["gid"], srep)
        if raw_rows and not srep["rows"]:
            srep["status"] = (f"TruMedia sent {raw_rows} rows but no video links were found in them "
                              f"(columns: {', '.join(sorted(raw_cols))[:400]})")
        if raw_rows:
            report["sources"].append(srep)

    # AWRE API (scripts/awre_pull.py): every pitch of every BC game, matched by TrackMan PitchUID
    awre_dir = out_dir / "video-awre"
    if awre_dir.exists():
        srep = {"file": "AWRE API", "rows": 0}
        for fpath in sorted(awre_dir.glob("*.json")):
            try:
                rec = json.loads(fpath.read_text())
            except ValueError:
                continue
            rows = []
            for p in rec.get("pitches", []):
                if not p.get("clips"):
                    continue
                row = {"PitchUID": p.get("uid") or "", "Date": p.get("date") or rec.get("date") or "",
                       "Inning": p.get("inn"), "Top/Bottom": p.get("half"), "PAofInning": p.get("pa"),
                       "PitchofPA": p.get("ppa"), "Batter": p.get("batter"), "Pitcher": p.get("pitcher")}
                for persp, url, _thumb in p["clips"]:
                    name = persp if persp != "All" else "All angles"
                    if url and name not in row:
                        row[name] = url
                rows.append(row)
            if not rows:
                continue
            t = pd.DataFrame(rows)
            for f, clips in clip_rows(t, names):
                srep["rows"] += 1
                take(f, clips, "AWRE", None, srep)
        if srep["rows"]:
            report["sources"].append(srep)
        awrep = out_dir / "video-awre-report.json"
        if awrep.exists():
            try:
                report["awre"] = json.loads(awrep.read_text())
            except ValueError:
                pass

    # AWRE clip lists in data/video/
    vdir = root / "data" / "video"
    if vdir.exists():
        for fpath in sorted(p for p in vdir.rglob("*") if p.suffix.lower() in VIDEO_EXT and not p.name.startswith(("~$", "."))):
            t = read_table(fpath)
            srep = {"file": fpath.name, "rows": 0}
            report["sources"].append(srep)
            if t is None:
                srep["status"] = "could not read file"
                continue
            t.columns = [str(c).strip() for c in t.columns]
            fdate, fopp, fgnum, _ = parse_filename(fpath.name)
            for f, clips in clip_rows(t, names):
                f["_fdate"] = fdate
                if not text(f.get("opp")) and fopp and fdate:
                    f["opp"] = fopp
                if not text(f.get("gnum")) and fgnum > 1:
                    f["gnum"] = fgnum
                srep["rows"] += 1
                take(f, clips, "AWRE", None, srep)
            if not srep["rows"]:
                srep["status"] = "no video links found (each row needs a column of https:// links)"

    # player-level clips: name key -> BC player key
    pmap = {}
    for k, n in zip(df["bkey"], df["Batter"]):
        pmap.setdefault(name_key(n), set()).add(k)
    for k, n in zip(df["pkey"], df["Pitcher"]):
        pmap.setdefault(name_key(n), set()).add(k)
    players_out = {}
    for nk, clips in players.items():
        keys = [k for k in pmap.get(nk, set()) if k.startswith("bc-")] or list(pmap.get(nk, set()))
        if len(keys) == 1:
            players_out.setdefault(keys[0], []).extend(clips)
        else:
            other.extend(clips)
    for v in players_out.values():
        v.sort(key=lambda c: c.get("d", ""), reverse=True)
    other.sort(key=lambda c: c.get("d", ""), reverse=True)

    report.update(pitches=sum(1 for i in pitch if i not in pa_rows), pas=len(pa_rows), games=len(games),
                  players=sum(len(v) for v in players_out.values()), other=len(other))
    return pitch, pa_rows, {"games": games, "players": players_out, "other": other}, report
