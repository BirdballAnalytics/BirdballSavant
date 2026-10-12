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

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "site" / "data"
TEAMS_FILE = Path(__file__).resolve().parent / "teams.json"

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
    "HomeTeam", "AwayTeam", "Stadium", "Level",
]
NUMERIC = [
    "PitchNo", "Inning", "PAofInning", "PitchofPA", "Outs", "Balls", "Strikes",
    "OutsOnPlay", "RunsScored", "RelSpeed", "SpinRate", "SpinAxis", "InducedVertBreak",
    "HorzBreak", "RelHeight", "RelSide", "Extension", "VertApprAngle", "PlateLocHeight",
    "PlateLocSide", "ExitSpeed", "Angle", "Direction", "Distance", "HangTime",
    "BatSpeed", "VerticalAttackAngle",
]


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------
def read_file(path: Path) -> pd.DataFrame | None:
    try:
        if path.suffix.lower() == ".csv":
            df = pd.read_csv(path, dtype=str, keep_default_na=False, low_memory=False)
        else:
            frames = pd.read_excel(path, sheet_name=None, dtype=str)
            frames = [f for f in frames.values() if "PitchCall" in f.columns]
            if not frames:
                log(f"  ! {path.name}: no TrackMan sheet found, skipped")
                return None
            df = pd.concat(frames, ignore_index=True).fillna("")
    except Exception as e:  # keep the build alive if one upload is bad
        log(f"  ! {path.name}: could not read ({e}), skipped")
        return None
    if "PitchCall" not in df.columns or "Pitcher" not in df.columns:
        log(f"  ! {path.name}: not a TrackMan export, skipped")
        return None
    df = df.reindex(columns=USECOLS + [c for c in df.columns if c not in USECOLS])
    df = df[USECOLS].copy()
    df["_ncols"] = df.notna().sum(axis=1)
    df["_file"] = str(path.relative_to(ROOT))
    return df


def load_all() -> tuple[pd.DataFrame, list[dict]]:
    files = sorted(
        p for p in DATA_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in {".csv", ".xlsx", ".xls"}
        and not p.name.startswith(("~$", "."))
    )
    log(f"Found {len(files)} data file(s) in data/")
    frames, manifest = [], []
    for p in files:
        t = time.time()
        df = read_file(p)
        if df is None:
            manifest.append({"file": p.name, "rows": 0, "status": "skipped"})
            continue
        log(f"  {p.name}: {len(df):,} rows ({time.time()-t:.1f}s)")
        manifest.append({"file": p.name, "rows": int(len(df)), "status": "ok"})
        frames.append(df)
    if not frames:
        return pd.DataFrame(columns=USECOLS), manifest
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
    return df, manifest


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
    df.loc[~df["call"].eq("X"), ["ExitSpeed", "Angle", "Direction", "Distance"]] = np.nan
    return df


# ----------------------------------------------------------------------------
# Expected stats model (kernel-smoothed on exit velocity x launch angle)
# ----------------------------------------------------------------------------
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
    df, manifest = load_all()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("season-*.json"):
        old.unlink()
    if df.empty:
        (OUT_DIR / "meta.json").write_text(json.dumps({
            "built": datetime.now(timezone.utc).isoformat(), "seasons": [], "files": manifest,
            "teams": teams, "players": []}))
        log("No data yet; wrote empty meta.json")
        return

    df = clean(df)
    df = fit_expected(df)

    # Players: BC players keyed by name (TrackMan IDs sometimes change between
    # seasons); opponents keyed by team + name.
    def pkey(name, team):
        return ("bc-" if team == BC_CANON else slug(team or "opp") + "--") + slug(name)

    df["pkey"] = [pkey(n, t) for n, t in zip(df["Pitcher"], df["PitcherTeam"])]
    df["bkey"] = [pkey(n, t) for n, t in zip(df["Batter"], df["BatterTeam"])]

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
        if switch_ok and len(counts) > 1 and min(counts.values()) >= 0.1 * tot:
            return "S"
        return max(counts, key=counts.get)[0]

    plist = sorted(players.values(), key=lambda p: (not p["bc"], p["n"]))
    pidx = {p["k"]: i for i, p in enumerate(plist)}
    players_out = [{
        "k": p["k"], "n": p["n"], "t": p["t"], "bc": p["bc"],
        "th": hand(p["throws"], False), "b": hand(p["bats"], True),
        "hit": sorted(p["hit"]), "pit": sorted(p["pit"]),
    } for p in plist]

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
                "id": g, "d": gd.isoformat(), "opp": opp,
                "home": home == BC_CANON if opp else True,
                "st": st.iloc[0] if len(st) else "",
                "n": int(len(gg)),
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
            "xba": [r(x, 3) for x in sdf["xba"]],
            "xslg": [r(x, 3) for x in sdf["xslg"]],
            "xw": [r(x, 3) for x in sdf["xwv"]],
        }
        label = sdf["slabel"].iloc[0]
        fname = f"season-{sid}.json"
        (OUT_DIR / fname).write_text(json.dumps({"id": sid, "label": label, "games": gtab, "cols": cols},
                                                separators=(",", ":")))
        bc_games = len(gtab)
        seasons_meta.append({
            "id": sid, "label": label, "file": fname, "games": bc_games,
            "pitches": int(len(sdf)), "start": min(g["d"] for g in gtab), "end": max(g["d"] for g in gtab),
        })
        log(f"  {label}: {bc_games} games, {len(sdf):,} pitches -> {fname}")

    seasons_meta.sort(key=lambda s: s["start"])
    meta = {
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": seasons_meta, "files": manifest, "teams": teams,
        "bc": BC_CANON, "players": players_out,
        "weights": W,
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    log(f"Done in {time.time()-t0:.1f}s. {len(players_out)} players, {len(seasons_meta)} seasons.")


if __name__ == "__main__":
    sys.exit(build())
