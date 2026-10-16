"""
Hit+ (Baseball America's hitting-quality metric), scaled to the TruMedia D1 pool.

Baseball America's recipe (BA publishes the method, not the exact weights):
  * five inputs: contact %, 90th-percentile exit velocity, chase %, barrel %, xwOBA on contact
  * split by pitch type: fastballs, breaking balls, offspeed
  * each input regressed toward the average by sample size, then put on a 100 / 10-SD scale
    within each pitch type
  * inputs weighted by how strongly they correlate with wOBA
  * the three pitch types weighted equally; 100 = average, every 10 points = one SD

Here the population is every D1 hitter in the TruMedia pull for that season. The scale
(means, SDs, weights) is saved with the NCAA data so the site can score BC hitters from
TrackMan the same way (fall seasons, and anyone TruMedia doesn't have).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# metric key, direction (+1 = higher is better), default regression constant (PA in that group)
METRICS = [("contact", 1, 30), ("ev90", 1, 40), ("chase", -1, 40), ("barrel", 1, 60), ("xwobacon", 1, 60)]
GROUPS = ["FB", "BR", "OS"]
GROUP_NAMES = {"FB": "Fastballs", "BR": "Breaking", "OS": "Offspeed", "ALL": "All pitches"}


def to_frac(s: pd.Series) -> pd.Series:
    s = pd.to_numeric(s.astype(str).str.replace("%", "").str.replace(",", ""), errors="coerce")
    return s / 100 if s.abs().median() > 1.5 else s


def regress(x, n, mean, k):
    x = np.where(np.isnan(x), mean, x)
    n = np.where(np.isnan(n), 0, n)
    return (n * x + k * mean) / (n + k)


def build(groups: dict[str, pd.DataFrame], overall: pd.DataFrame, min_pa: float, kmult: float = 1.0,
          k_override: dict | None = None):
    """groups: group -> DataFrame indexed by player id with columns n + metric keys (fractions / mph).
    overall: DataFrame indexed by player id with PA and wOBA (season totals).
    Returns (scale, scores DataFrame indexed by id with columns hit, and one per group)."""
    ids = overall.index
    qual = overall["PA"].fillna(0) >= min_pa
    woba = overall["wOBA"]
    scale = {"groups": list(groups), "min_pa": min_pa, "per": {}, "comp": {}, "metrics": []}
    kk = {m: (k_override or {}).get(m, k) * kmult for m, _, k in METRICS}
    scale["metrics"] = [{"k": m, "dir": d, "kreg": kk[m]} for m, d, _ in METRICS]
    scores = pd.DataFrame(index=ids)
    for g, gdf in groups.items():
        gdf = gdf.reindex(ids)
        n = gdf["n"].to_numpy(float)
        zs, ws, per = [], [], {}
        for m, d, _ in METRICS:
            if m not in gdf or gdf[m].notna().sum() < 30:
                continue
            x = gdf[m].to_numpy(float)
            has = ~np.isnan(x) & (np.nan_to_num(n) > 0)
            mean = float(np.average(x[has], weights=n[has])) if has.any() else float(np.nanmean(x))
            xr = regress(x, n, mean, kk[m])
            sd = float(np.nanstd(xr[qual.to_numpy()])) or 1e-9
            z = d * (xr - mean) / sd
            r = pd.Series(xr[qual.to_numpy()]).corr(pd.Series(woba[qual].to_numpy(float)))
            w = abs(r) if r == r else 0.2
            per[m] = {"mean": round(mean, 5), "sd": round(sd, 5), "w": round(w, 4)}
            zs.append(z)
            ws.append(w)
        if not zs:
            continue
        comp = np.average(np.vstack(zs), axis=0, weights=ws)
        cm, cs = float(np.mean(comp[qual.to_numpy()])), float(np.std(comp[qual.to_numpy()])) or 1e-9
        scale["per"][g] = per
        scale["comp"][g] = {"mean": round(cm, 5), "sd": round(cs, 5)}
        scores[g] = 100 + 10 * (comp - cm) / cs
    gcols = [g for g in groups if g in scores]
    if not gcols:
        return None, None
    avg = scores[gcols].mean(axis=1)
    fm, fs = float(avg[qual].mean()), float(avg[qual].std(ddof=0)) or 1e-9
    scale["final"] = {"mean": round(fm, 5), "sd": round(fs, 5)}
    scale["groups"] = gcols
    scores["hit"] = 100 + 10 * (avg - fm) / fs
    return scale, scores.round(1)


def score_one(metrics_by_group: dict, scale: dict):
    """Score one hitter with a saved scale (same math the site uses in app.js)."""
    gs = []
    for g in scale["groups"]:
        per, mg = scale["per"].get(g, {}), metrics_by_group.get(g, {})
        zs, ws = [], []
        for m in scale["metrics"]:
            p = per.get(m["k"])
            if not p:
                continue
            x, n = mg.get(m["k"]), mg.get("n", 0) or 0
            x = p["mean"] if x is None or x != x else x
            xr = (n * x + m["kreg"] * p["mean"]) / (n + m["kreg"])
            zs.append(m["dir"] * (xr - p["mean"]) / p["sd"])
            ws.append(p["w"])
        if zs:
            comp = sum(z * w for z, w in zip(zs, ws)) / sum(ws)
            c = scale["comp"][g]
            gs.append(100 + 10 * (comp - c["mean"]) / c["sd"])
    if not gs:
        return None
    f = scale["final"]
    return 100 + 10 * (sum(gs) / len(gs) - f["mean"]) / f["sd"]
