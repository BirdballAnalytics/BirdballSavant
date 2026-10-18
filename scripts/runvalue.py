"""
Pitch run values, Savant-style swing/take run value, and a swing-decision model.

Inputs
  scripts/re288.csv  run value of every count (relative to 0-0) in each of the 24 base-out states

What this adds to every TrackMan pitch
  base  estimated runners on base when the pitch was thrown (bitmask: 1 = 1B, 2 = 2B, 4 = 3B)
  rv    run value of the pitch for the HITTER (runs; the pitcher's value is the negative)
  az    attack zone: 0 heart, 1 shadow, 2 chase, 3 waste (Savant's definitions)
  dv    swing-decision value: runs gained (+) or lost (-) versus what an average hitter does with
        the same pitch (same location, count and base-out state); 0 = average
  dg    1 if the hitter picked the higher-value choice (swing or take), else 0
  xsw   value of swinging minus value of taking for an average hitter at that location and count

TrackMan doesn't record base runners, so they are rebuilt from each half-inning's results
(hits, walks, outs, runs scored, stolen bases, caught stealing). Run expectancy for the 24
base-out states (needed to value a strikeout, walk or ball in play) is estimated from the
same data and shrunk toward a standard table where the sample is small.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

BASE_KEYS = {0: "Empty", 1: "1B", 2: "2B", 4: "3B", 3: "1B,2B", 5: "1B,3B", 6: "2B,3B", 7: "Loaded"}
COUNTS = [f"{b}-{s}" for b in range(4) for s in range(3)]
# Standard RE24 (MLB 2010-15) used only as a prior shape; rescaled to this data's run level.
RE24_PRIOR = {
    0: {0: .481, 1: .859, 2: 1.100, 4: 1.357, 3: 1.437, 5: 1.784, 6: 1.964, 7: 2.292},
    1: {0: .254, 1: .509, 2: .664, 4: .950, 3: .884, 5: 1.130, 6: 1.376, 7: 1.541},
    2: {0: .098, 1: .224, 2: .319, 4: .353, 3: .429, 5: .478, 6: .580, 7: .752},
}
SHRINK = 40          # PAs of weight given to the prior in each base-out state
HIT_BASES = {"1B": 1, "2B": 2, "3B": 3, "HR": 4, "ROE": 1, "FC": 1}

# Savant attack zones, as a share of the strike zone's half-size (zone incl. ball edge)
ZONE_HALF_W, ZONE_MID, ZONE_HALF_H = 0.83, 2.5, 1.0


def load_re288(path: Path):
    t = pd.read_csv(path)
    out = {}
    for _, r in t.iterrows():
        bases, outs = [x.strip() for x in str(r["state"]).split("|")]
        code = next(k for k, v in BASE_KEYS.items() if v == bases.replace(" ", ""))
        out[(code, int(outs.split()[0]))] = {c: float(r[c]) for c in COUNTS}
    return out


def attack_zone(px, pz):
    x = np.abs(np.asarray(px, float)) / ZONE_HALF_W
    z = np.abs(np.asarray(pz, float) - ZONE_MID) / ZONE_HALF_H
    m = np.maximum(x, z)
    az = np.select([m < 0.67, m < 1.33, m < 2.0], [0, 1, 2], 3).astype(float)
    az[np.isnan(m)] = np.nan
    return az


# ----------------------------------------------------------------------------
# Base runners
# ----------------------------------------------------------------------------
def _force(b):
    """Walk / HBP: batter to first, forced runners move up. Returns (bases, runs)."""
    on1, on2, on3 = b & 1, b & 2, b & 4
    if not on1:
        return b | 1, 0
    if not on2:
        return b | 3, 0
    if not on3:
        return 7, 0
    return 7, 1


def _bip(b, ev, runs, outs_on_play):
    """Ball in play: move runners so the runs scored match TrackMan's RunsScored."""
    runners = [p for p in (3, 2, 1) if b & (1 << (p - 1))]      # lead runner first
    adv = {"1B": 1, "2B": 2, "3B": 3, "HR": 4, "ROE": 1, "SH": 1, "FC": 0, "OUT": 0, "SF": 0}.get(ev, 0)
    new = []
    for p in runners:
        q = p + adv
        if ev == "FC" and p == 1 or ev == "FC" and p == 2 and (b & 1):
            q = p + 1                                           # forced runners move up
        if ev == "SF" and p == 3:
            q = 4
        new.append(q)
    scored = sum(q >= 4 for q in new)
    # match runs scored: push lead runners home, or hold them at third
    i = 0
    while scored < runs and i < len(new):
        if new[i] < 4:
            new[i] = 4
            scored += 1
        i += 1
    for i in range(len(new) - 1, -1, -1):
        if scored > runs and new[i] >= 4:
            new[i] = 3
            scored -= 1
    keep = sorted([q for q in new if q < 4], reverse=True)
    batter = HIT_BASES.get(ev, 0)
    # runners thrown out on the play (beyond the batter): take them from the trail end (DP grounders)
    batter_out = ev in ("OUT", "SF", "SH")
    extra = max(0, int(outs_on_play) - (1 if batter_out else 0))
    if ev == "FC":
        extra = max(extra, 1)
    keep = keep[: max(0, len(keep) - extra)]
    occ = set()
    for q in sorted(keep, reverse=True):
        while q in occ and q < 3:
            q += 1
        occ.add(min(q, 3))
    if 0 < batter < 4:
        q = batter
        while q in occ and q < 3:
            q += 1
        occ.add(q)
    return sum(1 << (q - 1) for q in occ if 1 <= q <= 3)


def reconstruct_bases(df: pd.DataFrame) -> pd.DataFrame:
    """Adds base (runners when the pitch was thrown) and base_after/inn_over for PA-ending pitches."""
    df = df.sort_values(["GameID", "Inning", "Top/Bottom", "PitchNo"], kind="stable")
    base = np.zeros(len(df), dtype=np.int8)
    after = np.full(len(df), -1, dtype=np.int8)
    pr = df["PlayResult"].fillna("").to_numpy()
    ev = df["pa"].fillna("").to_numpy()
    runs = df["RunsScored"].fillna(0).to_numpy()
    oop = df["OutsOnPlay"].fillna(0).to_numpy()
    keys = list(zip(df["GameID"], df["Inning"], df["Top/Bottom"]))
    b, prev = 0, None
    for i, k in enumerate(keys):
        if k != prev:
            b, prev = 0, k
        base[i] = b
        e = ev[i]
        if pr[i] == "StolenBase":
            if b & 1 and not b & 2:
                b = (b & ~1) | 2
            elif b & 2 and not b & 4:
                b = (b & ~2) | 4
            elif b & 4:
                b &= ~4
        elif pr[i] == "CaughtStealing":
            for bit in (1, 2, 4):
                if b & bit:
                    b &= ~bit
                    break
        if e in ("BB", "HBP"):
            b, _ = _force(b)
        elif e == "K":
            pass
        elif e:
            b = _bip(b, e, runs[i], oop[i])
        elif runs[i] > 0:                          # wild pitch / passed ball scoring a run
            for _ in range(int(runs[i])):
                for bit in (4, 2, 1):
                    if b & bit:
                        b &= ~bit
                        break
        if e:
            after[i] = b
    df = df.copy()
    df["base"], df["base_after"] = base, after
    return df


# ----------------------------------------------------------------------------
# RE24 from the data
# ----------------------------------------------------------------------------
def estimate_re24(df: pd.DataFrame):
    """Runs from each PA's starting state to the end of the half-inning (complete innings only)."""
    rows = []
    for _, g in df.groupby(["GameID", "Inning", "Top/Bottom"], sort=False):
        last = g.iloc[-1]
        end_outs = (last["Outs"] or 0) + (last["OutsOnPlay"] or 0) + (1 if last["pa"] == "K" else 0)
        if end_outs < 3:
            continue
        r = g["RunsScored"].fillna(0).to_numpy()
        rest = np.cumsum(r[::-1])[::-1]
        starts = g["PitchofPA"].eq(1).to_numpy()
        for o, bb, rr in zip(g["Outs"].to_numpy()[starts], g["base"].to_numpy()[starts], rest[starts]):
            if o in (0, 1, 2):
                rows.append((int(o), int(bb), float(rr)))
    t = pd.DataFrame(rows, columns=["outs", "base", "runs"])
    raw = t.groupby(["outs", "base"])["runs"].agg(["mean", "size"])
    # rescale the prior so its empty/0-out value matches this data's
    lvl = raw["mean"].get((0, 0), RE24_PRIOR[0][0]) / RE24_PRIOR[0][0] if len(raw) else 1.0
    re = {}
    for o in (0, 1, 2):
        for bcode in BASE_KEYS:
            prior = RE24_PRIOR[o][bcode] * lvl
            if (o, bcode) in raw.index:
                m, n = raw.loc[(o, bcode), "mean"], raw.loc[(o, bcode), "size"]
                re[(bcode, o)] = (n * m + SHRINK * prior) / (n + SHRINK)
            else:
                re[(bcode, o)] = prior
    return re, int(len(t)), float(lvl)


# ----------------------------------------------------------------------------
# Run value per pitch
# ----------------------------------------------------------------------------
def _k_val(re24, b, o):
    return (re24[(b, o + 1)] if o < 2 else 0.0) - re24[(b, o)]


def _bb_val(re24, b, o):
    nb, r = _force(b)
    return re24[(nb, o)] + r - re24[(b, o)]


def pitch_run_values(df, re288, re24):
    n = len(df)
    rv = np.full(n, np.nan)
    calls = df["call"].to_numpy()
    ev = df["pa"].fillna("").to_numpy()
    balls = df["Balls"].fillna(-1).astype(int).to_numpy()
    strikes = df["Strikes"].fillna(-1).astype(int).to_numpy()
    outs = df["Outs"].fillna(-1).astype(int).to_numpy()
    base = df["base"].to_numpy()
    after = df["base_after"].to_numpy()
    runs = df["RunsScored"].fillna(0).to_numpy()
    oop = df["OutsOnPlay"].fillna(0).astype(int).to_numpy()
    for i in range(n):
        b, s, o, bc = balls[i], strikes[i], outs[i], int(base[i])
        if not (0 <= b <= 3 and 0 <= s <= 2 and 0 <= o <= 2):
            continue
        tab = re288[(bc, o)]
        cur = tab[f"{b}-{s}"]
        e, c = ev[i], calls[i]
        if e:
            if e == "K":
                val = _k_val(re24, bc, o)
            elif e in ("BB", "HBP"):
                val = _bb_val(re24, bc, o)
            else:
                no = o + oop[i] + (0 if e in HIT_BASES and e != "FC" or oop[i] else 1 if e not in HIT_BASES else 0)
                no = o + max(oop[i], 0 if e in ("1B", "2B", "3B", "HR", "ROE") else 1)
                val = (re24[(int(after[i]), no)] if no < 3 and after[i] >= 0 else 0.0) + runs[i] - re24[(bc, o)]
            rv[i] = val - cur
        elif c == "B" or c == "IB":
            rv[i] = tab[f"{min(b + 1, 3)}-{s}"] - cur
        elif c in ("C", "S"):
            rv[i] = tab[f"{b}-{min(s + 1, 2)}"] - cur
        elif c == "F":
            rv[i] = tab[f"{b}-{min(s + 1, 2)}"] - cur
    return rv


# ----------------------------------------------------------------------------
# Swing-decision model
# ----------------------------------------------------------------------------
GRID_X = np.linspace(-2.5, 2.5, 51)
GRID_Z = np.linspace(-0.5, 5.0, 56)
SIGMA = 0.22            # ft of smoothing


def gaussian_filter(a, sigma, mode="nearest", truncate=4.0):
    """Same result as scipy.ndimage.gaussian_filter(a, sigma, mode="nearest") for a 2-D array,
    using numpy only (scipy is not installed on the build server)."""
    r = int(truncate * sigma + 0.5)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = np.asarray(a, float)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode="edge")
        out = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), axis, p)
    return out


def _smooth(x, z, w, values=None):
    """Kernel-smoothed mean (or density) of values on the location grid."""
    ix = np.clip(np.round((x - GRID_X[0]) / 0.1).astype(int), 0, len(GRID_X) - 1)
    iz = np.clip(np.round((z - GRID_Z[0]) / 0.1).astype(int), 0, len(GRID_Z) - 1)
    num = np.zeros((len(GRID_X), len(GRID_Z)))
    den = np.zeros_like(num)
    np.add.at(den, (ix, iz), w)
    np.add.at(num, (ix, iz), w * (values if values is not None else 1.0))
    sg = SIGMA / 0.1
    return gaussian_filter(num, sg, mode="nearest"), gaussian_filter(den, sg, mode="nearest")


def _lookup(grid, x, z):
    ix = np.clip(np.round((x - GRID_X[0]) / 0.1).astype(int), 0, len(GRID_X) - 1)
    iz = np.clip(np.round((z - GRID_Z[0]) / 0.1).astype(int), 0, len(GRID_Z) - 1)
    return grid[ix, iz]


def decision_model(df, re288, re24, rv):
    """For each pitch, the run value an average hitter would expect from swinging vs taking."""
    n = len(df)
    px = df["PlateLocSide"].to_numpy(float)
    pz = df["PlateLocHeight"].to_numpy(float)
    side = np.where(df["BatterSide"].eq("Left"), -1.0, 1.0)
    x = px * side                                         # mirror lefties: + = same side for everyone
    calls = df["call"].to_numpy()
    ev = df["pa"].fillna("").to_numpy()
    bunt = df["TaggedHitType"].eq("Bunt").to_numpy() | (ev == "SH")
    ok = ~np.isnan(x) & ~np.isnan(pz) & np.isin(calls, ["B", "C", "S", "F", "X", "H"]) & ~bunt
    take = ok & np.isin(calls, ["B", "C", "H"])
    swing = ok & np.isin(calls, ["S", "F", "X"])
    w = np.ones(n)
    one = lambda m: m.astype(float)
    # P(called strike | take)
    a, d = _smooth(x[take], pz[take], w[take], one(calls[take] == "C"))
    p_cs = np.divide(a, d, out=np.zeros_like(a), where=d > 1e-9)
    # swing outcomes
    _, ds = _smooth(x[swing], pz[swing], w[swing])
    a_wh, _ = _smooth(x[swing], pz[swing], w[swing], one(calls[swing] == "S"))
    a_f, _ = _smooth(x[swing], pz[swing], w[swing], one(calls[swing] == "F"))
    p_wh = np.divide(a_wh, ds, out=np.zeros_like(ds), where=ds > 1e-9)
    p_f = np.divide(a_f, ds, out=np.zeros_like(ds), where=ds > 1e-9)
    p_x = np.clip(1 - p_wh - p_f, 0, 1)
    # value of a ball in play at each location (RE24 change from the start of the PA)
    bip = swing & (calls == "X") & ~np.isnan(rv)
    base = df["base"].to_numpy()
    outs = df["Outs"].fillna(0).astype(int).to_numpy()
    b_arr = df["Balls"].fillna(0).astype(int).clip(0, 3).to_numpy()
    s_arr = df["Strikes"].fillna(0).astype(int).clip(0, 2).to_numpy()
    cur = np.array([re288[(int(bb), int(min(max(oo, 0), 2)))][f"{b}-{s}"] for bb, oo, b, s in zip(base, outs, b_arr, s_arr)])
    bip_val = rv + cur                                        # value relative to 0-0 of that state
    a_b, d_b = _smooth(x[bip], pz[bip], w[bip], bip_val[bip])
    # shrink thin locations toward the overall average ball-in-play value
    mean_bip = float(np.nanmean(bip_val[bip])) if bip.any() else 0.0
    e_bip = (a_b + 3.0 * mean_bip * (d_b / (d_b + 3.0) * 0 + 1) * 0 + 3.0 * mean_bip) / (d_b + 3.0)

    # How often an average hitter swings at this location in this kind of count
    # (0, 1 or 2 strikes with fewer than 3 balls; 3 balls)
    cgroup = np.where(b_arr == 3, 3, s_arr)
    p_sw = np.full(n, 0.5)
    for cg in range(4):
        m = ok & (cgroup == cg)
        if m.sum() < 200:
            continue
        a_s, d_s = _smooth(x[m], pz[m], w[m], one(swing[m]))
        prior = float(swing[m].mean())
        grid = np.divide(a_s + 0.05 * prior, d_s + 0.05)   # tiny shrink, only where there are no pitches at all
        p_sw[m] = _lookup(grid, x[m], pz[m])

    dv = np.full(n, np.nan)
    xsw = np.full(n, np.nan)
    good = np.full(n, np.nan)
    pc, pw, pf, px_, eb = (_lookup(g, x, pz) for g in (p_cs, p_wh, p_f, p_x, e_bip))
    for i in np.where(ok)[0]:
        o = int(outs[i])
        if not 0 <= o <= 2:
            continue
        bc, b, s = int(base[i]), int(b_arr[i]), int(s_arr[i])
        tab = re288[(bc, o)]
        v_strike = _k_val(re24, bc, o) if s == 2 else tab[f"{b}-{s + 1}"]
        v_ball = _bb_val(re24, bc, o) if b == 3 else tab[f"{b + 1}-{s}"]
        v_foul = tab[f"{b}-{s}"] if s == 2 else tab[f"{b}-{s + 1}"]
        e_take = pc[i] * v_strike + (1 - pc[i]) * v_ball
        e_swing = pw[i] * v_strike + pf[i] * v_foul + px_[i] * eb[i]
        xsw[i] = e_swing - e_take
        raw = xsw[i] if swing[i] else -xsw[i]
        # an average hitter's expected decision value on this pitch: swings p_sw of the time
        avg = (2 * p_sw[i] - 1) * xsw[i]
        dv[i] = raw - avg                     # runs above an average hitter's decision
        good[i] = 1.0 if raw > 0 else 0.0     # picked the higher-value choice
    # Recenter: within each attack zone and count group the league average is exactly 0
    # (smoothing slightly flattens swing rates at the zone edges, which would otherwise
    # credit every hitter a little)
    az = attack_zone(px, pz)
    for zz in range(4):
        for cg in range(4):
            m = np.isfinite(dv) & (az == zz) & (cgroup == cg)
            if m.sum() >= 30:
                dv[m] -= dv[m].mean()
    return dv, xsw, good


def add_run_values(df: pd.DataFrame, re_path: Path, log=print):
    """Main entry: returns df (same index) with base, rv, az, dv, xsw and a report dict."""
    rep = {}
    if not re_path.exists():
        log("  run values: scripts/re288.csv not found; skipped")
        for c in ("base", "rv", "az", "dv", "xsw", "dg"):
            df[c] = np.nan
        return df, {"error": "re288.csv missing"}
    re288 = load_re288(re_path)
    tm = df[df["nt"].eq(0)].copy()
    tm = reconstruct_bases(tm)
    re24, n_pa, lvl = estimate_re24(tm)
    rv = pitch_run_values(tm, re288, re24)
    dv, xsw, good = decision_model(tm, re288, re24, rv)
    tm["rv"], tm["dv"], tm["xsw"], tm["dg"] = rv, dv, xsw, good
    tm["az"] = attack_zone(tm["PlateLocSide"], tm["PlateLocHeight"])
    for c in ("base", "rv", "az", "dv", "xsw", "dg"):
        df[c] = np.nan
        df.loc[tm.index, c] = tm[c]
    rep = {"re24": {f"{BASE_KEYS[b]} | {o} out": round(v, 3) for (b, o), v in sorted(re24.items(), key=lambda t: (t[0][1], t[0][0]))},
           "pa_used": n_pa, "run_level_vs_mlb": round(lvl, 2),
           "pitches_valued": int(np.isfinite(rv).sum()), "decisions_graded": int(np.isfinite(dv).sum())}
    log(f"  run values: {rep['pitches_valued']:,} pitches valued, {rep['decisions_graded']:,} swing/take decisions graded "
        f"(RE24 from {n_pa:,} PAs; run level {lvl:.2f}x MLB)")
    return df, rep
