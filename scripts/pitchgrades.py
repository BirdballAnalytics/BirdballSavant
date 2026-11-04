"""
Stuff+, Location+ and Pitching+ (BirdballSavant's own pitch-quality grades).

Every TrackMan pitch in the data (BC and opponents, all seasons) gets three predictions of how
many runs it saves, on average, for a pitch like it:

  Stuff     what the ball does: velocity, induced vertical / horizontal break, spin, extension,
            release height and side, and the gap from the pitcher's main fastball (velo and
            movement), plus pitch group and same-hand vs opposite-hand batter. Judged on swings
            only (location left out): half how often pitches like it are swung through, half the
            runs they save per swing. In testing, this version tracked real whiff rates
            (r = .52, and .52 from one season to the next) far better than a straight run-value fit.
  Location  where it went for the count: plate location (mirrored so "inside" means inside for
            either batter side), balls, strikes, pitch group and same/opposite hand.
  Pitching  both sets together.

What it learns from is each pitch's expected run value (RE288 count/base-out run value, pitcher's
side). For balls in play it uses the value expected from the contact quality (xwOBA on exit velo
and launch angle) rather than where the ball happened to land, so a hard line drive caught is
still charged to the pitcher.

Models are gradient-boosted trees, fitted "out of fold" by pitcher: a pitcher's own pitches are
never used to grade him (5 groups), so he can't be graded on memorised results.

The site shows the average over any set of pitches on a 100 scale: 100 = average pitch in the
data, every 10 points = one standard deviation of pitcher-pitch-type averages (like Hit+).
Columns exported per pitch as integers (value x MULT): sp (Stuff score), lp, pp (expected runs saved).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

FB_TYPES = ("FF", "SI", "FC")
GROUP = {"FF": 0, "SI": 0, "FC": 0, "SL": 1, "ST": 1, "CU": 1, "KN": 1, "SV": 1, "CH": 2, "FS": 2}
MIN_GROUP = 25          # pitches for a pitcher-pitch type average to count when setting the scale
MULT = {"sp": 1000, "lp": 10000, "pp": 10000}   # stored as integers: value x MULT


def _xrv(df: pd.DataFrame) -> np.ndarray:
    """Expected run value per pitch, pitcher's side (positive = good for the pitcher)."""
    rv = df["rv"].to_numpy(float)
    bip = df["call"].eq("X").to_numpy() & np.isfinite(rv)
    xw = df["xwv"].to_numpy(float) if "xwv" in df.columns else np.full(len(df), np.nan)
    use = bip & np.isfinite(xw)
    y = rv.copy()
    if use.sum() > 200:
        b, a = np.polyfit(xw[use], rv[use], 1)
        y[use] = a + b * xw[use]
    return -y


def _features(df: pd.DataFrame):
    lhp = df["PitcherThrows"].eq("Left").to_numpy()
    lhb = df["BatterSide"].eq("Left").to_numpy()
    mir = np.where(lhp, -1.0, 1.0)
    same = (lhp == lhb).astype(float)
    grp = df["pt"].map(GROUP).astype(float).to_numpy()
    v, ivb = df["RelSpeed"].to_numpy(float), df["InducedVertBreak"].to_numpy(float)
    hb = df["HorzBreak"].to_numpy(float) * mir
    # pitcher's main fastball (most-thrown of FF / SI / FC) in that season
    key = df["Pitcher"].astype(str) + "|" + df["PitcherTeam"].astype(str) + "|" + df["season"].astype(str)
    fb = df[df["pt"].isin(FB_TYPES)].assign(k=key)
    main = fb.groupby(["k", "pt"]).size().reset_index(name="n").sort_values("n").drop_duplicates("k", keep="last")
    fbm = fb.merge(main[["k", "pt"]], on=["k", "pt"]).groupby("k").agg(fv=("RelSpeed", "mean"), fivb=("InducedVertBreak", "mean"),
                                                                      fhb=("HorzBreak", "mean"))
    fv = key.map(fbm["fv"]).to_numpy(float)
    fivb = key.map(fbm["fivb"]).to_numpy(float)
    fhb = key.map(fbm["fhb"]).to_numpy(float) * mir
    stuff = np.column_stack([v, ivb, hb, df["SpinRate"].to_numpy(float), df["Extension"].to_numpy(float),
                             df["RelHeight"].to_numpy(float), df["RelSide"].to_numpy(float) * mir,
                             v - fv, ivb - fivb, hb - fhb, grp, same])
    # location from the batter's point of view: + = inside for either side
    px = df["PlateLocSide"].to_numpy(float) * np.where(lhb, 1.0, -1.0)
    loc = np.column_stack([px, df["PlateLocHeight"].to_numpy(float), df["Balls"].to_numpy(float),
                           df["Strikes"].to_numpy(float), grp, same])
    return stuff, loc


def add_pitch_grades(df: pd.DataFrame, log=print):
    for c in ("sp", "lp", "pp"):
        df[c] = np.nan
    rep = {}
    try:
        from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
        from sklearn.model_selection import GroupKFold
    except Exception:
        log("  pitch grades: scikit-learn not installed; skipped")
        return df, {"error": "scikit-learn not installed"}
    need = ["RelSpeed", "InducedVertBreak", "HorzBreak", "SpinRate", "Extension", "RelHeight", "RelSide",
            "PlateLocSide", "PlateLocHeight", "Balls", "Strikes"]
    ok = (df["nt"].eq(0) & df["pt"].isin(GROUP.keys()) & df["PitcherThrows"].isin(["Left", "Right"])
          & df["BatterSide"].isin(["Left", "Right"]) & df[need].notna().all(axis=1) & df["rv"].notna()
          & ~df["call"].isin(["IB", "U"]))
    sub = df[ok]
    if len(sub) < 2000:
        log(f"  pitch grades: only {len(sub)} usable pitches; skipped")
        return df, {"error": "not enough pitches"}
    y = _xrv(sub)
    Xs, Xl = _features(sub)
    groups = pd.factorize(sub["Pitcher"].astype(str) + "|" + sub["PitcherTeam"].astype(str))[0]
    folds = list(GroupKFold(n_splits=5).split(Xs, y, groups))

    def oof(X, target, mask=None, cls=False):
        out = np.full(len(target), np.nan)
        for tr, te in folds:
            if mask is not None:
                tr = tr[mask[tr]]
            M = (HistGradientBoostingClassifier if cls else HistGradientBoostingRegressor)(
                learning_rate=0.05, max_iter=250, max_leaf_nodes=24, min_samples_leaf=120, l2_regularization=1.0, random_state=7)
            M.fit(X[tr], target[tr])
            out[te] = M.predict_proba(X[te])[:, 1] if cls else M.predict(X[te])
        return out

    z = lambda a: (a - np.nanmean(a)) / np.nanstd(a)
    swing = sub["call"].isin(["S", "F", "X"]).to_numpy()
    whiff = sub["call"].eq("S").to_numpy()
    # Stuff: judged on what happens when hitters swing (misses, and damage on contact), from the
    # ball's flight only. Half how often a pitch like it gets missed, half the runs it saves per swing.
    p_whiff = oof(Xs, whiff, swing, cls=True)
    swing_rv = oof(Xs, y, swing)
    preds = {"sp": 0.5 * z(p_whiff) + 0.5 * z(swing_rv),
             "lp": oof(Xl, y),                                   # Location: expected runs saved from spot + count
             "pp": oof(np.column_stack([Xs, Xl[:, :4]]), y)}     # Pitching: both together
    for name, pred in preds.items():
        df.loc[sub.index, name] = pred
        # scale: 100 = average pitch; 10 points = 1 SD of pitcher-pitch type averages
        g = pd.DataFrame({"p": groups, "pt": sub["pt"].to_numpy(), "v": pred}).groupby(["p", "pt"])["v"].agg(["mean", "size"])
        g = g[g["size"] >= MIN_GROUP]
        mu = float(np.mean(pred))
        sd = float(np.sqrt(np.average((g["mean"] - mu) ** 2, weights=g["size"]))) if len(g) > 5 else float(np.std(pred))
        r = float(np.corrcoef(pred, y)[0, 1])
        rep[name] = {"mu": round(mu, 6), "sd": round(sd, 6), "mult": MULT[name], "pitches": int(len(sub)), "groups": int(len(g)), "r": round(r, 3)}
    log(f"  pitch grades: Stuff+ / Location+ / Pitching+ fitted on {len(sub):,} pitches "
        f"({rep['sp']['groups']} pitcher-pitch types with {MIN_GROUP}+ pitches set the scale)")
    return df, rep
