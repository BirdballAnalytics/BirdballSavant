#!/usr/bin/env python3
"""
BirdballSavant data build.

Reads every TrackMan export (.csv / .xlsx / .xls) anywhere under data/,
removes duplicate pitches, assigns each game to a season from its date,
fits an expected-stats (xBA / xSLG / xwOBA) model from exit velocity and
launch angle, and writes compact JSON files into site/data/ for the website.

Run locally:   python scripts/build.py
GitHub Actions runs this automatically on every upload to data/.
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video  # noqa: E402  (AWRE / TruMedia clip matching)
import runvalue  # noqa: E402  (pitch run values + swing-decision model)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "site" / "data"
TEAMS_FILE = Path(__file__).resolve().parent / "teams.json"
ALIASES_FILE = Path(__file__).resolve().parent / "aliases.json"
ROSTER_FILE = Path(__file__).resolve().parent / "roster.json"
CORRECTIONS_FILE = Path(__file__).resolve().parent / "corrections.json"
BATS_FILE = Path(__file__).resolve().parent / "bats.json"

BC_CODES = {"BOC_EAG", "BOS_COL"}
BC_CANON = "BOC_EAG"

# Linear weights for wOBA (MLB-standard scale; used for both wOBA and xwOBA)
W = {"BB": 0.69, "HBP": 0.72, "1B": 0.89, "2B": 1.27, "3B": 1.62, "HR": 2.10}

PITCH_TYPES = {
    "Fastball": "FF", "FourSeamFastBall": "FF", "Four-Seam": "FF",
    "Sinker": "SI", "TwoSeamFastBall": "SI", "Two-Seam": "SI",
    "Cutter": "FC", "Slider": "SL", "Sweeper": "ST", "Curveball": "CU",
    "ChangeUp": "CH", "Changeup": "CH", "Splitter": "FS", "Knuckleball": "KN",
}

CALLS = {
    "BallCalled": "B", "BallinDirt": "B", "BallIntentional": "IB",
    "StrikeCalled": "C", "StrikeSwinging": "S",
    "FoulBallNotFieldable": "F", "FoulBallFieldable": "F", "FoulBall": "F",
    "InPlay": "X", "HitByPitch": "H",
}

USECOLS = [
    "PitchNo", "Date", "GameID", "PitchUID", "Inning", "Top/Bottom", "PAofInning",
    "PitchofPA", "Outs", "Balls", "Strikes", "Pitcher", "PitcherId", "PitcherThrows",
    "PitcherTeam", "Batter", "BatterId", "BatterSide", "BatterTeam", "Catcher",
    "TaggedPitchType", "AutoPitchType", "PitchCall", "KorBB", "TaggedHitType",
    "PlayResult", "OutsOnPlay", "RunsScored", "RelSpeed", "SpinRate", "SpinAxis",
    "InducedVertBreak", "HorzBreak", "RelHeight", "RelSide", "Extension",
    "VertApprAngle", "PlateLocHeight", "PlateLocSide", "ExitSpeed", "Angle",
    "Direction", "Distance", "HangTime", "BatSpeed", "VerticalAttackAngle",
    "HorizontalAttackAngle", "HomeTeam", "AwayTeam", "Stadium", "Level",
]
NUMERIC = [
    "PitchNo", "Inning", "PAofInning", "PitchofPA", "Outs", "Balls", "Strikes",
    "OutsOnPlay", "RunsScored", "RelSpeed", "SpinRate", "SpinAxis", "InducedVertBreak",
    "HorzBreak", "RelHeight", "RelSide", "Extension", "VertApprAngle", "PlateLocHeight",
    "PlateLocSide", "ExitSpeed", "Angle", "Direction", "Distance", "HangTime",
    "BatSpeed", "VerticalAttackAngle", "HorizontalAttackAngle",
]


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------
def read_raw(path: Path) -> pd.DataFrame | None:
    try:
        if path.suffix.lower() == ".csv":
            return pd.read_csv(path, dtype=str, keep_default_na=False, low_memory=False)
        frames = pd.read_excel(path, sheet_name=None, dtype=str)
        frames = [f.fillna("") for f in frames.values() if len(f.columns)]
        if not frames:
            return None
        tm = [f for f in frames if "PitchCall" in f.columns]
        return pd.concat(tm, ignore_index=True) if tm else frames[0]
    except Exception as e:  # keep the build alive if one upload is bad
        log(f"  ! {path.name}: could not read ({e}), skipped")
        return None


def read_file(path: Path):
    """Returns ("trackman", df), ("results", df) or (None, reason)."""
    df = read_raw(path)
    if df is None:
        return None, "could not read file"
    df.columns = [str(c).strip() for c in df.columns]
    if "PitchCall" in df.columns and "Pitcher" in df.columns:
        df = df.reindex(columns=USECOLS + [c for c in df.columns if c not in USECOLS])
        df = df[USECOLS].copy()
        df["_ncols"] = df.notna().sum(axis=1)
        df["_file"] = str(path.relative_to(ROOT))
        return "trackman", df
    if looks_like_execution(df):
        return "execution", df
    if result_col(df) and any(c.lower() == "batter" for c in df.columns):
        return "results", df
    return None, "not a TrackMan export or results file"


def load_all() -> tuple[pd.DataFrame, list[tuple[Path, pd.DataFrame]], list[dict]]:
    files = sorted(
        p for p in DATA_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in {".csv", ".xlsx", ".xls"}
        and not p.name.startswith(("~$", "."))
        and "video" not in p.relative_to(DATA_DIR).parts[:-1]   # data/video/ holds AWRE clip lists
    )
    log(f"Found {len(files)} data file(s) in data/")
    frames, results, manifest, executions = [], [], [], []
    for p in files:
        t = time.time()
        kind, df = read_file(p)
        if kind is None:
            log(f"  ! {p.name}: {df}, skipped")
            manifest.append({"file": p.name, "rows": 0, "kind": "", "status": f"skipped: {df}"})
            continue
        if kind == "execution":
            ex = parse_execution(p)
            if ex is None:
                manifest.append({"file": p.name, "rows": 0, "kind": "Execution chart", "status": "skipped: could not find the chart's header row"})
                log(f"  ! {p.name}: execution chart header not found, skipped")
            else:
                ex["file"] = p.name
                executions.append(ex)
                manifest.append({"file": p.name, "rows": len(ex["rows"]), "kind": "Execution chart", "status": "ok",
                                 "updated": ex["updated"]})
                log(f"  {p.name}: execution chart, {len(ex['rows'])} hitters, updated {ex['updated']}")
            continue
        if kind == "results":
            results.append((p, df))
            manifest.append({"file": p.name, "rows": int(len(df)), "kind": "Results", "status": "ok"})
            log(f"  {p.name}: results file, {len(df):,} rows")
            continue
        log(f"  {p.name}: {len(df):,} rows ({time.time()-t:.1f}s)")
        manifest.append({"file": p.name, "rows": int(len(df)), "kind": "TrackMan", "status": "ok"})
        frames.append(df)
    if not frames:
        return pd.DataFrame(columns=USECOLS + ["_ncols", "_file"]), results, manifest, executions
    df = pd.concat(frames, ignore_index=True)
    df = df.replace({"": np.nan, "nan": np.nan, "NaN": np.nan, "Undefined": np.nan})
    df = df[df["Pitcher"].notna() & df["Batter"].notna()]
    for c in NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # De-duplicate: same pitch can arrive via a per-game CSV and a combined file.
    key = df["PitchUID"].where(df["PitchUID"].notna(),
                               df["GameID"].astype(str) + "#" + df["PitchNo"].astype(str))
    df["_key"] = key
    before = len(df)
    df = df.sort_values("_ncols", ascending=False).drop_duplicates("_key", keep="first")
    log(f"Pitches: {before:,} read, {before-len(df):,} duplicates removed, {len(df):,} kept")
    return df, results, manifest, executions


# ----------------------------------------------------------------------------
# Offensive execution chart (coaching staff's sheet, cumulative, by jersey #)
# ----------------------------------------------------------------------------
EXEC_TOKENS = {"H&R", "SB2", "SB3", "3-2", "3<2", "SAC", "SQZ", "BFH"}


def looks_like_execution(df):
    cells = [str(c) for c in df.columns] + [str(v) for v in df.head(15).to_numpy().ravel()]
    txt = " ".join(cells).lower()
    return "execution" in txt or sum(c.strip() in EXEC_TOKENS for c in cells) >= 3


def exec_key(label):
    return re.sub(r"[^a-z0-9]+", "", label.lower().replace("<", "lt").replace("&", "n")) or "x"


def parse_execution(path: Path):
    try:
        if path.suffix.lower() == ".csv":
            g = pd.read_csv(path, header=None, dtype=str, keep_default_na=False)
        else:
            g = pd.read_excel(path, header=None, dtype=str, sheet_name=0).fillna("")
    except Exception as e:
        log(f"  ! {path.name}: could not read ({e})")
        return None
    g = g.astype(str).apply(lambda c: c.str.strip())
    top = " ".join(g.head(12).to_numpy().ravel())
    upd = None
    m = re.search(r"updated\s*(?:through|thru)?:?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", top, re.I)
    if m:
        mo, da, y = map(int, m.groups())
        y = y + 2000 if y < 100 else y
        try:
            upd = datetime(y, mo, da).date()
        except ValueError:
            upd = None
    hi = None
    for i in range(len(g)):
        row = list(g.iloc[i])
        if sum(v in EXEC_TOKENS for v in row) >= 3:
            hi = i
            break
    if hi is None or hi + 1 >= len(g):
        return None
    hdr, sub = list(g.iloc[hi]), list(g.iloc[hi + 1])
    cats = []
    for j in range(1, len(hdr)):
        if hdr[j] and hdr[j] != "#":
            cats.append({"key": exec_key(hdr[j]), "label": hdr[j], "j": j,
                         "a": sub[j] if j < len(sub) else "", "b": sub[j + 1] if j + 1 < len(sub) else ""})

    def num(v):
        v = str(v).replace("%", "").strip()
        try:
            return float(v)
        except ValueError:
            return None

    players, team, goal = {}, None, {}
    for i in range(hi + 2, len(g)):
        first = g.iat[i, 0]
        vals = {}
        for c in cats:
            j = c["j"]
            e = num(g.iat[i, j]) if j < g.shape[1] else None
            a = num(g.iat[i, j + 1]) if j + 1 < g.shape[1] else None
            vals[c["key"]] = [e, a]
        if first.upper() == "G":
            for c in cats:
                pc = num(g.iat[i, c["j"] + 2]) if c["j"] + 2 < g.shape[1] else None
                if pc is not None:
                    goal[c["key"]] = pc / 100 if pc > 1 else pc
            continue
        if first.upper() == "T":
            team = {k: [v[0] or 0, v[1] or 0] for k, v in vals.items()}
            continue
        m = re.match(r"^\s*(\d+)", first)
        if not m:
            continue
        n = int(m.group(1))
        cur = players.setdefault(n, {"num": n, "label": first, "vals": {}})
        for k, (e, a) in vals.items():
            if e is None and a is None:
                continue
            pe, pa_ = cur["vals"].get(k, [0, 0])
            cur["vals"][k] = [pe + (e or 0), pa_ + (a or 0)]
    rows = [p for p in players.values() if p["vals"]]
    if team is None:
        team = {}
        for c in cats:
            team[c["key"]] = [sum(p["vals"].get(c["key"], [0, 0])[0] for p in rows),
                              sum(p["vals"].get(c["key"], [0, 0])[1] for p in rows)]
    title = re.search(r"(fall|spring)\s+(20\d{2})", top, re.I)
    if upd:
        sid, label = season_of(upd)
    elif title:
        y = int(title.group(2))
        sid, label = f"{y}-{title.group(1).lower()}", f"{title.group(1).title()} {y}"
    else:
        return None
    return {"season": sid, "label": label, "updated": upd.isoformat() if upd else None,
            "cats": [{k: c[k] for k in ("key", "label", "a", "b")} for c in cats],
            "rows": rows, "team": team, "goal": goal}


def apply_corrections(df):
    if not CORRECTIONS_FILE.exists():
        return df, []
    fixes = json.loads(CORRECTIONS_FILE.read_text()).get("fixes", [])
    report = []
    ds = df["gdate"].astype(str)
    for f in fixes:
        m = (df["Batter"] == f["batter"]) & (ds == f["date"]) & (df["PitchNo"] == f["pitchno"])
        n = int(m.sum())
        if n != 1:
            log(f"  ! correction not applied ({n} matching pitches): {f['batter']} {f['date']} #{f['pitchno']}")
            report.append({**f, "applied": False})
            continue
        df.loc[m, "pa"] = f.get("pa", "")
        report.append({**f, "applied": True})
        log(f"  correction applied: {f['batter']} {f['date']} pitch {f['pitchno']} -> {f.get('pa') or 'no PA result'}")
    return df, report


def flag_two_strikes(df):
    """k2 = 1 on the pitch that ends a PA if the PA ever reached two strikes."""
    df = df.sort_values(["GameID", "PitchNo"], kind="stable")
    keys = list(zip(df["GameID"], df["Inning"].astype(str), df["Top/Bottom"].astype(str),
                    df["PAofInning"].astype(str), df["Batter"]))
    k2 = np.full(len(df), np.nan)
    prev, mx = None, -1
    for i, (key, s, pa) in enumerate(zip(keys, df["Strikes"], df["pa"])):
        if key != prev:
            prev, mx = key, -1
        if s == s:
            mx = max(mx, s)
        if pa:
            k2[i] = 1.0 if mx >= 2 else 0.0
            mx = -1
    df["k2"] = k2
    return df


# ----------------------------------------------------------------------------
# Results-only files (no TrackMan): one row per BC plate appearance
#   columns: Batter, Result (or Results), optional Balls, Strikes, Date,
#   Opponent, Pitcher, Throws, Inning.  Date and opponent can instead come
#   from the file name, e.g. "2026-09-26 URI Results.xlsx" or "9.26.26vsURI.xls".
# ----------------------------------------------------------------------------
RESULT_COLS = ("result", "results", "playresult", "outcome", "play")


def result_col(df):
    for c in df.columns:
        if str(c).strip().lower() in RESULT_COLS:
            return c
    return None


def col(df, *names):
    for c in df.columns:
        if str(c).strip().lower().replace(" ", "") in names:
            return c
    return None


def parse_filename(name: str):
    stem = Path(name).stem
    away = "@" in stem or re.search(r"(?i)(?:^|[\s_\-.])at(?:[\s_\-.]|$)", stem) is not None
    d = None
    m = re.search(r"(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})", stem)
    if m:
        y, mo, da = map(int, m.groups())
    else:
        m = re.search(r"(?<!\d)(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})(?!\d)", stem)
        if m:
            mo, da, y = map(int, m.groups())
            y = y + 2000 if y < 100 else y
    if m:
        try:
            d = datetime(y, mo, da).date()
        except ValueError:
            d = None
        rest = (stem[:m.start()] + " " + stem[m.end():])
    else:
        rest = stem
    gnum = 1
    g = re.search(r"(?:game|g|dh)\s*([12])\b", rest, re.I)
    if g:
        gnum = int(g.group(1))
        rest = rest[:g.start()] + rest[g.end():]
    rest = re.sub(r"[_\-.]+", " ", rest).strip()
    rest = re.sub(r"(?i)^vs(?=[A-Za-z])", "", rest)
    rest = re.sub(r"(?i)\b(results?|box|boxscore|vs|at|bc)\b", " ", rest)
    rest = re.sub(r"(?i)results?$", " ", rest.strip())
    opp = re.sub(r"\s+", " ", rest.replace("@", " ")).strip()
    return d, opp, gnum, away


def parse_result(txt: str):
    """Scorebook notation -> (event, hit_type, outs). event None = unreadable."""
    t = str(txt).strip().upper().replace(" ", "")
    if not t:
        return None, "", 0
    if t in {"BB", "W", "WALK", "IBB"}:
        return "BB", "", 0
    if t in {"HBP", "HP", "HB"}:
        return "HBP", "", 0
    if re.fullmatch(r"K[LSC]?|ꓘ|SO|KLOOKING|KSWINGING|STRIKEOUT", t):
        return "K", "", 1
    if t.startswith("SAC") or t.startswith("SF") or t.startswith("SH"):
        rest = re.sub(r"^(SAC|SF|SH)", "", t)
        fly = t.startswith("SF") or rest.startswith("F") or rest.startswith("L")
        return ("SF" if fly else "SH"), ("FB" if fly else "BU"), 1
    m = re.fullmatch(r"(1B|2B|3B|HR)(.*)", t)
    if m:
        rest = m.group(2)
        ht = {"G": "GB", "L": "LD", "F": "FB", "P": "PU", "B": "BU"}.get(rest[:1], "")
        return m.group(1), ("FB" if m.group(1) == "HR" and not ht else ht), 0
    if t.startswith("E") or t == "ROE":
        return "ROE", "", 0
    if t.startswith("FC"):
        return "FC", "GB", 1
    m = re.fullmatch(r"([FLP])(\d)(?:DP|SF)?", t)
    if m:
        return "OUT", {"F": "FB", "L": "LD", "P": "PU"}[m.group(1)], 1
    if re.fullmatch(r"\d(-\d)+(DP|TP)?|\dU|U\d|G\d", t):
        outs = 2 if t.endswith("DP") or t.count("-") >= 2 else 1
        return "OUT", "GB", outs
    if re.fullmatch(r"BU?\d(-\d)*", t):
        return "OUT", "BU", 1
    return None, "", 0


BB_COLS = ["ExitSpeed", "Angle", "Direction", "Distance", "HangTime"]
AUTO_HT = {"GroundBall": "GB", "LineDrive": "LD", "FlyBall": "FB", "Popup": "PU", "Bunt": "BU"}


def build_results(results, known_bc: list[str], aliases: dict, teams: dict, trackman_games: set | None = None):
    import difflib
    rows, report = [], []
    seen_games = set()
    known_set = set(known_bc)

    def match(name):
        name = re.sub(r"\s+", " ", str(name)).strip()
        if name in aliases:
            return aliases[name], "alias"
        if name in known_set:
            return name, ""
        last, _, first = name.partition(",")
        last, first = last.strip().lower(), first.strip().lower()
        cands = [k for k in known_bc if k.split(",")[0].strip().lower() == last and first and
                 (k.partition(",")[2].strip().lower().startswith(first) or first.startswith(k.partition(",")[2].strip().lower()))]
        if len(cands) == 1:
            return cands[0], "matched"
        close = difflib.get_close_matches(name, known_bc, n=2, cutoff=0.85)
        if close and (len(close) == 1 or difflib.SequenceMatcher(None, name, close[0]).ratio() -
                      difflib.SequenceMatcher(None, name, close[1]).ratio() > 0.04):
            return close[0], "matched"
        return name, "new"

    for path, df in results:
        fdate, fopp, gnum, faway = parse_filename(path.name)
        hac = col(df, "homeaway", "home/away", "site", "location")
        rc, bc_ = result_col(df), col(df, "batter")
        dc, oc = col(df, "date", "gamedate"), col(df, "opponent", "opp", "team")
        bcol, scol = col(df, "balls"), col(df, "strikes")
        bbc = {c: col(df, c.lower()) for c in BB_COLS}
        ahc, gidc = col(df, "autohittype", "taggedhittype"), col(df, "gameid")
        pcol, thcol, icol = col(df, "pitcher"), col(df, "throws", "pitcherthrows", "hand"), col(df, "inning", "inn")
        df = df[df[bc_].astype(str).str.strip().ne("") & df[rc].astype(str).str.strip().ne("")]
        bad, matched = [], {}
        file_rows = []
        for n, r in enumerate(df.to_dict("records"), 1):
            d = fdate
            if dc and str(r[dc]).strip():
                pdd = pd.to_datetime(str(r[dc]), errors="coerce", format="mixed")
                d = None if pd.isna(pdd) else pdd.date()
            opp = (str(r[oc]).strip() if oc and str(r[oc]).strip() else fopp) or "Unknown"
            if d is None:
                continue
            ev, ht, outs = parse_result(r[rc])
            if not ht and ahc and str(r[ahc]).strip() in AUTO_HT and ev not in (None, "K", "BB", "HBP"):
                ht = AUTO_HT[str(r[ahc]).strip()]
            if ev is None:
                bad.append(str(r[rc]))
                continue
            raw = str(r[bc_]).strip()
            name, how = match(raw)
            if how in ("matched", "alias") and raw != name:
                matched[raw] = name
            elif how == "new":
                matched.setdefault(raw, None)
            code = opp
            gid = f"{d:%Y%m%d}-Results-{slug(opp)}-{gnum}"
            pitcher = str(r[pcol]).strip() if pcol and str(r[pcol]).strip() else f"{teams.get(code, code)} pitcher"
            num = lambda v: pd.to_numeric(str(v), errors="coerce") if v is not None else np.nan
            file_rows.append({
                "GameID": gid, "gdate": d, "PitchNo": n, "Batter": name, "BatterTeam": BC_CANON,
                "Pitcher": pitcher, "PitcherTeam": code, "PitcherThrows": {"R": "Right", "L": "Left"}.get(str(r[thcol]).strip()[:1].upper(), np.nan) if thcol else np.nan,
                "Balls": num(r[bcol]) if bcol else np.nan, "Strikes": num(r[scol]) if scol else np.nan,
                "Inning": num(r[icol]) if icol else np.nan,
                **(lambda away: {"HomeTeam": code if away else BC_CANON, "AwayTeam": BC_CANON if away else code})(
                    str(r[hac]).strip().lower() in {"away", "a", "road", "@"} if hac and str(r[hac]).strip() else faway), "Stadium": "", "pa": ev, "pt": "UN",
                "call": "X" if ev in {"1B", "2B", "3B", "HR", "OUT", "ROE", "FC", "SF", "SH"} else ("H" if ev == "HBP" else "U"),
                "TaggedHitType": {"GB": "GroundBall", "LD": "LineDrive", "FB": "FlyBall", "PU": "Popup", "BU": "Bunt"}.get(ht, np.nan),
                "OutsOnPlay": outs, "RunsScored": 0, "nt": 1,
                "k2": (1.0 if num(r[scol]) == 2 else 0.0) if scol else np.nan,
                **{c: (num(r[bbc[c]]) if bbc[c] else np.nan) for c in BB_COLS},
                "_tmgid": str(r[gidc]).strip() if gidc and str(r[gidc]).strip() not in ("", "nan") else "",
            })
        tm_ids = {x["_tmgid"] for x in file_rows if x["_tmgid"]}
        if trackman_games and tm_ids & trackman_games:
            log(f"  ! {path.name}: the TrackMan file for this game is already loaded, so this results file was skipped")
            report.append({"file": path.name, "status": "skipped: the TrackMan file for this game is already loaded"})
            continue
        # Batted-ball tracking: counts if most balls in play carry an exit velocity
        bip = [x for x in file_rows if x["call"] == "X" and x["pa"] != "SH"]
        tracked = sum(1 for x in bip if x["ExitSpeed"] == x["ExitSpeed"] and 10 <= x["ExitSpeed"] <= 130)
        has_bb = bool(bip) and tracked >= 0.6 * len(bip)
        for x in file_rows:
            x["nt"] = 2 if has_bb else 1
            ev_ok = x["call"] == "X" and x["ExitSpeed"] == x["ExitSpeed"] and 10 <= x["ExitSpeed"] <= 130
            if not ev_ok:
                for c in BB_COLS:
                    x[c] = np.nan
        gids = {x["GameID"] for x in file_rows}
        dup = gids & seen_games
        if dup:
            log(f"  ! {path.name}: game already loaded from another results file, skipped")
            report.append({"file": path.name, "status": "skipped: same date and opponent as another results file"})
            continue
        seen_games |= gids
        if not file_rows:
            why = "no date found (put it in the file name, e.g. 2026-09-26 URI Results.xlsx)" if fdate is None and not dc else "no readable plate appearances"
            log(f"  ! {path.name}: {why}")
            report.append({"file": path.name, "status": f"skipped: {why}"})
            continue
        rows += file_rows
        report.append({
            "file": path.name, "status": "ok", "date": file_rows[0]["gdate"].isoformat(), "opp": file_rows[0]["PitcherTeam"],
            "pa": len(file_rows), "unread": bad, "batted_balls": tracked if has_bb else 0,
            "names": [{"raw": k, "as": v} for k, v in matched.items()],
        })
        log(f"  {path.name}: {len(file_rows)} PA on {file_rows[0]['gdate']} vs {file_rows[0]['PitcherTeam']}"
            + (f"; {tracked} tracked batted balls" if has_bb else "")
            + (f"; unreadable results: {bad}" if bad else "")
            + (f"; names matched: {matched}" if matched else ""))
    out = pd.DataFrame(rows)
    if not out.empty:
        out = out.drop(columns=["_tmgid"])
    return out, report


# ----------------------------------------------------------------------------
# Cleaning
# ----------------------------------------------------------------------------
def game_date(row_gid, row_date):
    m = re.match(r"(\d{8})", str(row_gid or ""))
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y%m%d").date()
        except ValueError:
            pass
    d = pd.to_datetime(row_date, errors="coerce", format="mixed")
    return None if pd.isna(d) else d.date()


def season_of(d) -> tuple[str, str]:
    if d.month <= 7:
        return f"{d.year}-spring", f"Spring {d.year}"
    return f"{d.year}-fall", f"Fall {d.year}"


def clean(df: pd.DataFrame) -> pd.DataFrame:
    for c in ["PitcherTeam", "BatterTeam", "HomeTeam", "AwayTeam"]:
        df[c] = df[c].replace({k: BC_CANON for k in BC_CODES})
    gids = df["GameID"].fillna("")
    dates = {g: game_date(g, d) for g, d in zip(gids, df["Date"])}
    df["gdate"] = [dates[g] for g in gids]
    missing = df["gdate"].isna()
    if missing.any():
        log(f"  ! {missing.sum()} pitches with no usable date were dropped")
        df = df[~missing].copy()
    df["GameID"] = df["GameID"].fillna(df["gdate"].astype(str) + "-unknown")

    # Pitch type: tagged, else TrackMan auto-tag
    pt = df["TaggedPitchType"].map(PITCH_TYPES)
    pt = pt.fillna(df["AutoPitchType"].map(PITCH_TYPES))
    df["pt"] = pt.fillna("UN")

    df["call"] = df["PitchCall"].map(CALLS).fillna("U")

    # Plate-appearance result on the pitch that ends it
    ev = pd.Series("", index=df.index, dtype=object)
    k = df["KorBB"] == "Strikeout"
    bb = df["KorBB"] == "Walk"
    hbp = df["call"] == "H"
    ip = df["call"] == "X"
    pr = df["PlayResult"].fillna("")
    bunt = df["TaggedHitType"] == "Bunt"
    ev[ip & (pr == "Single")] = "1B"
    ev[ip & (pr == "Double")] = "2B"
    ev[ip & (pr == "Triple")] = "3B"
    ev[ip & (pr == "HomeRun")] = "HR"
    ev[ip & (pr == "Error")] = "ROE"
    ev[ip & (pr == "FieldersChoice")] = "FC"
    ev[ip & (pr == "Sacrifice") & bunt] = "SH"
    ev[ip & (pr == "Sacrifice") & ~bunt] = "SF"
    ev[ip & (ev == "")] = "OUT"
    ev[hbp] = "HBP"
    ev[bb] = "BB"
    ev[k] = "K"
    df["pa"] = ev

    # Out-of-range tracking values are blanked rather than trusted
    df.loc[(df["ExitSpeed"] < 10) | (df["ExitSpeed"] > 130), "ExitSpeed"] = np.nan
    df.loc[(df["RelSpeed"] < 40) | (df["RelSpeed"] > 105), "RelSpeed"] = np.nan
    # Bat tracking: readings outside 50-95 mph are checked swings, bunts or tracking errors.
    # Drop the whole reading (speed and attack angles) for that swing.
    bad_bat = (df["BatSpeed"] < 50) | (df["BatSpeed"] > 95)
    df.loc[bad_bat, ["BatSpeed", "VerticalAttackAngle", "HorizontalAttackAngle"]] = np.nan
    df.loc[~df["call"].eq("X"), ["ExitSpeed", "Angle", "Direction", "Distance"]] = np.nan
    return df


# ----------------------------------------------------------------------------
# Expected stats model (kernel-smoothed on exit velocity x launch angle)
# ----------------------------------------------------------------------------
XMOV_K = 60          # neighbours per pitch
XMOV_MIN_TYPE = 150  # a pitch type needs this many pitches league-wide to get an expected movement


def expected_movement(df: pd.DataFrame) -> pd.DataFrame:
    """Expected IVB / HB for each pitch: the average movement of the same pitch type thrown by
    OTHER pitchers with a similar arm slot (release height, release side, extension) and velocity.
    Lefties are mirrored so both hands share one pool. Every pitcher in the data (BC and
    opponents, all seasons) is in the pool. Results: columns xivb, xhb (inches)."""
    df["xivb"], df["xhb"] = np.nan, np.nan
    need = ["RelHeight", "RelSide", "Extension", "RelSpeed", "InducedVertBreak", "HorzBreak"]
    ok = df["nt"].eq(0) & df["pt"].ne("UN") & df[need].notna().all(axis=1) & df["PitcherThrows"].isin(["Left", "Right"])
    if not ok.any():
        return df
    sub = df.loc[ok, need + ["pt", "PitcherThrows", "Pitcher", "PitcherTeam"]].copy()
    mir = np.where(sub["PitcherThrows"].eq("Left"), -1.0, 1.0)
    sub["side"] = sub["RelSide"] * mir
    sub["hbm"] = sub["HorzBreak"] * mir
    sub["pid"] = pd.factorize(sub["Pitcher"].astype(str) + "|" + sub["PitcherTeam"].astype(str))[0]
    # feature scale (how far counts as "similar"): ~0.25 ft of slot, ~0.4 ft extension, ~2 mph
    scale = {"RelHeight": 0.25, "side": 0.25, "Extension": 0.4, "RelSpeed": 2.0}
    done = 0
    for pt, g in sub.groupby("pt"):
        if len(g) < XMOV_MIN_TYPE:
            continue
        X = np.column_stack([g[c].to_numpy(float) / w for c, w in scale.items()])
        pid = g["pid"].to_numpy()
        iv, hb = g["InducedVertBreak"].to_numpy(float), g["hbm"].to_numpy(float)
        k = min(XMOV_K, len(g) - 1)
        out_iv, out_hb = np.empty(len(g)), np.empty(len(g))
        for a in range(0, len(g), 800):
            b = min(len(g), a + 800)
            d = ((X[a:b, None, :] - X[None, :, :]) ** 2).sum(-1)
            d[pid[a:b, None] == pid[None, :]] = np.inf          # never compare a pitcher to himself
            kk = min(k, max(1, int(np.isfinite(d).sum(1).min())))
            nn = np.argpartition(d, kk - 1, axis=1)[:, :kk]
            dd = np.take_along_axis(d, nn, 1)
            w = np.where(np.isfinite(dd), 1.0 / (1.0 + dd), 0.0)   # closer pitches count more
            ws = w.sum(1)
            ws[ws == 0] = np.nan
            out_iv[a:b] = (w * iv[nn]).sum(1) / ws
            out_hb[a:b] = (w * hb[nn]).sum(1) / ws
        m = np.where(g["PitcherThrows"].eq("Left"), -1.0, 1.0)
        df.loc[g.index, "xivb"] = out_iv
        df.loc[g.index, "xhb"] = out_hb * m
        done += len(g)
    log(f"  expected movement fit for {done:,} pitches")
    return df


def fit_expected(df: pd.DataFrame) -> pd.DataFrame:
    hitvals = {"1B": (1, 1, W["1B"]), "2B": (1, 2, W["2B"]), "3B": (1, 3, W["3B"]),
               "HR": (1, 4, W["HR"])}
    bip = df["call"].eq("X") & df["pa"].ne("")
    y = np.array([hitvals.get(e, (0, 0, 0.0)) for e in df.loc[bip, "pa"]], dtype=float)
    act = pd.DataFrame(y, index=df.index[bip], columns=["hit", "tb", "wv"])

    train = bip & df["ExitSpeed"].notna() & df["Angle"].notna() & \
        ~df["pa"].isin(["SH"]) & df["TaggedHitType"].ne("Bunt")
    X = df.loc[train, ["ExitSpeed", "Angle"]].to_numpy(float)
    Y = act.loc[df.index[train]].to_numpy(float)
    df["xba"] = np.nan
    df["xslg"] = np.nan
    df["xwv"] = np.nan
    if len(X) < 50:
        log("  ! too few tracked batted balls for expected stats; using actual results")
    else:
        prior = Y.mean(axis=0)
        n = len(X)

        def smooth(Q, bw_ev, bw_la, exclude_self):
            num = np.zeros((len(Q), 3))
            den = np.zeros(len(Q))
            for s in range(0, len(Q), 1500):
                q = Q[s:s+1500]
                d = ((q[:, None, 0] - X[None, :, 0]) / bw_ev) ** 2 + \
                    ((q[:, None, 1] - X[None, :, 1]) / bw_la) ** 2
                w = np.exp(-0.5 * d)
                if exclude_self:
                    idx = np.arange(s, s + len(q))
                    w[np.arange(len(q)), idx] = 0.0
                num[s:s+len(q)] = w @ Y
                den[s:s+len(q)] = w.sum(axis=1)
            return num, den

        Q = df.loc[bip & df["ExitSpeed"].notna() & df["Angle"].notna(),
                   ["ExitSpeed", "Angle"]].to_numpy(float)
        qidx = df.index[bip & df["ExitSpeed"].notna() & df["Angle"].notna()]
        # leave-one-out only for rows that are themselves in the training set
        in_train = np.isin(qidx, df.index[train])
        # Wide kernel (shrunk to league mean), then local kernel shrunk to wide
        n2, d2 = smooth(Q, 8.0, 10.0, False)
        n1, d1 = smooth(Q, 3.0, 4.0, False)
        # remove self-contribution for training rows (weight 1 at distance 0)
        tr_pos = {ix: i for i, ix in enumerate(df.index[train])}
        for qi, ix in enumerate(qidx):
            if in_train[qi]:
                yi = Y[tr_pos[ix]]
                n1[qi] -= yi; d1[qi] -= 1
                n2[qi] -= yi; d2[qi] -= 1
        wide = (n2 + 2.0 * prior) / (d2 + 2.0)[:, None]
        est = (n1 + 3.0 * wide) / (d1 + 3.0)[:, None]
        df.loc[qidx, "xba"] = est[:, 0]
        df.loc[qidx, "xslg"] = est[:, 1]
        df.loc[qidx, "xwv"] = est[:, 2]
        log(f"  expected-stats model fit on {n:,} tracked batted balls")

    # Untracked balls in play and bunts use the actual result
    fill = bip & df["xwv"].isna()
    df.loc[fill, "xba"] = act.loc[df.index[fill], "hit"]
    df.loc[fill, "xslg"] = act.loc[df.index[fill], "tb"]
    df.loc[fill, "xwv"] = act.loc[df.index[fill], "wv"]
    bunts = bip & df["TaggedHitType"].eq("Bunt")
    df.loc[bunts, "xba"] = act.loc[df.index[bunts], "hit"]
    df.loc[bunts, "xslg"] = act.loc[df.index[bunts], "tb"]
    df.loc[bunts, "xwv"] = act.loc[df.index[bunts], "wv"]
    return df


# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------
def ncaa_index():
    """Summarise TruMedia files written by scripts/trumedia.py (if any)."""
    out = {"years": [], "report": None}
    rep = OUT_DIR / "ncaa-report.json"
    if rep.exists():
        try:
            out["report"] = json.loads(rep.read_text())
        except ValueError:
            pass
    for f in sorted(OUT_DIR.glob("ncaa-[0-9]*.json")):
        try:
            d = json.loads(f.read_text())
        except ValueError:
            continue
        out["years"].append({
            "year": d["year"], "file": f.name, "pulled": d.get("pulled"),
            "hitters": len(d.get("hitting", {}).get("rows", [])), "pitchers": len(d.get("pitching", {}).get("rows", [])),
        })
    return out


def fix_batter_sides(df: pd.DataFrame):
    """BC hitters: bats.json first, then the roster's B/T. TrackMan operators sometimes tag the
    wrong side, which made one-sided hitters look like switch hitters."""
    want = {}
    if ROSTER_FILE.exists():
        for rp in json.loads(ROSTER_FILE.read_text()).get("players", []):
            b = str(rp.get("bt", "")).split("/")[0].strip().upper()[:1]
            first, _, last = rp["name"].strip().partition(" ")
            if b in ("L", "R", "S") and last:
                want[f"{last}, {first}"] = (b, "roster")
    if BATS_FILE.exists():
        for k, v in json.loads(BATS_FILE.read_text()).items():
            if not k.startswith("_") and str(v).strip().upper()[:1] in ("L", "R", "S"):
                want[k.strip()] = (str(v).strip().upper()[:1], "bats.json")
    bc_names = set(df.loc[df["BatterTeam"] == BC_CANON, "Batter"].dropna())

    def find(name):
        if name in bc_names:
            return name
        last, _, first = name.partition(",")
        last, first = last.strip().lower(), first.strip().lower()
        c = [n for n in bc_names if n.split(",")[0].strip().lower() == last and
             n.partition(",")[2].strip().lower()[:1] == first[:1]]
        return c[0] if len(c) == 1 else None

    forced, report = {}, []
    for name, (b, src) in want.items():
        n = find(name)
        if not n:
            continue
        forced[n] = b
        if b in ("L", "R"):
            m = (df["Batter"] == n) & (df["BatterTeam"] == BC_CANON)
            side = "Left" if b == "L" else "Right"
            changed = int((m & df["BatterSide"].notna() & (df["BatterSide"] != side)).sum())
            df.loc[m, "BatterSide"] = side
            if changed:
                report.append({"batter": n, "bats": b, "source": src, "pitches_fixed": changed})
                log(f"  {n}: bats {b} ({src}); {changed} pitches were tagged from the other side")
    return df, forced, report


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def r(x, nd):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    v = round(float(x), nd)
    return int(v) if nd == 0 else v


def build():
    t0 = time.time()
    teams = {k: v for k, v in json.loads(TEAMS_FILE.read_text()).items() if not k.startswith("_")}
    aliases = {}
    if ALIASES_FILE.exists():
        aliases = {k: v for k, v in json.loads(ALIASES_FILE.read_text()).items() if not k.startswith("_")}
    df, results, manifest, executions = load_all()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("season-*.json"):
        old.unlink()
    if df.empty and not results and not executions:
        (OUT_DIR / "meta.json").write_text(json.dumps({
            "built": datetime.now(timezone.utc).isoformat(), "seasons": [], "files": manifest,
            "teams": teams, "players": []}))
        log("No data yet; wrote empty meta.json")
        return

    corr_report = []
    if not df.empty:
        df = clean(df)
        df, corr_report = apply_corrections(df)
        df = flag_two_strikes(df)
        for c in ("Batter", "Pitcher"):
            df[c] = df[c].replace(aliases)
    df["nt"] = 0

    # Results-only games (no TrackMan) become one row per plate appearance
    res_report = []
    if results:
        known = sorted(set(df.loc[df["BatterTeam"] == BC_CANON, "Batter"].dropna()) |
                       set(df.loc[df["PitcherTeam"] == BC_CANON, "Pitcher"].dropna()))
        tm_games = set(df["GameID"].dropna().astype(str)) if not df.empty else set()
        rdf, res_report = build_results(results, known, aliases, teams, tm_games)
        if not rdf.empty:
            df = pd.concat([df, rdf], ignore_index=True)
        for m in manifest:
            rep = next((x for x in res_report if x["file"] == m["file"]), None)
            if rep:
                m.update({k: v for k, v in rep.items() if k != "file"})
                if rep["status"] != "ok":
                    m["rows"] = 0

    if not df.empty and "call" in df.columns:
        df = fit_expected(df)
        # results games without batted-ball tracking: keep their in-play rows out of expected stats
        untracked = df["nt"].eq(1)
        df.loc[untracked, ["xba", "xslg", "xwv"]] = np.nan
        df = expected_movement(df)
    rv_report = {}
    if not df.empty and "call" in df.columns and df["nt"].eq(0).any():
        df, rv_report = runvalue.add_run_values(df, Path(__file__).resolve().parent / "re288.csv", log)

    df, forced_bats, bats_report = fix_batter_sides(df)

    for c in ("xivb", "xhb", "rv", "dv", "az", "dg"):
        if c not in df.columns:
            df[c] = np.nan

    # Players: BC players keyed by name (TrackMan IDs sometimes change between
    # seasons); opponents keyed by team + name.
    def pkey(name, team):
        return ("bc-" if team == BC_CANON else slug(team or "opp") + "--") + slug(name)

    df["pkey"] = [pkey(n, t) for n, t in zip(df["Pitcher"], df["PitcherTeam"])]
    df["bkey"] = [pkey(n, t) for n, t in zip(df["Batter"], df["BatterTeam"])]

    # Video links (AWRE clip lists in data/video/ + TruMedia GameVideo)
    df = df.reset_index(drop=True)
    vclips, _, vextra, vreport = video.attach(df, ROOT, OUT_DIR, BC_CANON, parse_filename, teams)
    log(f"Video: {vreport['pitches']} pitches, {vreport['pas']} at-bats, {vreport['games']} games, "
        f"{vreport['players']} player clips, {vreport['other']} other clips"
        + (f"; {len(vreport['unmatched'])} clip rows not matched (see Data status)" if vreport["unmatched"] else ""))
    df["_vid"] = pd.Series({i: c for i, c in vclips.items()}, dtype=object).reindex(df.index)

    players: dict[str, dict] = {}

    def add_player(key, name, team):
        if key not in players:
            players[key] = {"k": key, "n": name, "t": team, "bc": team == BC_CANON,
                            "throws": {}, "bats": {}, "hit": set(), "pit": set()}
        return players[key]

    df["season"], df["slabel"] = zip(*[season_of(d) for d in df["gdate"]])

    for (k, n, t, th, s), _ in df.groupby(["pkey", "Pitcher", "PitcherTeam", "PitcherThrows", "season"], dropna=False):
        p = add_player(k, n, t)
        p["pit"].add(s)
        if isinstance(th, str):
            p["throws"][th] = p["throws"].get(th, 0) + int(len(_))
    for (k, n, t, sd, s), _ in df.groupby(["bkey", "Batter", "BatterTeam", "BatterSide", "season"], dropna=False):
        p = add_player(k, n, t)
        p["hit"].add(s)
        if isinstance(sd, str):
            p["bats"][sd] = p["bats"].get(sd, 0) + int(len(_))

    def hand(counts, switch_ok):
        if not counts:
            return ""
        tot = sum(counts.values())
        if switch_ok and len(counts) > 1 and min(counts.values()) >= 0.2 * tot:
            return "S"
        return max(counts, key=counts.get)[0]

    plist = sorted(players.values(), key=lambda p: (not p["bc"], p["n"]))
    pidx = {p["k"]: i for i, p in enumerate(plist)}
    players_out = [{
        "k": p["k"], "n": p["n"], "t": p["t"], "bc": p["bc"],
        "th": hand(p["throws"], False), "b": forced_bats.get(p["n"]) if p["bc"] and p["n"] in forced_bats else hand(p["bats"], True),
        "hit": sorted(p["hit"]), "pit": sorted(p["pit"]),
    } for p in plist]

    # Roster (jersey numbers, positions) matched to BC players by name
    roster = json.loads(ROSTER_FILE.read_text()).get("players", []) if ROSTER_FILE.exists() else []
    bc_players = [p for p in players_out if p["bc"]]

    def find_bc(full):
        first, _, last = full.strip().partition(" ")
        last, first = last.lower().replace(" ", ""), first.lower()
        cands = [p for p in bc_players if p["n"].split(",")[0].strip().lower().replace(" ", "") == last]
        if len(cands) > 1:
            cands = [p for p in cands if p["n"].partition(",")[2].strip().lower().startswith(first[:3])] or cands
        if len(cands) > 1:
            cands = [p for p in cands if p["n"].partition(",")[2].strip().lower() == first] or cands
        return cands[0] if len(cands) == 1 else None

    by_num = {}
    for rp in roster:
        p = find_bc(rp["name"])
        if p:
            p.update({"num": rp["num"], "pos": rp.get("pos"), "cls": rp.get("class"), "ht": rp.get("ht"),
                      "wt": rp.get("wt"), "home": rp.get("home")})
        by_num[rp["num"]] = {"name": rp["name"], "k": p["k"] if p else None}

    execution = {}
    for ex in sorted(executions, key=lambda e: (e["updated"] or "", e["file"])):
        for row in ex["rows"]:
            info = by_num.get(row["num"], {})
            row["k"], row["name"] = info.get("k"), info.get("name") or row["label"]
        execution[ex["season"]] = ex   # newest chart per season wins
    for sid, ex in execution.items():
        unknown = [r["label"] for r in ex["rows"] if r["k"] is None]
        if unknown:
            log(f"  execution chart {ex['label']}: numbers not matched to a player with data: {unknown}")

    seasons_meta = []
    for sid, sdf in df.groupby("season", sort=True):
        sdf = sdf.copy()
        # game table
        gtab = []
        g_order = sdf.groupby("GameID")["gdate"].first().reset_index()
        g_order["num"] = g_order["GameID"].str.extract(r"-(\d+)$")[0].astype(float).fillna(0)
        g_order = g_order.sort_values(["gdate", "num", "GameID"]).reset_index(drop=True)
        gidx = {g: i for i, g in enumerate(g_order["GameID"])}
        for g, gd in zip(g_order["GameID"], g_order["gdate"]):
            gg = sdf[sdf["GameID"] == g]
            home, away = gg["HomeTeam"].dropna(), gg["AwayTeam"].dropna()
            home = home.iloc[0] if len(home) else BC_CANON
            away = away.iloc[0] if len(away) else BC_CANON
            tms = set(gg["PitcherTeam"].dropna()) | set(gg["BatterTeam"].dropna())
            opps = sorted(tms - {BC_CANON})
            opp = opps[0] if opps else ""
            st = gg["Stadium"].dropna()
            gtab.append({
                "id": g, "d": gd.isoformat(), "opp": opp, "nt": bool(gg["nt"].ge(1).all()), "bb": bool(gg["nt"].eq(2).all()),
                "home": home == BC_CANON if opp else True,
                "st": st.iloc[0] if len(st) else "",
                "n": int(len(gg)),
                **({"vid": vextra["games"][g]} if g in vextra["games"] else {}),
            })
        sdf["gi"] = sdf["GameID"].map(gidx)
        sdf = sdf.sort_values(["gi", "PitchNo"], kind="stable")

        cols = {
            "g": sdf["gi"].astype(int).tolist(),
            "inn": [r(x, 0) for x in sdf["Inning"]],
            "top": [1 if x == "Top" else 0 for x in sdf["Top/Bottom"]],
            "pa": [r(x, 0) for x in sdf["PAofInning"]],
            "ppa": [r(x, 0) for x in sdf["PitchofPA"]],
            "o": [r(x, 0) for x in sdf["Outs"]],
            "b": [r(x, 0) for x in sdf["Balls"]],
            "s": [r(x, 0) for x in sdf["Strikes"]],
            "p": [pidx[k] for k in sdf["pkey"]],
            "h": [pidx[k] for k in sdf["bkey"]],
            "th": [(x or "")[:1] for x in sdf["PitcherThrows"].fillna("")],
            "bs": [(x or "")[:1] for x in sdf["BatterSide"].fillna("")],
            "pt": sdf["pt"].tolist(),
            "c": sdf["call"].tolist(),
            "r": sdf["pa"].tolist(),
            "ht": [{"GroundBall": "GB", "LineDrive": "LD", "FlyBall": "FB", "Popup": "PU",
                    "Bunt": "BU"}.get(x, "") for x in sdf["TaggedHitType"].fillna("")],
            "oop": [r(x, 0) or 0 for x in sdf["OutsOnPlay"]],
            "rs": [r(x, 0) or 0 for x in sdf["RunsScored"]],
            "v": [r(x, 1) for x in sdf["RelSpeed"]],
            "spin": [r(x, 0) for x in sdf["SpinRate"]],
            "ax": [r(x, 0) for x in sdf["SpinAxis"]],
            "ivb": [r(x, 1) for x in sdf["InducedVertBreak"]],
            "hb": [r(x, 1) for x in sdf["HorzBreak"]],
            "rv": [r(x, 3) for x in sdf["rv"]],
            "dv": [r(x, 3) for x in sdf["dv"]],
            "az": [r(x, 0) for x in sdf["az"]],
            "dg": [r(x, 0) for x in sdf["dg"]],
            "xivb": [r(x, 1) for x in sdf["xivb"]],
            "xhb": [r(x, 1) for x in sdf["xhb"]],
            "rh": [r(x, 2) for x in sdf["RelHeight"]],
            "rsd": [r(x, 2) for x in sdf["RelSide"]],
            "ext": [r(x, 2) for x in sdf["Extension"]],
            "vaa": [r(x, 2) for x in sdf["VertApprAngle"]],
            "px": [r(x, 2) for x in sdf["PlateLocSide"]],
            "pz": [r(x, 2) for x in sdf["PlateLocHeight"]],
            "ev": [r(x, 1) for x in sdf["ExitSpeed"]],
            "la": [r(x, 1) for x in sdf["Angle"]],
            "dir": [r(x, 1) for x in sdf["Direction"]],
            "dist": [r(x, 0) for x in sdf["Distance"]],
            "bat": [r(x, 1) for x in sdf["BatSpeed"]],
            "vat": [r(x, 1) for x in sdf["VerticalAttackAngle"]],
            "hat": [r(x, 1) for x in sdf["HorizontalAttackAngle"]],
            "xba": [r(x, 3) for x in sdf["xba"]],
            "xslg": [r(x, 3) for x in sdf["xslg"]],
            "xw": [r(x, 3) for x in sdf["xwv"]],
            "nt": [int(x) for x in sdf["nt"].fillna(0)],
            "k2": [r(x, 0) for x in sdf["k2"]],
        }
        # video: index into this season's clip list (None = no video for that pitch)
        clip_list, clip_ix = [], {}
        vcol = []
        for c in sdf["_vid"]:
            if isinstance(c, list) and c:
                key = json.dumps(c, sort_keys=True)
                if key not in clip_ix:
                    clip_ix[key] = len(clip_list)
                    clip_list.append(c)
                vcol.append(clip_ix[key])
            else:
                vcol.append(None)
        if clip_list:
            cols["vid"] = vcol
        label = sdf["slabel"].iloc[0]
        fname = f"season-{sid}.json"
        (OUT_DIR / fname).write_text(json.dumps({"id": sid, "label": label, "games": gtab, "cols": cols, "clips": clip_list},
                                                separators=(",", ":")))
        bc_games = len(gtab)
        seasons_meta.append({
            "id": sid, "label": label, "file": fname, "games": bc_games,
            "pitches": int((sdf["nt"] == 0).sum()), "resultsGames": int(sum(g["nt"] for g in gtab)),
            "resultsPA": int((sdf["nt"] >= 1).sum()), "start": min(g["d"] for g in gtab), "end": max(g["d"] for g in gtab),
        })
        log(f"  {label}: {bc_games} games, {len(sdf):,} pitches -> {fname}")

    seasons_meta.sort(key=lambda s: s["start"])
    meta = {
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": seasons_meta, "files": manifest, "teams": teams,
        "bc": BC_CANON, "players": players_out, "execution": execution, "corrections": corr_report, "bats": bats_report,
        "ncaa": ncaa_index(),
        "runvalue": rv_report,
        "video": {"report": vreport, "players": vextra["players"], "other": vextra["other"]},
        "weights": W,
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    log(f"Done in {time.time()-t0:.1f}s. {len(players_out)} players, {len(seasons_meta)} seasons.")


if __name__ == "__main__":
    sys.exit(build())
