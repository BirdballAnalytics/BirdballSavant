/* BirdballSavant — Boston College Baseball TrackMan site.
   All stats are computed in the browser from the pitch-level files that
   scripts/build.py writes to data/. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { meta: null, players: [], pidx: new Map(), seasons: {}, season: null, sort: {}, ui: {} };

/* ---------- constants ---------- */
const MIN_PA = 5;   // hitters: plate appearances; pitchers: batters faced
const PT = {
  FF: { n: 'Four-Seam', c: '#d22d49' }, SI: { n: 'Sinker', c: '#ef8b00' }, FC: { n: 'Cutter', c: '#933f2c' },
  SL: { n: 'Slider', c: '#c4b000' }, ST: { n: 'Sweeper', c: '#b07d1c' }, CU: { n: 'Curveball', c: '#00a6c2' },
  CH: { n: 'Changeup', c: '#1fa83a' }, FS: { n: 'Splitter', c: '#3a9a9a' }, KN: { n: 'Knuckleball', c: '#6a3bd1' },
  UN: { n: 'Untagged', c: '#9c8975' },
};
const PT_ORDER = ['FF', 'SI', 'FC', 'SL', 'ST', 'CU', 'CH', 'FS', 'KN', 'UN'];
const GROUP = { FF: 'Fastballs', SI: 'Fastballs', FC: 'Fastballs', SL: 'Breaking', ST: 'Breaking', CU: 'Breaking', KN: 'Breaking', CH: 'Offspeed', FS: 'Offspeed', UN: 'Other' };
const WT = { BB: 0.69, HBP: 0.72, '1B': 0.89, '2B': 1.27, '3B': 1.62, HR: 2.10 };
const ZW = 0.83, ZB = 1.5, ZT = 3.5;           // strike zone (ft): half-width incl. ball, bottom, top
const RES_NAME = { '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'Home Run', BB: 'Walk', HBP: 'Hit by Pitch', K: 'Strikeout', OUT: 'Out', SF: 'Sac Fly', SH: 'Sac Bunt', ROE: 'Reached on Error', FC: "Fielder's Choice" };
const CALL_NAME = { B: 'Ball', IB: 'Intentional Ball', C: 'Called Strike', S: 'Swinging Strike', F: 'Foul', X: 'In Play', H: 'Hit by Pitch', U: '—' };
const HT_NAME = { GB: 'Ground ball', LD: 'Line drive', FB: 'Fly ball', PU: 'Popup', BU: 'Bunt' };

/* ---------- formatting ---------- */
const F = {
  avg: v => v == null || !isFinite(v) ? '—' : (v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, '')),
  pct: v => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1),
  f1: v => v == null || !isFinite(v) ? '—' : v.toFixed(1),
  f2: v => v == null || !isFinite(v) ? '—' : v.toFixed(2),
  int: v => v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString(),
  ip: outs => outs == null ? '—' : `${Math.floor(outs / 3)}.${outs % 3}`,
  str: v => v == null || v === '' ? '—' : esc(v),
};
const fmtDate = (d, long) => {
  const [y, m, dd] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  return dt.toLocaleDateString('en-US', long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
};
const teamName = c => (S.meta && S.meta.teams[c]) || c || '';
const isBC = c => c === (S.meta?.bc || 'BOC_EAG');
const pname = i => S.players[i]?.n || '?';
const plink = i => `<a href="#player-${esc(S.players[i].k)}">${esc(niceName(S.players[i].n))}</a>`;
const niceName = n => { const m = String(n).match(/^([^,]+),\s*(.+)$/); return m ? `${m[2]} ${m[1]}` : n; };
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : null;
const ls = {
  get(k, d) { try { const v = localStorage.getItem('bbs:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bbs:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

/* ---------- loading ---------- */
async function getJSON(u) {
  const r = await fetch(u, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Could not load ${u} (${r.status})`);
  return r.json();
}
async function loadMeta() {
  S.meta = await getJSON('data/meta.json');
  S.players = S.meta.players;
  S.players.forEach((p, i) => S.pidx.set(p.k, i));
  const saved = ls.get('season', null);
  const ids = S.meta.seasons.map(s => s.id);
  S.season = ids.includes(saved) ? saved : ids[ids.length - 1];
  const nn = $('#nav-ncaa'); if (nn) nn.hidden = !(S.meta.ncaa?.years || []).length;
  const vr = S.meta.video?.report, nv = $('#nav-video');
  if (nv) nv.hidden = !(vr && (vr.pitches || vr.pas || vr.games || vr.players || vr.other));
  const fb = $('#foot-built');
  if (fb && S.meta.built) fb.textContent = 'Data updated ' + new Date(S.meta.built).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function zone13(px, pz) {
  if (px == null || pz == null) return null;
  if (Math.abs(px) <= ZW && pz >= ZB && pz <= ZT) {
    const col = Math.min(2, Math.max(0, Math.floor((px + ZW) / (2 * ZW / 3))));
    const row = Math.min(2, Math.max(0, Math.floor((ZT - pz) / ((ZT - ZB) / 3))));
    return row * 3 + col + 1;
  }
  const top = pz >= (ZB + ZT) / 2;
  return px < 0 ? (top ? 11 : 13) : (top ? 12 : 14);
}
async function loadSeason(id) {
  if (S.seasons[id]) return S.seasons[id];
  const m = S.meta.seasons.find(s => s.id === id);
  const j = await getJSON('data/' + m.file);
  const c = j.cols, keys = Object.keys(c), n = c.g.length, rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = { sid: id };
    for (const k of keys) o[k] = c[k][i];
    o.sw = o.c === 'S' || o.c === 'F' || o.c === 'X';
    o.wh = o.c === 'S';
    o.z = zone13(o.px, o.pz);
    o.iz = o.z == null ? null : o.z <= 9;
    o.d = j.games[o.g].d;
    rows[i] = o;
  }
  const byP = new Map(), byH = new Map();
  for (const r of rows) {
    if (!byP.has(r.p)) byP.set(r.p, []); byP.get(r.p).push(r);
    if (!byH.has(r.h)) byH.set(r.h, []); byH.get(r.h).push(r);
  }
  const se = { id, label: j.label, games: j.games, rows, byP, byH, cache: {}, clips: j.clips || [] };
  S.seasons[id] = se;
  await prepHitPlus(se);
  return se;
}
const seasonLabel = id => S.meta.seasons.find(s => s.id === id)?.label || id;

/* ---------- stats engine ---------- */
function isBarrel(ev, la) {
  if (ev == null || la == null || ev < 98) return false;
  const lo = Math.max(8, 26 - (ev - 98)), hi = Math.min(50, 30 + (ev - 98) * (20 / 18));
  return la >= lo && la <= hi;
}
const AB_EVENTS = new Set(['1B', '2B', '3B', 'HR', 'K', 'OUT', 'ROE', 'FC']);
function quantile(arr, q) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }

/* One pass over pitches (from a hitter's or pitcher's side). */
function stats(rows) {
  const t = { pitches: 0, PA: 0, AB: 0, H: 0, '1B': 0, '2B': 0, '3B': 0, HR: 0, BB: 0, HBP: 0, K: 0, SF: 0, SH: 0, ROE: 0, TB: 0,
    wsum: 0, xwsum: 0, xbasum: 0, xslgsum: 0, bbe: 0, evs: [], las: [], hh: 0, brl: 0, ss: 0, gb: 0, ld: 0, fb: 0, pu: 0, htN: 0,
    pull: 0, cent: 0, oppo: 0, dirN: 0, sw: 0, wh: 0, zn: 0, zsw: 0, zcon: 0, ozn: 0, osw: 0, ocon: 0, locN: 0, fpN: 0, fps: 0, fpk: 0, csw: 0,
    bats: [], runs: 0, outs: 0, games: new Set(), dists: [], ntPA: 0, tAB: 0, tden: 0,
    fast: 0, vats: [], ideal: 0, hats: [], sqN: 0, sq: 0, blast: 0, k2PA: 0, k2W: 0,
    rvN: 0, rv: 0, rvSw: 0, rvTk: 0 };
  for (const r of rows) {
    t.games.add(r.sid + ':' + r.g);
    const nt = r.nt === 1;          // results-only PA with no tracking at all
    if (!r.nt) {                     // pitch-by-pitch TrackMan rows only
    t.pitches++;
    if (r.sw) { t.sw++; if (r.wh) t.wh++; }
    if (r.iz === true) { t.zn++; t.locN++; if (r.sw) { t.zsw++; if (!r.wh) t.zcon++; } }
    else if (r.iz === false) { t.ozn++; t.locN++; if (r.sw) { t.osw++; if (!r.wh) t.ocon++; } }
    if (r.ppa === 1) { t.fpN++; if (r.sw) t.fps++; if (r.c === 'C' || r.c === 'S' || r.c === 'F' || r.c === 'X') t.fpk++; }
    if (r.c === 'C' || r.c === 'S') t.csw++;
    if (r.rv != null && r.az != null && r.c !== 'IB' && r.c !== 'U') { t.rvN++; t.rv += r.rv; if (r.sw) t.rvSw += r.rv; else t.rvTk += r.rv; }
    if (r.bat != null && r.bat >= 50 && r.bat <= 95 && r.sw) {
      t.bats.push(r.bat);
      if (r.bat >= 75) t.fast++;
      if (r.vat != null) { t.vats.push(r.vat); if (r.vat >= 5 && r.vat <= 20) t.ideal++; }
      if (r.hat != null && r.bs) t.hats.push(r.bs === 'L' ? r.hat : -r.hat);
      if (r.c === 'X' && r.ev != null && r.v != null && r.ht !== 'BU') {
        const sqPct = r.ev / (1.23 * r.bat + 0.23 * r.v);
        t.sqN++; if (sqPct >= 0.8) t.sq++; if (sqPct * 100 + r.bat >= 164) t.blast++;
      }
    }
    t.runs += r.rs || 0; t.outs += r.oop || 0; if (r.r === 'K' && !r.oop) t.outs++;
    }
    if (r.c === 'X' && r.ht !== 'BU') {
      if (r.ev != null) {
        t.bbe++; t.evs.push(r.ev);
        if (r.ev >= 95) t.hh++;
        if (r.la != null) { t.las.push(r.la); if (r.la >= 8 && r.la <= 32) t.ss++; if (isBarrel(r.ev, r.la)) t.brl++; }
      }
      if (r.ht) { t.htN++; if (r.ht === 'GB') t.gb++; else if (r.ht === 'LD') t.ld++; else if (r.ht === 'FB') t.fb++; else if (r.ht === 'PU') t.pu++; }
      if (r.dir != null && r.bs) {
        t.dirN++;
        const pull = r.bs === 'R' ? r.dir < -15 : r.dir > 15, oppo = r.bs === 'R' ? r.dir > 15 : r.dir < -15;
        if (pull) t.pull++; else if (oppo) t.oppo++; else t.cent++;
      }
      if (r.dist != null && r.la != null && r.la > 10) t.dists.push(r.dist);
    }
    const e = r.r; if (!e) continue;
    t.PA++;
    if (r.k2 === 1) { t.k2PA++; if (e !== 'K') t.k2W++; }
    if (nt) t.ntPA++;
    else { if (AB_EVENTS.has(e)) t.tAB++; if (e === 'BB' || e === 'HBP' || e === 'SF' || AB_EVENTS.has(e)) t.tden++; }
    if (e in t) t[e]++;
    if (AB_EVENTS.has(e)) t.AB++;
    if (e === '1B' || e === '2B' || e === '3B' || e === 'HR') { t.H++; t.TB += { '1B': 1, '2B': 2, '3B': 3, HR: 4 }[e]; }
    if (e !== 'SH') {
      t.wsum += WT[e] || 0;
      if (!nt) {
        if (e === 'BB' || e === 'HBP') t.xwsum += WT[e];
        else if (r.c === 'X') t.xwsum += r.xw ?? (WT[e] || 0);
      }
    }
    if (!nt && r.c === 'X' && AB_EVENTS.has(e)) { t.xbasum += r.xba ?? 0; t.xslgsum += r.xslg ?? 0; }
  }
  const d = (a, b) => b > 0 ? a / b : null;
  const wden = t.AB + t.BB + t.SF + t.HBP;
  const o = {
    G: t.games.size, pitches: t.pitches, PA: t.PA, AB: t.AB, H: t.H, '1B': t['1B'], '2B': t['2B'], '3B': t['3B'], HR: t.HR, BB: t.BB, HBP: t.HBP, K: t.K, SF: t.SF, SH: t.SH, ROE: t.ROE, TB: t.TB,
    avg: d(t.H, t.AB), obp: d(t.H + t.BB + t.HBP, t.AB + t.BB + t.HBP + t.SF), slg: d(t.TB, t.AB),
    woba: d(t.wsum, wden), xwoba: d(t.xwsum, t.tden), xba: d(t.xbasum, t.tAB), xslg: d(t.xslgsum, t.tAB), ntPA: t.ntPA,
    babip: d(t.H - t.HR, t.AB - t.K - t.HR + t.SF),
    kPct: d(t.K, t.PA), bbPct: d(t.BB, t.PA),
    bbe: t.bbe, avgEV: mean(t.evs), maxEV: t.evs.length ? Math.max(...t.evs) : null, ev90: quantile(t.evs, 0.9), avgLA: mean(t.las),
    hhPct: d(t.hh, t.bbe), brlPct: d(t.brl, t.bbe), brl: t.brl, ssPct: d(t.ss, t.las.length),
    gbPct: d(t.gb, t.htN), ldPct: d(t.ld, t.htN), fbPct: d(t.fb, t.htN), puPct: d(t.pu, t.htN),
    pullPct: d(t.pull, t.dirN), centPct: d(t.cent, t.dirN), oppoPct: d(t.oppo, t.dirN),
    swing: d(t.sw, t.pitches), whiff: d(t.wh, t.sw), zone: d(t.zn, t.locN), zswing: d(t.zsw, t.zn), chase: d(t.osw, t.ozn),
    zcontact: d(t.zcon, t.zsw), contact: d(t.sw - t.wh, t.sw), fpSwing: d(t.fps, t.fpN), fpStrike: d(t.fpk, t.fpN), csw: d(t.csw, t.pitches),
    batSpd: t.bats.length ? mean(t.bats) : null, maxBat: t.bats.length ? Math.max(...t.bats) : null, swingsTracked: t.bats.length,
    batTop: t.bats.length ? mean([...t.bats].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(t.bats.length * 0.1)))) : null,
    fastPct: t.bats.length ? t.fast / t.bats.length : null,
    attackAngle: t.vats.length ? mean(t.vats) : null, idealAA: t.vats.length ? t.ideal / t.vats.length : null,
    attackDir: t.hats.length ? mean(t.hats) : null,
    k2win: d(t.k2W, t.k2PA), k2PA: t.k2PA, k2W: t.k2W,
    sqPct: t.sqN ? t.sq / t.sqN : null, blastPct: t.sqN ? t.blast / t.sqN : null, contactsTracked: t.sqN,
    rv: t.rvN ? t.rv : null, rvSwing: t.rvN ? t.rvSw : null, rvTake: t.rvN ? t.rvTk : null,
    rv100: t.rvN ? 100 * t.rv / t.rvN : null, rvPitches: t.rvN,
    runs: t.runs, outs: t.outs, maxDist: t.dists.length ? Math.max(...t.dists) : null,
  };
  o.ops = o.obp != null && o.slg != null ? o.obp + o.slg : null;
  o.iso = o.slg != null && o.avg != null ? o.slg - o.avg : null;
  o.kbb = o.kPct != null ? o.kPct - o.bbPct : null;
  o.wobaDiff = o.xwoba != null && o.woba != null && !t.ntPA ? o.woba - o.xwoba : null;
  return o;
}
function pitchShape(rows) {
  const fb = rows.filter(r => (r.pt === 'FF' || r.pt === 'SI') && r.v != null);
  const prim = (() => { const ff = fb.filter(r => r.pt === 'FF').length, si = fb.length - ff; return ff >= si ? 'FF' : 'SI'; })();
  const pf = fb.filter(r => r.pt === prim);
  const v = rows.map(r => r.v).filter(x => x != null);
  return {
    fbVelo: mean(fb.map(r => r.v)), fbMax: fb.length ? Math.max(...fb.map(r => r.v)) : null,
    maxVelo: v.length ? Math.max(...v) : null,
    fbSpin: mean(pf.map(r => r.spin).filter(x => x != null)), fbIVB: mean(pf.map(r => r.ivb).filter(x => x != null)),
    ext: mean(rows.map(r => r.ext).filter(x => x != null)),
  };
}
// Expected movement (from the build): what this pitch type usually does for pitchers with the same
// arm slot and velocity. dIVB > 0 = more carry / less drop than expected; dHB is in arm-side terms
// (> 0 = more arm-side run, < 0 = more glove-side sweep), so it reads the same for lefties and righties.
function xMove(a) {
  const ok = a.filter(r => r.xivb != null && r.xhb != null && r.ivb != null && r.hb != null);
  if (!ok.length) return { xivb: null, xhb: null, divb: null, dhb: null };
  const arm = r => (r.th === 'L' ? -1 : 1);
  return {
    xivb: mean(ok.map(r => r.xivb)), xhb: mean(ok.map(r => r.xhb)),
    divb: mean(ok.map(r => r.ivb - r.xivb)), dhb: mean(ok.map(r => (r.hb - r.xhb) * arm(r))),
  };
}
const fmtD = v => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
const XMOV_COLS = [
  { k: 'divb', label: 'IVB vs x', fmt: fmtD, tip: 'Induced vertical break compared with what the same pitch type does for pitchers with this arm slot and velocity. + = more carry (or less drop) than expected, in inches.' },
  { k: 'dhb', label: 'HB vs x', fmt: fmtD, tip: 'Horizontal break compared with what is expected for this arm slot and velocity, in arm-side terms. + = more arm-side run, − = more glove-side sweep, in inches.' },
];
function arsenal(rows) {
  const total = rows.length, by = {};
  for (const r of rows) (by[r.pt] = by[r.pt] || []).push(r);
  const vsR = rows.filter(r => r.bs === 'R').length, vsL = rows.filter(r => r.bs === 'L').length;
  return PT_ORDER.filter(k => by[k]).map(k => {
    const a = by[k], st = stats(a), nn = f => a.map(f).filter(x => x != null);
    const two = a.filter(r => r.s === 2);
    return {
      pt: k, n: a.length, use: a.length / total,
      useR: vsR ? a.filter(r => r.bs === 'R').length / vsR : null, useL: vsL ? a.filter(r => r.bs === 'L').length / vsL : null,
      v: mean(nn(r => r.v)), vmax: nn(r => r.v).length ? Math.max(...nn(r => r.v)) : null, spin: mean(nn(r => r.spin)),
      ivb: mean(nn(r => r.ivb)), hb: mean(nn(r => r.hb)), vaa: mean(nn(r => r.vaa)), ext: mean(nn(r => r.ext)),
      ...xMove(a),
      rh: mean(nn(r => r.rh)), rs: mean(nn(r => r.rsd)), axis: mean(nn(r => r.ax)),
      whiff: st.whiff, csw: st.csw, chase: st.chase, zone: st.zone, avgEV: st.avgEV, hhPct: st.hhPct,
      xwoba: st.xwoba, woba: st.woba, xba: st.xba, ba: st.avg, PA: st.PA, K: st.K,
      putaway: two.length ? two.filter(r => r.r === 'K').length / two.length : null,
    };
  });
}

/* Season tables of BC hitters / pitchers, with qualification thresholds. */
/* ---------- Hit+ (Baseball America), scaled to the TruMedia D1 pool ---------- */
// The scale (means, SDs, weights) is built from every D1 hitter by scripts/trumedia.py + hitplus.py.
// BC hitters TruMedia has (spring) use TruMedia's own number; everyone else (fall, or not in
// TruMedia) is scored from TrackMan with the same scale, after a calibration step that lines up
// TrackMan's inputs with TruMedia's using BC hitters who appear in both.
const HP_GROUPS = { FB: ['FF', 'SI', 'FC'], BR: ['SL', 'ST', 'CU', 'KN'], OS: ['CH', 'FS'] };
const normName = n => { const m = String(n).match(/^([^,]+),\s*(.+)$/); return (m ? `${m[2]} ${m[1]}` : String(n)).toLowerCase().replace(/[^a-z]/g, ''); };
function hpInputs(rows, scale) {
  const out = {};
  for (const g of scale.groups) {
    const a = rows.filter(r => !r.nt && (g === 'ALL' || (HP_GROUPS[g] || []).includes(r.pt)));
    const sw = a.filter(r => r.sw), oz = a.filter(r => r.iz === false);
    const bbe = a.filter(r => r.c === 'X' && r.ev != null && r.ht !== 'BU');
    const evs = bbe.map(r => r.ev);
    const evIn = scale.inputs?.ev90 || '', hh = evIn.includes('%');
    const evStat = v => (hh ? v.filter(x => x >= 95).length / v.length : /^MaxExitVel/i.test(evIn) ? Math.max(...v) : /^ExitVel$/i.test(evIn) ? mean(v) : quantile(v, 0.9));
    out[g] = {
      n: a.filter(r => r.r).length,
      contact: sw.length ? 1 - sw.filter(r => r.wh).length / sw.length : null,
      chase: oz.length ? oz.filter(r => r.sw).length / oz.length : null,
      barrel: bbe.length ? bbe.filter(r => isBarrel(r.ev, r.la)).length / bbe.length : null,
      ev90: evs.length ? evStat(evs) : null,
      xwobacon: bbe.filter(r => r.xw != null).length ? mean(bbe.filter(r => r.xw != null).map(r => r.xw)) : null,
    };
  }
  return out;
}
function hpScore(mg, scale, calib) {
  const gs = {};
  for (const g of scale.groups) {
    const per = scale.per[g] || {}, m = mg[g] || {}; let zs = 0, ws = 0;
    for (const d of scale.metrics) {
      const p = per[d.k]; if (!p) continue;
      let x = m[d.k]; const n = m.n || 0;
      if (x == null) x = p.mean; else if (calib?.[g]?.[d.k] != null) x += calib[g][d.k];
      const xr = (n * x + d.kreg * p.mean) / (n + d.kreg);
      zs += p.w * d.dir * (xr - p.mean) / p.sd; ws += p.w;
    }
    if (ws) gs[g] = 100 + 10 * (zs / ws - scale.comp[g].mean) / scale.comp[g].sd;
  }
  const v = Object.values(gs); if (!v.length) return null;
  return { hit: 100 + 10 * (mean(v) - scale.final.mean) / scale.final.sd, groups: gs };
}
// average gap between TruMedia's inputs and TrackMan's for BC hitters in both (spring of that year)
function hpCalibration(scale, spring) {
  if (!spring || !scale.bc) return null;
  const byName = new Map();
  for (const [i] of spring.byH) if (S.players[i].bc) byName.set(normName(S.players[i].n), i);
  const acc = {};
  for (const [tmName, groups] of Object.entries(scale.bc)) {
    const i = byName.get(normName(tmName)); if (i == null) continue;
    const mine = hpInputs(spring.byH.get(i), scale);
    for (const g of scale.groups) for (const d of scale.metrics) {
      const a = groups[g]?.[d.k], b = mine[g]?.[d.k], n = Math.min(groups[g]?.n || 0, mine[g]?.n || 0);
      if (a == null || b == null || !n) continue;
      const o = ((acc[g] = acc[g] || {})[d.k] = acc[g][d.k] || { s: 0, n: 0, p: 0 }); o.s += n * (a - b); o.n += n; o.p++;
    }
  }
  const out = {};
  for (const g in acc) for (const k in acc[g]) if (acc[g][k].p >= 5) (out[g] = out[g] || {})[k] = acc[g][k].s / acc[g][k].n;
  return Object.keys(out).length ? out : null;
}
async function prepHitPlus(se) {
  se.hitPlus = new Map();
  try {
    const year = ncaaYearFor(se.id); if (year == null) return;
    const j = await loadNcaa(year), scale = j?.hitplus; if (!scale) return;
    const springId = `${year}-spring`;
    const spring = S.meta.seasons.some(s => s.id === springId) ? (se.id === springId ? se : await loadSeason(springId)) : null;
    const calib = hpCalibration(scale, spring);
    const tm = new Map();
    if (se.id === springId && j.hitting) for (const o of j.hitting.list) if (/boston college/i.test(o.team || '') && o['Hit+'] != null) tm.set(normName(o.name), o);
    for (const [i, rows] of se.byH) {
      const p = S.players[i]; if (!p.bc) continue;
      const sc = hpScore(hpInputs(rows, scale), scale, calib); if (!sc) continue;
      const t = tm.get(normName(p.n));
      const tg = t ? Object.fromEntries(scale.groups.filter(g => t[`Hit+ ${g}`] != null).map(g => [g, t[`Hit+ ${g}`]])) : null;
      se.hitPlus.set(i, t ? { hit: t['Hit+'], groups: tg, src: 'TruMedia', year } : { hit: sc.hit, groups: sc.groups, src: 'TrackMan', year, calibrated: !!calib });
    }
  } catch (err) { console.warn('Hit+ unavailable', err); }
}
const hpVal = (se, i) => se.hitPlus?.get(i)?.hit ?? null;

// Swing/Take grades (Baseball Savant run values): run value per 100 pitches on the 20-80 scale.
//   season: against every hitter in the season's data (BC and opponents) with 40+ pitches
//   game:   against every hitter-game in the season's data with 8+ pitches
const rvUsable = r => r.rv != null && r.az != null && !r.nt && r.c !== 'IB' && r.c !== 'U';
function rvPool(se, perGame) {
  const key = perGame ? 'rvGamePool' : 'rvPool';
  if (se.cache[key]) return se.cache[key];
  const acc = new Map();
  for (const r of se.rows) {
    if (!rvUsable(r)) continue;
    const k = perGame ? r.h + '|' + r.g : r.h; const o = acc.get(k) || { n: 0, s: 0 }; o.n++; o.s += r.rv; acc.set(k, o);
  }
  const v = [...acc.values()].filter(o => o.n >= (perGame ? 8 : 40)).map(o => 100 * o.s / o.n);
  const m = mean(v), sd = v.length > 2 ? Math.sqrt(mean(v.map(x => (x - m) ** 2))) : null;
  return (se.cache[key] = { mean: m, sd, n: v.length, min: perGame ? 8 : 40 });
}
function rvGrade(se, rows, perGame) {
  const g = rows.filter(rvUsable), dp = rvPool(se, perGame);
  if (g.length < dp.min || !dp.sd) return null;
  return Math.max(20, Math.min(80, 50 + 10 * (100 * sum(g.map(r => r.rv)) / g.length - dp.mean) / dp.sd));
}
const AZ_NAME = ['Heart', 'Shadow', 'Chase', 'Waste'];
// One pitch, Savant style: its region, swing or take, and the run value of what happened
function pitchRV(r) {
  if (!rvUsable(r)) return null;
  const act = r.sw ? 'Swing' : 'Take';
  const cls = r.rv >= 0.005 ? 'pos' : r.rv <= -0.005 ? 'neg' : 'zero';
  return { act, zone: AZ_NAME[r.az], k: r.az, rv: r.rv, cls };
}
// Good or bad decision (game pages). Judged on the decision, not the outcome: for the pitch's
// region and count, did the hitter pick the option (swing or take) that is worth more runs on
// average across this season's data? A good swing that lines out is still a good decision.
function decisionTable(se) {
  if (se.cache.decTab) return se.cache.decTab;
  const t = new Map(), add = (k, v) => { const o = t.get(k) || { n: 0, s: 0 }; o.n++; o.s += v; t.set(k, o); };
  for (const r of se.rows) {
    if (!rvUsable(r)) continue;
    const a = r.sw ? 'S' : 'T';
    add(`${r.az}|${r.b}-${r.s}|${a}`, r.rv); add(`${r.az}|${r.s === 2 ? '2' : 'x'}|${a}`, r.rv); add(`${r.az}||${a}`, r.rv);
  }
  return (se.cache.decTab = t);
}
// The hitter's damage map: xwOBA on contact in each of the 13 zones (the "Damage" heat map on
// his player page), regressed toward his own overall level so a zone with 2 balls in play
// doesn't swing the call. League map = every hitter of the same side this season.
const isDmgBall = r => r.c === 'X' && r.xw != null && r.px != null && !r.nt && r.ht !== 'BU';
const DMG_K = 8, DMG_RUNS = 0.35;   // regression in balls in play; runs per swing for 1.000 of xwOBAcon
function damageMaps(se) {
  if (se.cache.dmg) return se.cache.dmg;
  const lg = {}, hit = new Map(), add = (o, k, v) => { const c = o[k] || (o[k] = { n: 0, s: 0 }); c.n++; c.s += v; };
  for (const r of se.rows) {
    if (!isDmgBall(r)) continue;
    const z = zone13(-r.px, r.pz), sd = r.bs || 'R';
    add(lg, sd + z, r.xw); add(lg, sd, r.xw);
    const h = hit.get(r.h) || {}; add(h, z, r.xw); add(h, 'all', r.xw); add(h, 'lg', 0); hit.set(r.h, h);
  }
  return (se.cache.dmg = { lg, hit });
}
function hitterDamage(se, r) {
  const m = damageMaps(se), z = zone13(-r.px, r.pz); if (z == null) return null;
  const sd = r.bs || 'R', L = m.lg[sd + z], LA = m.lg[sd], H = m.hit.get(r.h) || {};
  if (!L || !LA || L.n < 10) return null;
  const lgZ = L.s / L.n, lgAll = LA.s / LA.n;
  const hisAll = H.all ? (H.all.s + DMG_K * lgAll) / (H.all.n + DMG_K) : lgAll;   // his overall, regressed to league
  const prior = lgZ + (hisAll - lgAll), hz = H[z];
  const his = hz ? (hz.s + DMG_K * prior) / (hz.n + DMG_K) : prior;
  return { z, his, lg: lgZ, n: hz ? hz.n : 0 };
}
function pitchDecision(se, r) {
  if (!rvUsable(r)) return null;
  const t = decisionTable(se), mine = r.sw ? 'S' : 'T', other = r.sw ? 'T' : 'S';
  let diff = null;
  for (const c of [`${r.b}-${r.s}`, r.s === 2 ? '2' : 'x', '']) {   // exact count, then 2-strike/not, then zone only
    const a = t.get(`${r.az}|${c}|${mine}`), b = t.get(`${r.az}|${c}|${other}`);
    if (a && b && a.n >= 15 && b.n >= 15) { diff = a.s / a.n - b.s / b.n; break; }
  }
  if (diff == null) diff = r.az <= 1 ? (r.sw ? 1 : -1) : (r.sw ? -1 : 1);   // no data: swing at strikes, take balls
  const base = diff;
  // cross-reference his damage map: a hot zone makes swinging worth more, a cold zone less
  const dm = hitterDamage(se, r);
  if (dm) diff += (r.sw ? 1 : -1) * DMG_RUNS * (dm.his - dm.lg);
  return { good: diff >= -0.003, zone: AZ_NAME[r.az], k: r.az, act: r.sw ? 'Swing' : 'Take', dm, flipped: (base >= -0.003) !== (diff >= -0.003) };
}
function decisionStats(se, rows) {
  const d = rows.map(r => pitchDecision(se, r)).filter(Boolean);
  const good = d.filter(x => x.good).length;
  return { n: d.length, good, pct: d.length ? good / d.length : null,
    badSw: d.filter(x => !x.good && x.act === 'Swing').length, badTk: d.filter(x => !x.good && x.act === 'Take').length };
}
const decTxt = ds => ds.n ? `${ds.good}/${ds.n}` : '—';
function decCell(se, r, role = 'hit') {
  const d = pitchDecision(se, r); if (!d) return '<td class="l muted">—</td>';
  const chip = `<span class="az-chip az-chip-sm" style="background:${AZ[d.k].soft}">${d.zone} · ${d.act}</span>`;
  if (role === 'pit') return `<td class="l">${chip}</td>`;
  const heat = d.dm ? (d.dm.his - d.dm.lg >= 0.04 ? 'hot' : d.dm.his - d.dm.lg <= -0.04 ? 'cold' : 'average') : null;
  const dmTxt = d.dm ? `<br>His damage there: ${F.avg(d.dm.his)} xwOBA on contact (${heat} zone; league ${F.avg(d.dm.lg)}${d.dm.n ? `, ${d.dm.n} ball${d.dm.n === 1 ? '' : 's'} in play` : ', no balls in play yet'})` : '';
  const why = (d.good ? `<b>Good ${d.act.toLowerCase()}</b>: ${d.act === 'Swing' ? 'swinging' : 'taking'} is the better choice`
    : `<b>Bad ${d.act.toLowerCase()}</b>: ${d.act === 'Swing' ? 'taking' : 'swinging'} was the better choice`) + ` on a ${d.zone.toLowerCase()} pitch in a ${r.b}-${r.s} count${dmTxt}`
    + (d.flipped ? `<br><i>His damage map changed this call</i>` : '');
  return `<td class="l">${chip} <span class="dec-v ${d.good ? 'good' : 'bad'}" data-tip="${esc(why)}">${d.good ? '✓ Good' : '✗ Bad'}</span></td>`;
}

function seasonHitters(se) {
  if (se.cache.hit) return se.cache.hit;
  const out = [];
  for (const [i, rows] of se.byH) {
    const p = S.players[i]; if (!p.bc) continue;
    const st = stats(rows); if (!st.PA) continue;
    out.push({ i, name: p.n, ...st, bats: p.b, hitPlus: hpVal(se, i) });
  }
  const q = MIN_PA;   // qualifying minimum for rate stats, leaderboards and percentiles
  out.forEach(o => o.q = o.PA >= q);
  out.forEach(o => { o.rvGrade = rvGrade(se, se.byH.get(o.i) || [], false); });
  return (se.cache.hit = { rows: out, q });
}
function seasonPitchers(se) {
  if (se.cache.pit) return se.cache.pit;
  const out = [];
  for (const [i, rows] of se.byP) {
    const p = S.players[i]; if (!p.bc) continue;
    const st = stats(rows);
    out.push({ i, name: p.n, ...st, ...pitchShape(rows), throws: p.th });
  }
  const q = MIN_PA;   // qualifying minimum for rate stats, leaderboards and percentiles
  out.forEach(o => o.q = o.PA >= q);
  return (se.cache.pit = { rows: out, q });
}
function percentile(v, pool, dir) {
  const vals = pool.filter(x => x != null && isFinite(x));
  if (v == null || !vals.length) return null;
  let below = 0, eq = 0;
  for (const x of vals) { if (dir > 0 ? x < v : x > v) below++; else if (x === v) eq++; }
  return Math.max(1, Math.min(100, Math.round(100 * (below + 0.5 * eq) / vals.length)));
}

/* ---------- small UI helpers ---------- */
function pctColor(p) {
  const css = getComputedStyle(document.documentElement);
  const parse = h => { h = h.trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lo = parse(css.getPropertyValue('--pct-lo')), mid = parse(css.getPropertyValue('--pct-mid')), hi = parse(css.getPropertyValue('--pct-hi'));
  const t = p / 100, [a, b, u] = t < 0.5 ? [lo, mid, t / 0.5] : [mid, hi, (t - 0.5) / 0.5];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * u));
  return `rgb(${c.join(',')})`;
}
function seasonSelect(id, onchange, list) {
  const opts = (list || S.meta.seasons.map(s => s.id)).map(sid => `<option value="${esc(sid)}" ${sid === S.season ? 'selected' : ''}>${esc(seasonLabel(sid))}</option>`).join('');
  setTimeout(() => { const el = document.getElementById(id); if (el) el.onchange = () => onchange(el.value); });
  return `<select id="${id}" aria-label="Season">${opts}</select>`;
}
function setSeason(id) { S.season = id; ls.set('season', id); }
function segmented(id, options, value, onchange) {
  setTimeout(() => {
    const el = document.getElementById(id); if (!el) return;
    el.onclick = e => { const b = e.target.closest('button'); if (b) onchange(b.dataset.v); };
  });
  return `<div class="seg" id="${id}" role="group">${options.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? 'on' : ''}" aria-pressed="${v === value}">${esc(l)}</button>`).join('')}</div>`;
}
function resBadge(r, c) {
  if (!r) return c ? `<span class="muted">${esc(CALL_NAME[c] || c)}</span>` : '';
  const cls = r === 'HR' ? 'res hr' : ['1B', '2B', '3B'].includes(r) ? 'res hit' : 'res';
  return `<span class="${cls}">${esc(RES_NAME[r] || r)}</span>`;
}
const ptDot = k => `<span class="ptdot" style="background:${PT[k]?.c || '#999'}"></span>`;

/* Sortable table. cols: {k,label,fmt,tip,l,get,asc,link} */
function table(id, cols, data, opts = {}) {
  const st = S.sort[id] || (S.sort[id] = { k: opts.sort || null, asc: !!opts.asc });
  const render = () => {
    const col = cols.find(c => c.k === st.k);
    let rows = [...data];
    if (col && !opts.nosort) {
      const g = col.get || (r => r[col.k]);
      rows.sort((a, b) => {
        const x = g(a), y = g(b);
        if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
        const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return st.asc ? cmp : -cmp;
      });
    }
    const head = cols.map(c => `<th data-k="${c.k}" class="${c.l ? 'l ' : ''}${opts.nosort ? 'nosort ' : ''}${st.k === c.k ? 'sorted ' + (st.asc ? 'asc' : '') : ''}" ${c.tip ? `title="${esc(c.tip)}"` : ''} scope="col">${esc(c.label)}</th>`).join('');
    if (opts.limit) rows = rows.slice(0, opts.limit);
    const body = rows.map(r => `<tr class="${r._cls || ''}">${cols.map(c => {
      const v = c.get ? c.get(r) : r[c.k];
      const html = c.html ? c.html(r) : (c.fmt ? c.fmt(v) : F.str(v));
      return `<td class="${c.l ? 'l' : ''}${r.q === false && c.k === 'name' ? ' nq' : ''}">${html}</td>`;
    }).join('')}</tr>`).join('');
    const totals = opts.totals || (opts.total ? [opts.total] : []);
    const foot = totals.map(tt => `<tr class="tot">${cols.map(c => { const v = c.get ? c.get(tt) : tt[c.k]; return `<td class="${c.l ? 'l' : ''}">${c.k === cols[0].k ? esc(tt._label || 'Total') : (c.totHtml ? c.totHtml(tt) : c.html && tt._html ? c.html(tt) : c.fmt ? c.fmt(v) : F.str(v))}</td>`; }).join('')}</tr>`).join('');
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="l" colspan="${cols.length}"><span class="empty">No rows match.</span></td></tr>`}${foot}</tbody></table>`;
  };
  setTimeout(() => {
    const el = document.getElementById(id); if (!el) return;
    render();
    if (!opts.nosort) el.onclick = e => {
      const th = e.target.closest('th'); if (!th) return;
      const k = th.dataset.k, c = cols.find(x => x.k === k);
      if (st.k === k) st.asc = !st.asc; else { st.k = k; st.asc = c?.asc ?? (c?.l ? true : false); }
      render();
    };
  });
  return `<div class="tbl-wrap" id="${id}"></div>`;
}

/* ---------- column sets ---------- */
const nameCol = { k: 'name', label: 'Player', l: true, html: r => plink(r.i), get: r => r.name };
const C = {
  G: { k: 'G', label: 'G', fmt: F.int, tip: 'Games with tracked pitches' },
  PA: { k: 'PA', label: 'PA', fmt: F.int }, AB: { k: 'AB', label: 'AB', fmt: F.int }, H: { k: 'H', label: 'H', fmt: F.int },
  '2B': { k: '2B', label: '2B', fmt: F.int }, '3B': { k: '3B', label: '3B', fmt: F.int }, HR: { k: 'HR', label: 'HR', fmt: F.int },
  BB: { k: 'BB', label: 'BB', fmt: F.int }, K: { k: 'K', label: 'SO', fmt: F.int }, HBP: { k: 'HBP', label: 'HBP', fmt: F.int },
  avg: { k: 'avg', label: 'AVG', fmt: F.avg }, obp: { k: 'obp', label: 'OBP', fmt: F.avg }, slg: { k: 'slg', label: 'SLG', fmt: F.avg },
  ops: { k: 'ops', label: 'OPS', fmt: F.avg }, iso: { k: 'iso', label: 'ISO', fmt: F.avg }, babip: { k: 'babip', label: 'BABIP', fmt: F.avg },
  hitPlus: { k: 'hitPlus', label: 'Hit+', fmt: v => (v == null ? '—' : Math.round(v)), tip: 'Baseball America\'s Hit+: contact, EV90, chase, barrel and xwOBA on contact by pitch type, scaled to all D1 hitters in the TruMedia pull. 100 = D1 average; every 10 points = 1 standard deviation.' },
  woba: { k: 'woba', label: 'wOBA', fmt: F.avg }, xwoba: { k: 'xwoba', label: 'xwOBA', fmt: F.avg, tip: 'Expected wOBA from exit velocity and launch angle' },
  xba: { k: 'xba', label: 'xBA', fmt: F.avg }, xslg: { k: 'xslg', label: 'xSLG', fmt: F.avg },
  wobaDiff: { k: 'wobaDiff', label: 'wOBA−xwOBA', fmt: v => v == null ? '—' : (v >= 0 ? '+' : '−') + F.avg(Math.abs(v)) },
  kPct: { k: 'kPct', label: 'K%', fmt: F.pct }, bbPct: { k: 'bbPct', label: 'BB%', fmt: F.pct }, kbb: { k: 'kbb', label: 'K−BB%', fmt: F.pct },
  bbe: { k: 'bbe', label: 'BBE', fmt: F.int, tip: 'Tracked batted-ball events (no bunts)' },
  avgEV: { k: 'avgEV', label: 'Avg EV', fmt: F.f1 }, maxEV: { k: 'maxEV', label: 'Max EV', fmt: F.f1 }, ev90: { k: 'ev90', label: 'EV90', fmt: F.f1, tip: '90th-percentile exit velocity' },
  avgLA: { k: 'avgLA', label: 'LA', fmt: F.f1, tip: 'Average launch angle' }, ssPct: { k: 'ssPct', label: 'Sweet Spot%', fmt: F.pct, tip: 'Launch angle 8°–32°' },
  brlPct: { k: 'brlPct', label: 'Barrel%', fmt: F.pct }, brl: { k: 'brl', label: 'Barrels', fmt: F.int }, hhPct: { k: 'hhPct', label: 'Hard Hit%', fmt: F.pct, tip: 'Exit velocity 95+ mph' },
  gbPct: { k: 'gbPct', label: 'GB%', fmt: F.pct }, ldPct: { k: 'ldPct', label: 'LD%', fmt: F.pct }, fbPct: { k: 'fbPct', label: 'FB%', fmt: F.pct }, puPct: { k: 'puPct', label: 'PU%', fmt: F.pct },
  pullPct: { k: 'pullPct', label: 'Pull%', fmt: F.pct }, centPct: { k: 'centPct', label: 'Straight%', fmt: F.pct }, oppoPct: { k: 'oppoPct', label: 'Oppo%', fmt: F.pct },
  pitches: { k: 'pitches', label: 'Pitches', fmt: F.int },
  swing: { k: 'swing', label: 'Swing%', fmt: F.pct }, zone: { k: 'zone', label: 'Zone%', fmt: F.pct }, zswing: { k: 'zswing', label: 'Z-Swing%', fmt: F.pct },
  chase: { k: 'chase', label: 'Chase%', fmt: F.pct, tip: 'Swings at pitches outside the zone' }, whiff: { k: 'whiff', label: 'Whiff%', fmt: F.pct, tip: 'Misses per swing' },
  zcontact: { k: 'zcontact', label: 'Z-Contact%', fmt: F.pct }, contact: { k: 'contact', label: 'Contact%', fmt: F.pct },
  rv: { k: 'rv', label: 'Run Value', fmt: v => fmtRV(v), tip: 'Runs added by the hitter across every pitch seen, from the count-and-base-out run value matrix (+ = good for the hitter)' },
  rvP: { k: 'rvP', label: 'Run Value', get: r => (r.rv == null ? null : -r.rv), fmt: v => fmtRV(v), tip: 'Runs saved by the pitcher across every pitch thrown, from the count-and-base-out run value matrix (+ = good for the pitcher)' },
  rvSwing: { k: 'rvSwing', label: 'Swing RV', fmt: v => fmtRV(v), tip: 'Swing runs: run value of every pitch he swung at (Baseball Savant Swing/Take)' },
  rvTake: { k: 'rvTake', label: 'Take RV', fmt: v => fmtRV(v), tip: 'Take runs: run value of every pitch he took (Baseball Savant Swing/Take)' },
  rv100: { k: 'rv100', label: 'RV/100', fmt: v => fmtRV(v, 2), tip: 'Swing/take run value per 100 pitches seen' },
  rvGrade: { k: 'rvGrade', label: 'Swing/Take', fmt: v => (v == null ? '—' : Math.round(v)), tip: 'Swing/Take grade on the 20-80 scale from run value per 100 pitches: 50 = average hitter in this season\'s data, 60 = one SD better' },
  fpSwing: { k: 'fpSwing', label: '1st-Pitch Swing%', fmt: F.pct }, fpStrike: { k: 'fpStrike', label: 'F-Strike%', fmt: F.pct }, csw: { k: 'csw', label: 'CSW%', fmt: F.pct, tip: 'Called strikes + whiffs per pitch' },
  batSpd: { k: 'batSpd', label: 'Bat Speed', fmt: F.f1, tip: 'Average of tracked swings between 50 and 95 mph' }, maxBat: { k: 'maxBat', label: 'Max Bat Spd', fmt: F.f1 },
  ip: { k: 'outs', label: 'IP', fmt: F.ip, tip: 'From TrackMan outs; approximate' }, runs: { k: 'runs', label: 'R', fmt: F.int, tip: 'Runs scored on plays (not earned runs)' },
  fbVelo: { k: 'fbVelo', label: 'FB Velo', fmt: F.f1, tip: 'Average four-seam + sinker velocity' }, fbMax: { k: 'fbMax', label: 'FB Max', fmt: F.f1 },
  fbSpin: { k: 'fbSpin', label: 'FB Spin', fmt: F.int }, fbIVB: { k: 'fbIVB', label: 'FB IVB', fmt: F.f1 }, ext: { k: 'ext', label: 'Ext.', fmt: F.f1 },
  maxDist: { k: 'maxDist', label: 'Max Dist', fmt: F.int },
  k2win: { k: 'k2win', label: '2K Win%', fmt: F.pct, tip: 'Plate appearances that reached two strikes and did not end in a strikeout' },
  swingsTracked: { k: 'swingsTracked', label: 'Swings', fmt: F.int, tip: 'Swings with bat tracking (50–95 mph)' },
  batTop: { k: 'batTop', label: 'Top-10% Bat Spd', fmt: F.f1, tip: 'Average of the fastest 10% of tracked swings' },
  fastPct: { k: 'fastPct', label: 'Fast-Swing%', fmt: F.pct, tip: 'Share of tracked swings at 75+ mph' },
  attackAngle: { k: 'attackAngle', label: 'Attack Angle', fmt: F.f1, tip: 'Average vertical attack angle at contact (°)' },
  idealAA: { k: 'idealAA', label: 'Ideal AA%', fmt: F.pct, tip: 'Swings with an attack angle of 5°–20°' },
  attackDir: { k: 'attackDir', label: 'Attack Dir.', fmt: v => v == null ? '—' : `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'pull' : 'oppo'}`, tip: 'Average horizontal attack angle, toward the pull or opposite field' },
  sqPct: { k: 'sqPct', label: 'Squared-Up%', fmt: F.pct, tip: 'Contact reaching 80%+ of the max exit velo possible from the bat and pitch speed' },
  blastPct: { k: 'blastPct', label: 'Blast%', fmt: F.pct, tip: 'Contact where squared-up % × 100 + bat speed ≥ 164' },
};
const cols = (...ks) => ks.map(k => C[k]);
function fmtRV(v, nd = 1) { if (v == null || !isFinite(v)) return '—'; const x = +v.toFixed(nd); return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(nd); }
const HIT_VIEWS = {
  standard: ['Standard', cols('G', 'PA', 'AB', 'H', '2B', '3B', 'HR', 'BB', 'K', 'HBP', 'avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'woba', 'hitPlus')],
  statcast: ['Batted Ball', cols('PA', 'hitPlus', 'bbe', 'avgEV', 'ev90', 'maxEV', 'avgLA', 'ssPct', 'brl', 'brlPct', 'hhPct', 'xba', 'xslg', 'woba', 'xwoba', 'wobaDiff', 'batSpd', 'maxBat')],
  discipline: ['Plate Discipline', cols('PA', 'pitches', 'kPct', 'bbPct', 'k2win', 'swing', 'zswing', 'chase', 'whiff', 'zcontact', 'contact', 'fpSwing', 'rv', 'rvSwing', 'rvTake', 'rv100', 'rvGrade')],
  profile: ['Batted-Ball Profile', cols('bbe', 'gbPct', 'ldPct', 'fbPct', 'puPct', 'pullPct', 'centPct', 'oppoPct', 'maxDist')],
  bat: ['Bat Tracking', cols('swingsTracked', 'batSpd', 'batTop', 'maxBat', 'fastPct', 'attackAngle', 'idealAA', 'attackDir', 'sqPct', 'blastPct', 'avgEV', 'hhPct')],
};
const PIT_VIEWS = {
  standard: ['Standard', cols('G', 'ip', 'PA', 'pitches', 'H', 'HR', 'BB', 'K', 'HBP', 'runs', 'avg', 'obp', 'slg', 'woba', 'kPct', 'bbPct', 'kbb')],
  statcast: ['Contact Allowed', cols('PA', 'bbe', 'avgEV', 'maxEV', 'avgLA', 'brlPct', 'hhPct', 'gbPct', 'xba', 'xslg', 'woba', 'xwoba', 'wobaDiff')],
  stuff: ['Stuff & Command', cols('pitches', 'fbVelo', 'fbMax', 'fbSpin', 'fbIVB', 'ext', 'zone', 'chase', 'whiff', 'csw', 'fpStrike', 'kPct', 'bbPct', 'rvP')],
};
const HIT_PCT = [
  ['Hit+', 'hitPlus', 1, v => Math.round(v)], ['xwOBA', 'xwoba', 1, F.avg], ['xBA', 'xba', 1, F.avg], ['xSLG', 'xslg', 1, F.avg], ['Avg Exit Velo', 'avgEV', 1, F.f1], ['Max Exit Velo', 'maxEV', 1, F.f1],
  ['Barrel %', 'brlPct', 1, F.pct], ['Hard-Hit %', 'hhPct', 1, F.pct], ['Sweet-Spot %', 'ssPct', 1, F.pct], ['Bat Speed', 'batSpd', 1, F.f1],
  ['Chase %', 'chase', -1, F.pct], ['Whiff %', 'whiff', -1, F.pct], ['K %', 'kPct', -1, F.pct], ['BB %', 'bbPct', 1, F.pct],
  ['Swing/Take RV', 'rv100', 1, v => fmtRV(v, 2)],
];
const PIT_PCT = [
  ['xwOBA', 'xwoba', -1, F.avg], ['xBA', 'xba', -1, F.avg], ['Fastball Velo', 'fbVelo', 1, F.f1], ['Avg Exit Velo', 'avgEV', -1, F.f1],
  ['Chase %', 'chase', 1, F.pct], ['Whiff %', 'whiff', 1, F.pct], ['K %', 'kPct', 1, F.pct], ['BB %', 'bbPct', -1, F.pct],
  ['Barrel %', 'brlPct', -1, F.pct], ['Hard-Hit %', 'hhPct', -1, F.pct], ['GB %', 'gbPct', 1, F.pct], ['Extension', 'ext', 1, F.f1], ['Fastball Spin', 'fbSpin', 1, F.int],
];

function pctBars(defs, me, pool, alt) {
  const rows = defs.map(([lab, k, dir, fmt]) => {
    const v = me[k];
    const altVals = alt && alt.values(k);
    const useAlt = altVals && altVals.length;
    const p = percentile(v, useAlt ? altVals : pool.map(o => o[k]), dir);
    const tag = alt && !useAlt ? ' <span class="muted small" title="Not available from TruMedia, ranked against BC">BC</span>' : '';
    if (p == null) return `<div class="pct-row na"><span class="lab">${lab}${tag}</span><div class="pct-track"></div><span class="val">—</span></div>`;
    const col = pctColor(p);
    return `<div class="pct-row${me.q ? '' : ' nq'}" title="${esc(lab)}: ${esc(fmt(v))} — ${p}th percentile among ${useAlt ? 'qualified Power 4 players' : 'qualified BC players'}">
      <span class="lab">${lab}${tag}</span>
      <div class="pct-track"><span class="pct-tick" style="left:50%"></span><span class="pct-fill" style="width:${p}%;background:${col}"></span><span class="pct-bub" style="left:${p}%;background:${col}">${p}</span></div>
      <span class="val">${fmt(v)}</span></div>`;
  }).join('');
  return `<div class="pct-scale"><div></div><div><span>Poor</span><span>Average</span><span>Great</span></div><div></div></div><div class="pct-list">${rows}</div>`;
}

/* ---------- SVG charts ---------- */
function svg(w, h, inner, label) { return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${inner}</svg>`; }
const RES_COLOR = { '1B': '#2f8f5b', '2B': '#2e5fb4', '3B': '#8a4fc9', HR: '#d1293d', OUT: '#9a9496' };
function resGroup(r) { return ['1B', '2B', '3B', 'HR'].includes(r) ? r : 'OUT'; }

function sprayChart(rows, opts = {}) {
  const W = 420, H = 380, hx = 210, hy = 355, s = 0.78;
  const pt = (d, a) => [hx + s * d * Math.sin(a * Math.PI / 180), hy - s * d * Math.cos(a * Math.PI / 180)];
  const fence = []; for (let a = -45; a <= 45; a += 3) fence.push(pt(330 + 70 * Math.cos(a * 2 * Math.PI / 180), a));
  const dirt = []; for (let a = -45; a <= 45; a += 5) dirt.push(pt(150, a));
  let g = `<path class="field" d="M${hx},${hy} L${fence.map(p => p.map(n => n.toFixed(1)).join(',')).join(' L')} Z"/>`;
  g += `<path class="dirt" d="M${hx},${hy} L${dirt.map(p => p.map(n => n.toFixed(1)).join(',')).join(' L')} Z"/>`;
  const b1 = pt(90, 45), b2 = pt(127.3, 0), b3 = pt(90, -45);
  g += `<path class="ax" d="M${hx},${hy} L${b1.join(',')} L${b2.join(',')} L${b3.join(',')} Z"/>`;
  const bb = rows.filter(r => r.c === 'X' && r.dir != null && r.dist != null && r.ht !== 'BU');
  const mode = opts.color || 'result', many = bb.length > 250;
  const HT_COLOR = { GB: '#b07d1c', LD: '#d1293d', FB: '#2e5fb4', PU: '#8a4fc9', '': '#9a9496' };
  const evColor = ev => ev == null ? '#9a9496' : pctColor(Math.max(0, Math.min(100, (ev - 60) / 50 * 100)));
  const ordered = mode === 'result' ? [...bb].sort((a, b) => (resGroup(a.r) === 'OUT') - (resGroup(b.r) === 'OUT')).reverse() : mode === 'ev' ? [...bb].sort((a, b) => (a.ev ?? 0) - (b.ev ?? 0)) : bb;
  g += ordered.map(r => {
    const res = resGroup(r.r);
    // TrackMan's distance on grounders is where tracking stopped, so draw them at a set depth
    const grounder = r.ht === 'GB' || (r.ht === '' && r.la != null && r.la < 10);
    const evT = Math.max(0, Math.min(1, ((r.ev ?? 80) - 50) / 60));
    const dist = grounder ? Math.max(r.dist, res === 'OUT' ? 80 + evT * 75 : 145 + evT * 100) : r.dist;
    const [x, y] = pt(Math.min(dist, 460), Math.max(-50, Math.min(50, r.dir)));
    const fill = mode === 'ev' ? evColor(r.ev) : mode === 'ht' ? HT_COLOR[r.ht || ''] : RES_COLOR[res];
    const rad = (many ? 0.75 : 1) * (mode === 'result' && res === 'OUT' ? 3.2 : 4);
    const op = mode === 'result' && res === 'OUT' ? .5 : .85;
    const who = opts.showBatter ? `${esc(niceName(pname(r.h)))} · ` : '';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="${fill}" fill-opacity="${op}"><title>${who}${esc(RES_NAME[r.r] || r.r)} · ${F.f1(r.ev)} mph, ${F.f1(r.la)}°, ${F.int(r.dist)} ft · ${esc(fmtDate(r.d))} vs ${esc(niceName(pname(r.p)))}</title></circle>`;
  }).join('');
  let leg;
  if (mode === 'ev') leg = `<div class="legend"><span>Exit velo</span><span style="display:inline-flex;align-items:center;gap:6px">60<i style="width:120px;height:9px;border-radius:5px;background:linear-gradient(90deg,${evColor(60)},${evColor(85)},${evColor(110)})"></i>110+ mph</span><span>${bb.length} batted balls</span></div>`;
  else if (mode === 'ht') leg = `<div class="legend">${['GB', 'LD', 'FB', 'PU'].map(k => `<span><i style="background:${HT_COLOR[k]}"></i>${HT_NAME[k]}</span>`).join('')}<span>${bb.length} batted balls</span></div>`;
  else leg = `<div class="legend">${['1B', '2B', '3B', 'HR', 'OUT'].map(k => `<span><i style="background:${RES_COLOR[k]}"></i>${k === 'OUT' ? 'Out / other' : RES_NAME[k]}</span>`).join('')}<span>${bb.length} batted balls</span></div>`;
  return svg(W, H, g, 'Spray chart') + leg;
}

function zoneChart(rows, metric, side) {
  const W = 300, H = 330, x0 = 150, sx = 72, zy = v => 300 - (v - 0.6) * 72;
  const X = v => x0 + v * sx;
  const zs = {};
  // mirrored left/right = catcher's view
  for (const r of rows) { const z = r.px == null ? null : zone13(-r.px, r.pz); if (z == null) continue; (zs[z] = zs[z] || []).push(r); }
  const val = list => {
    if (!list || !list.length) return null;
    const st = stats(list);
    switch (metric) {
      case 'pitches': return list.length;
      case 'swing': return st.swing; case 'whiff': return st.whiff;
      case 'xwoba': return st.PA >= 2 ? st.xwoba : null;
      case 'ev': return st.avgEV; case 'ba': return st.AB >= 2 ? st.avg : null;
      case 'dmg': { const b = list.filter(isDmgBall); return b.length >= 2 ? mean(b.map(r => r.xw)) : null; }
    }
  };
  const fmt = { pitches: F.int, swing: F.pct, whiff: F.pct, xwoba: F.avg, ev: F.f1, ba: F.avg, dmg: F.avg }[metric];
  const vals = {}; for (const z of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14]) vals[z] = val(zs[z]);
  const nums = Object.values(vals).filter(v => v != null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const color = v => {
    if (v == null) return 'var(--surface-2)';
    const t = hi > lo ? (v - lo) / (hi - lo) : .5;
    return pctColor(Math.round((side === 'pit' && metric !== 'pitches' && metric !== 'swing' && metric !== 'whiff' ? 1 - t : t) * 100));
  };
  const txt = (x, y, v) => v == null ? '' : `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" style="fill:#fff;font-weight:700;font-size:12px;paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px">${fmt(v)}</text>`;
  const ox0 = -1.55, ox1 = 1.55, oz0 = 0.85, oz1 = 4.15, mz = (ZB + ZT) / 2;
  let g = '';
  const quad = [[11, ox0, 0, mz, oz1], [12, 0, ox1, mz, oz1], [13, ox0, 0, oz0, mz], [14, 0, ox1, oz0, mz]];
  for (const [z, a, b, c, d] of quad) {
    g += `<rect x="${X(a)}" y="${zy(d)}" width="${X(b) - X(a)}" height="${zy(c) - zy(d)}" fill="${color(vals[z])}" stroke="var(--surface)" stroke-width="2"/>`;
    const tx = (X(a) + X(b)) / 2 + (z === 11 || z === 13 ? -32 : 32), ty = (zy(c) + zy(d)) / 2 + (z <= 12 ? -34 : 34);
    g += txt(tx, ty, vals[z]);
  }
  const cw = (2 * ZW) / 3, ch = (ZT - ZB) / 3;
  for (let i = 0; i < 9; i++) {
    const r = Math.floor(i / 3), c = i % 3, xa = -ZW + c * cw, zt = ZT - r * ch;
    g += `<rect x="${X(xa)}" y="${zy(zt)}" width="${X(xa + cw) - X(xa)}" height="${zy(zt - ch) - zy(zt)}" fill="${color(vals[i + 1])}" stroke="var(--surface)" stroke-width="2"/>`;
    g += txt(X(xa + cw / 2), zy(zt - ch / 2), vals[i + 1]);
  }
  g += `<rect class="zone" x="${X(-ZW)}" y="${zy(ZT)}" width="${X(ZW) - X(-ZW)}" height="${zy(ZB) - zy(ZT)}"/>`;
  g += `<path class="plate" d="M${X(-0.71)},${zy(0.62)} h${0.71 * 2 * sx} l-6,6 l${-(0.71 * 2 * sx - 12) / 2},6 l${-(0.71 * 2 * sx - 12) / 2},-6 Z"/>`;
  return svg(W, H, g, 'Strike zone chart, catcher\'s view');
}

// TrackMan PlateLocSide is positive toward the third-base side, so plotting it as-is gives the
// pitcher's view. catcher = true mirrors it.
function locationChart(rows, active, catcher = false) {
  const W = 300, H = 330, sgn = catcher ? -1 : 1, X = v => 150 + sgn * v * 60, Y = v => 310 - v * 60;
  let g = `<rect class="zone" x="${Math.min(X(-ZW), X(ZW))}" y="${Y(ZT)}" width="${Math.abs(X(ZW) - X(-ZW))}" height="${Y(ZB) - Y(ZT)}"/>`;
  for (let i = 1; i < 3; i++) {
    g += `<line class="grid" x1="${X(-ZW + i * 2 * ZW / 3)}" x2="${X(-ZW + i * 2 * ZW / 3)}" y1="${Y(ZT)}" y2="${Y(ZB)}"/>`;
    g += `<line class="grid" y1="${Y(ZB + i * (ZT - ZB) / 3)}" y2="${Y(ZB + i * (ZT - ZB) / 3)}" x1="${X(-ZW)}" x2="${X(ZW)}"/>`;
  }
  // home plate: pitcher's view = point away from the viewer (up); catcher's view = point toward the viewer (down)
  const pl = 150 - 0.71 * 60, pw = 1.42 * 60, py = Y(0.25);
  g += catcher
    ? `<path class="plate" d="M${pl},${py} h${pw} v6 l-${pw / 2},6 l-${pw / 2},-6 Z"/>`
    : `<path class="plate" d="M${pl},${py + 12} h${pw} v-6 l-${pw / 2},-6 l-${pw / 2},6 Z"/>`;
  const pts = rows.filter(r => r.px != null && r.pz != null && active.has(r.pt));
  g += pts.map(r => `<circle cx="${X(Math.max(-2.4, Math.min(2.4, r.px))).toFixed(1)}" cy="${Y(Math.max(-0.2, Math.min(5.2, r.pz))).toFixed(1)}" r="3" fill="${PT[r.pt].c}" fill-opacity=".55"><title>${PT[r.pt].n} ${F.f1(r.v)} mph · ${esc(CALL_NAME[r.c])}${r.r ? ' · ' + esc(RES_NAME[r.r]) : ''}</title></circle>`).join('');
  return svg(W, H, g, catcher ? 'Pitch locations, catcher\'s view' : 'Pitch locations, pitcher\'s view');
}

function movementChart(rows, active) {
  const W = 360, H = 360, m = 30, R = 28;
  const X = v => m + (v + R) / (2 * R) * (W - 2 * m), Y = v => H - m - (v + R) / (2 * R) * (H - 2 * m);
  let g = '';
  for (let v = -R + 8; v <= R; v += 10) { g += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${Y(-R)}" y2="${Y(R)}"/><line class="grid" y1="${Y(v)}" y2="${Y(v)}" x1="${X(-R)}" x2="${X(R)}"/>`; }
  g += `<line class="ax" x1="${X(0)}" x2="${X(0)}" y1="${Y(-R)}" y2="${Y(R)}"/><line class="ax" y1="${Y(0)}" y2="${Y(0)}" x1="${X(-R)}" x2="${X(R)}"/>`;
  for (const v of [-20, -10, 10, 20]) { g += `<text x="${X(v)}" y="${Y(0) + 13}" text-anchor="middle">${v}</text><text x="${X(0) - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`; }
  g += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle">Horizontal break (in) · pitcher's view</text>`;
  g += `<text x="10" y="${H / 2}" text-anchor="middle" transform="rotate(-90 10 ${H / 2})">Induced vertical break (in)</text>`;
  const pts = rows.filter(r => r.hb != null && r.ivb != null && active.has(r.pt));
  g += pts.map(r => `<circle cx="${X(Math.max(-R, Math.min(R, r.hb))).toFixed(1)}" cy="${Y(Math.max(-R, Math.min(R, r.ivb))).toFixed(1)}" r="2.6" fill="${PT[r.pt].c}" fill-opacity=".45"><title>${PT[r.pt].n} ${F.f1(r.v)} mph · IVB ${F.f1(r.ivb)} · HB ${F.f1(r.hb)}</title></circle>`).join('');
  const by = {}; pts.forEach(r => (by[r.pt] = by[r.pt] || []).push(r));
  const clampR = v => Math.max(-R, Math.min(R, v));
  for (const k in by) {
    const a = by[k], hx = mean(a.map(r => r.hb)), vy = mean(a.map(r => r.ivb)), xm = xMove(a);
    if (xm.xivb != null) {
      const ex = X(clampR(xm.xhb)), ey = Y(clampR(xm.xivb));
      g += `<line x1="${ex.toFixed(1)}" y1="${ey.toFixed(1)}" x2="${X(hx).toFixed(1)}" y2="${Y(vy).toFixed(1)}" stroke="var(--surface)" stroke-width="4"/><line x1="${ex.toFixed(1)}" y1="${ey.toFixed(1)}" x2="${X(hx).toFixed(1)}" y2="${Y(vy).toFixed(1)}" stroke="${PT[k].c}" stroke-width="1.8" stroke-dasharray="3 3"/>`;
      g += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="7" fill="var(--surface)" fill-opacity=".55" stroke="var(--surface)" stroke-width="5"/>`;
      g += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="7" fill="none" stroke="${PT[k].c}" stroke-width="2.2" stroke-dasharray="3 2" data-tip="${esc(`<b>${esc(PT[k].n)}: expected</b><br>IVB ${F.f1(xm.xivb)} · HB ${F.f1(xm.xhb)}<br><span class='muted'>for this arm slot and velo</span>`)}"/>`;
    }
    g += `<circle cx="${X(hx)}" cy="${Y(vy)}" r="8" fill="${PT[k].c}" stroke="var(--surface)" stroke-width="2.5" data-tip="${esc(`<b>${esc(PT[k].n)} average</b><br>IVB ${F.f1(vy)} · HB ${F.f1(hx)}${xm.divb != null ? `<br>vs expected: IVB ${fmtD(xm.divb)} · HB ${fmtD(xm.dhb)} (arm side +)` : ''}`)}"/>`;
  }
  return svg(W, H, g, 'Pitch movement chart');
}

function releaseChart(rows, active) {
  const W = 360, H = 260, m = 30;
  const X = v => m + (v + 4) / 8 * (W - 2 * m), Y = v => H - m - (v - 2) / 6 * (H - 2 * m);
  let g = '';
  for (let v = -4; v <= 4; v += 1) g += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${Y(2)}" y2="${Y(8)}"/>${v % 2 === 0 ? `<text x="${X(v)}" y="${H - m + 14}" text-anchor="middle">${v}</text>` : ''}`;
  for (let v = 2; v <= 8; v += 1) g += `<line class="grid" y1="${Y(v)}" y2="${Y(v)}" x1="${X(-4)}" x2="${X(4)}"/><text x="${m - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  g += `<line class="ax" x1="${X(0)}" x2="${X(0)}" y1="${Y(2)}" y2="${Y(8)}"/>`;
  g += `<text x="${W / 2}" y="${H - 2}" text-anchor="middle">Release side (ft) · pitcher's view</text>`;
  const pts = rows.filter(r => r.rsd != null && r.rh != null && active.has(r.pt));
  g += pts.map(r => `<circle cx="${X(Math.max(-4, Math.min(4, r.rsd))).toFixed(1)}" cy="${Y(Math.max(2, Math.min(8, r.rh))).toFixed(1)}" r="2.4" fill="${PT[r.pt].c}" fill-opacity=".45"><title>${PT[r.pt].n} · height ${F.f2(r.rh)} ft, side ${F.f2(r.rsd)} ft, ext ${F.f2(r.ext)} ft</title></circle>`).join('');
  return svg(W, H, g, 'Release point chart');
}

function evlaChart(rows) {
  const W = 380, H = 280, m = 34;
  const X = v => m + (v + 40) / 110 * (W - m - 12), Y = v => H - m - (v - 40) / 80 * (H - m - 12);
  let g = '';
  g += `<rect class="brl" x="${X(8)}" y="${Y(120)}" width="${X(32) - X(8)}" height="${Y(95) - Y(120)}"><title>95+ mph at 8°–32° launch angle</title></rect>`;
  for (let v = -40; v <= 70; v += 10) g += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${Y(40)}" y2="${Y(120)}"/>${v % 20 === 0 ? `<text x="${X(v)}" y="${H - m + 14}" text-anchor="middle">${v}°</text>` : ''}`;
  for (let v = 40; v <= 120; v += 10) g += `<line class="grid" y1="${Y(v)}" y2="${Y(v)}" x1="${X(-40)}" x2="${X(70)}"/>${v % 20 === 0 ? `<text x="${m - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>` : ''}`;
  g += `<text x="${(W + m) / 2}" y="${H - 4}" text-anchor="middle">Launch angle</text><text x="10" y="${H / 2 - 10}" text-anchor="middle" transform="rotate(-90 10 ${H / 2 - 10})">Exit velo (mph)</text>`;
  const bb = rows.filter(r => r.c === 'X' && r.ev != null && r.la != null && r.ht !== 'BU');
  g += bb.map(r => { const res = resGroup(r.r); return `<circle cx="${X(Math.max(-40, Math.min(70, r.la))).toFixed(1)}" cy="${Y(Math.max(40, Math.min(120, r.ev))).toFixed(1)}" r="3.4" fill="${RES_COLOR[res]}" fill-opacity="${res === 'OUT' ? .5 : .9}"><title>${esc(RES_NAME[r.r] || '')} · ${F.f1(r.ev)} mph at ${F.f1(r.la)}°</title></circle>`; }).join('');
  return svg(W, H, g, 'Exit velocity vs launch angle');
}

function veloTrend(rows, games) {
  const byG = new Map();
  for (const r of rows) if (r.v != null) { const key = r.sid + ':' + r.g; if (!byG.has(key)) byG.set(key, { d: r.d, g: r.g, rows: [] }); byG.get(key).rows.push(r); }
  const gl = [...byG.values()].sort((a, b) => a.d.localeCompare(b.d) || a.g - b.g);
  if (gl.length < 2) return '<p class="empty">Velocity trends appear once a pitcher has two or more outings.</p>';
  const types = PT_ORDER.filter(k => rows.some(r => r.pt === k && r.v != null) && k !== 'UN');
  const series = types.map(k => ({ k, pts: gl.map((g, i) => { const v = g.rows.filter(r => r.pt === k).map(r => r.v); return v.length ? [i, mean(v)] : null; }).filter(Boolean) })).filter(s => s.pts.length);
  const all = series.flatMap(s => s.pts.map(p => p[1]));
  const lo = Math.floor(Math.min(...all) - 1), hi = Math.ceil(Math.max(...all) + 1);
  const W = 560, H = 230, m = 36;
  const X = i => m + (gl.length === 1 ? 0 : i / (gl.length - 1)) * (W - m - 14), Y = v => H - 28 - (v - lo) / (hi - lo) * (H - 46);
  let g = '';
  const step = Math.max(1, Math.round((hi - lo) / 5));
  for (let v = lo; v <= hi; v += step) g += `<line class="grid" x1="${m}" x2="${W - 14}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  const every = Math.max(1, Math.ceil(gl.length / 7));
  gl.forEach((x, i) => { if (i % every === 0 || i === gl.length - 1) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtDate(x.d))}</text>`; });
  for (const s of series) {
    g += `<path d="M${s.pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' L')}" fill="none" stroke="${PT[s.k].c}" stroke-width="2"/>`;
    g += s.pts.map(([i, v]) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${PT[s.k].c}"><title>${PT[s.k].n} ${F.f1(v)} mph · ${esc(fmtDate(gl[i].d))}</title></circle>`).join('');
  }
  return `<div class="chart-box" style="max-width:760px">${svg(W, H, g, 'Velocity by outing')}</div>` + `<div class="legend">${series.map(s => `<span><i style="background:${PT[s.k].c}"></i>${PT[s.k].n}</span>`).join('')}</div>`;
}

function usageByCount(rows) {
  const buckets = [
    ['First pitch', r => r.b === 0 && r.s === 0], ['Pitcher ahead', r => r.s > r.b], ['Even', r => r.s === r.b && !(r.b === 0 && r.s === 0)],
    ['Batter ahead', r => r.b > r.s], ['Two strikes', r => r.s === 2],
  ];
  const sideBlock = (lab, side) => {
    const rs = rows.filter(r => r.bs === side); if (!rs.length) return '';
    return `<div><h3 style="margin-bottom:8px">vs ${lab}</h3><div class="usage">${buckets.map(([n, f]) => {
      const a = rs.filter(f); if (!a.length) return '';
      const segs = PT_ORDER.map(k => [k, a.filter(r => r.pt === k).length / a.length]).filter(x => x[1] > 0);
      return `<div class="usage-row"><span>${n}</span><div class="usage-bar">${segs.map(([k, v]) => `<span style="width:${(v * 100).toFixed(1)}%;background:${PT[k].c}" title="${PT[k].n} ${(v * 100).toFixed(0)}%"></span>`).join('')}</div><span class="muted num">${a.length}</span></div>`;
    }).join('')}</div></div>`;
  };
  return `<div class="grid2">${sideBlock('RHH', 'R')}${sideBlock('LHH', 'L')}</div>`;
}

function ptChips(id, types, active, onchange) {
  setTimeout(() => {
    const el = document.getElementById(id); if (!el) return;
    el.onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const k = b.dataset.k; if (active.has(k)) active.delete(k); else active.add(k); onchange(); };
  });
  return `<div class="chips" id="${id}">${types.map(k => `<button type="button" class="chip ${active.has(k) ? '' : 'off'}" data-k="${k}" aria-pressed="${active.has(k)}">${ptDot(k)}${PT[k].n}</button>`).join('')}</div>`;
}

/* ---------- bat tracking charts ---------- */
function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => span / st <= n + 1);
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const lastName = n => String(n).split(',')[0];
function placeLabels(items, W, H) {
  // items: {x, y, r, text}; tries right, left, above, below; skips if every spot collides
  const boxes = [], out = [];
  const hit = (a) => boxes.some(b => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1) || a.x1 < 0 || a.x2 > W || a.y1 < 0 || a.y2 > H;
  for (const it of items) boxes.push({ x1: it.x - it.r, x2: it.x + it.r, y1: it.y - it.r, y2: it.y + it.r });
  for (const it of items) {
    const w = it.text.length * 6.2 + 2, h = 12;
    const spots = [[it.x + it.r + 3, it.y + 4, 'start'], [it.x - it.r - 3, it.y + 4, 'end'], [it.x, it.y - it.r - 4, 'middle'], [it.x, it.y + it.r + 12, 'middle']];
    for (const [lx, ly, anchor] of spots) {
      const x1 = anchor === 'start' ? lx : anchor === 'end' ? lx - w : lx - w / 2;
      const b = { x1, x2: x1 + w, y1: ly - 10, y2: ly - 10 + h };
      if (!hit(b)) { boxes.push(b); out.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" class="dlab">${esc(it.text)}</text>`); break; }
    }
  }
  return out.join('');
}
function scatterFrame(W, H, m, xs, ys, xTitle, yTitle, xFmt, yFmt) {
  let g = '';
  for (const v of ys.ticks) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${ys.f(v)}" y2="${ys.f(v)}"/><text x="${m.l - 6}" y="${ys.f(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  for (const v of xs.ticks) g += `<line class="grid" y1="${m.t}" y2="${H - m.b}" x1="${xs.f(v)}" x2="${xs.f(v)}"/><text x="${xs.f(v)}" y="${H - m.b + 15}" text-anchor="middle">${xFmt(v)}</text>`;
  g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 4}" text-anchor="middle" class="ttl">${xTitle}</text>`;
  g += `<text x="12" y="${(m.t + H - m.b) / 2}" text-anchor="middle" class="ttl" transform="rotate(-90 12 ${(m.t + H - m.b) / 2})">${yTitle}</text>`;
  return g;
}
function scale(lo, hi, a, b, n) { const ticks = niceTicks(lo, hi, n); const L = Math.min(lo, ticks[0]), Hh = Math.max(hi, ticks[ticks.length - 1]); return { ticks, lo: L, hi: Hh, f: v => a + (v - L) / (Hh - L || 1) * (b - a) }; }

function batCharts(se, data) {
  const pl = data.filter(o => o.PA >= MIN_PA && o.swingsTracked > 0 && o.batSpd != null);
  if (pl.length < 2) return `<p class="empty">Charts appear once at least two hitters with ${MIN_PA}+ PA have tracked swings this season.</p>`;
  const team = stats(se.rows.filter(r => isBC(S.players[r.h]?.t)));

  // 1. Bat speed vs squared-up %
  const sq = pl.filter(o => o.sqPct != null);
  let c1 = '';
  if (sq.length >= 2) {
    const W = 560, H = 380, m = { l: 48, r: 18, t: 18, b: 40 };
    const xv = sq.map(o => o.batSpd), yv = sq.map(o => o.sqPct);
    const xs = scale(Math.min(...xv) - 1, Math.max(...xv) + 1, m.l, W - m.r, 6);
    const ys = scale(Math.max(0, Math.min(...yv) - .05), Math.min(1, Math.max(...yv) + .05), H - m.b, m.t, 5);
    const maxSw = Math.max(...sq.map(o => o.swingsTracked));
    let g = scatterFrame(W, H, m, xs, ys, 'Average bat speed (mph)', 'Squared-up % (per contact)', v => v, v => Math.round(v * 100) + '%');
    const tx = xs.f(team.batSpd), ty = ys.f(team.sqPct);
    g += `<line class="avgline" x1="${tx}" x2="${tx}" y1="${m.t}" y2="${H - m.b}"/><line class="avgline" x1="${m.l}" x2="${W - m.r}" y1="${ty}" y2="${ty}"/>`;
    g += `<text x="${W - m.r - 4}" y="${m.t + 12}" text-anchor="end" class="qlab">Fast &amp; square</text><text x="${m.l + 4}" y="${m.t + 12}" class="qlab">Square, slower bat</text>`;
    g += `<text x="${W - m.r - 4}" y="${H - m.b - 6}" text-anchor="end" class="qlab">Fast, not square</text><text x="${m.l + 4}" y="${H - m.b - 6}" class="qlab">Slower, not square</text>`;
    const items = sq.map(o => ({ o, x: xs.f(o.batSpd), y: ys.f(o.sqPct), r: 4 + 6 * Math.sqrt(o.swingsTracked / maxSw), text: lastName(o.name) }));
    g += items.map(it => `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${it.r.toFixed(1)}" class="dot" data-tip="${esc(`<b>${esc(niceName(it.o.name))}</b><br>Bat speed ${F.f1(it.o.batSpd)} mph<br>Squared-up ${F.pct(it.o.sqPct)}%<br>Blast ${F.pct(it.o.blastPct)}%<br>${it.o.swingsTracked} tracked swings`)}"/>`).join('');
    g += placeLabels(items, W, H);
    c1 = `<div class="panel"><div class="panel-h"><h2>Bat speed vs. squared-up</h2><span class="note">Dashed lines = BC average · dot size = tracked swings</span></div>${svg(W, H, g, 'Bat speed versus squared-up rate')}</div>`;
  }

  // 2. Swing path: attack angle vs attack direction
  const sp = pl.filter(o => o.attackAngle != null && o.attackDir != null);
  let c2 = '';
  if (sp.length >= 2) {
    const W = 560, H = 380, m = { l: 48, r: 18, t: 18, b: 40 };
    const xv = sp.map(o => o.attackDir), yv = sp.map(o => o.attackAngle);
    const xr = Math.max(8, ...xv.map(Math.abs)) + 2;
    const xs = scale(-xr, xr, m.l, W - m.r, 6);
    const ys = scale(Math.min(0, ...yv) - 2, Math.max(24, ...yv) + 2, H - m.b, m.t, 6);
    let g = `<rect x="${m.l}" y="${ys.f(20)}" width="${W - m.r - m.l}" height="${ys.f(5) - ys.f(20)}" class="band"/><text x="${m.l + 6}" y="${ys.f(5) - 6}" class="qlab">Ideal attack angle 5°–20°</text>`;
    g += scatterFrame(W, H, m, xs, ys, '← Opposite field · Attack direction (°) · Pull side →', 'Attack angle (°)', v => Math.abs(v), v => v + '°');
    g += `<line class="avgline" x1="${xs.f(0)}" x2="${xs.f(0)}" y1="${m.t}" y2="${H - m.b}"/>`;
    const items = sp.map(o => ({ o, x: xs.f(o.attackDir), y: ys.f(o.attackAngle), r: 6, text: lastName(o.name) }));
    g += items.map(it => `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="${it.r}" class="dot" data-tip="${esc(`<b>${esc(niceName(it.o.name))}</b><br>Attack angle ${F.f1(it.o.attackAngle)}°<br>Ideal AA ${F.pct(it.o.idealAA)}%<br>Attack direction ${Math.abs(it.o.attackDir).toFixed(1)}° ${it.o.attackDir >= 0 ? 'pull' : 'oppo'}`)}"/>`).join('');
    g += placeLabels(items, W, H);
    c2 = `<div class="panel"><div class="panel-h"><h2>Swing path</h2><span class="note">Average attack angle and direction at contact</span></div>${svg(W, H, g, 'Attack angle versus attack direction')}</div>`;
  }

  // 3. Bat speed distribution by hitter
  const rowsP = [...pl].sort((a, b) => b.batSpd - a.batSpd);
  const swings = new Map(rowsP.map(o => [o.i, (se.byH.get(o.i) || []).filter(r => r.bat != null && r.bat >= 50 && r.bat <= 95 && r.sw).map(r => r.bat)]));
  const allSw = [...swings.values()].flat();
  const W = 1100, rowH = 26, m = { l: 150, r: 24, t: 10, b: 36 }, H = m.t + rowsP.length * rowH + m.b;
  const xs = scale(Math.floor(Math.min(...allSw)), Math.ceil(Math.max(...allSw)), m.l, W - m.r, 8);
  let g = '';
  for (const v of xs.ticks) g += `<line class="grid" x1="${xs.f(v)}" x2="${xs.f(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${xs.f(v)}" y="${H - m.b + 15}" text-anchor="middle">${v}</text>`;
  g += `<line class="avgline" x1="${xs.f(team.batSpd)}" x2="${xs.f(team.batSpd)}" y1="${m.t}" y2="${H - m.b}"/>`;
  g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 4}" text-anchor="middle" class="ttl">Bat speed (mph) · dashed line = BC average ${F.f1(team.batSpd)}</text>`;
  rowsP.forEach((o, k) => {
    const cy = m.t + k * rowH + rowH / 2;
    if (k % 2 === 0) g += `<rect x="${m.l}" y="${cy - rowH / 2}" width="${W - m.r - m.l}" height="${rowH}" class="stripe"/>`;
    g += `<text x="${m.l - 10}" y="${cy + 4}" text-anchor="end" class="rowlab">${esc(niceName(o.name))}</text>`;
    const sw = swings.get(o.i) || [];
    g += sw.map((v, n) => `<circle cx="${xs.f(v).toFixed(1)}" cy="${(cy + ((n * 7) % 11) - 5).toFixed(1)}" r="2.6" class="swing"/>`).join('');
    g += `<rect x="${(xs.f(o.batTop) - 1.5).toFixed(1)}" y="${cy - 9}" width="3" height="18" rx="1.5" class="topmark" data-tip="${esc(`<b>${esc(niceName(o.name))}</b><br>Top-10% bat speed ${F.f1(o.batTop)} mph`)}"/>`;
    g += `<rect x="${(xs.f(o.batSpd) - 6).toFixed(1)}" y="${cy - 6}" width="12" height="12" rx="2" transform="rotate(45 ${xs.f(o.batSpd).toFixed(1)} ${cy})" class="avgmark" data-tip="${esc(`<b>${esc(niceName(o.name))}</b><br>Average ${F.f1(o.batSpd)} mph · max ${F.f1(o.maxBat)}<br>Fast-swing ${F.pct(o.fastPct)}% · ${o.swingsTracked} swings`)}"/>`;
  });
  const c3 = `<div class="panel"><div class="panel-h"><h2>Bat speed by hitter</h2><span class="note">Each dot is one tracked swing (50–95 mph)</span></div>
    <div style="overflow-x:auto">${svg(W, H, g, 'Bat speed distribution by hitter').replace('class="chart"', 'class="chart" style="min-width:640px"')}</div>
    <div class="legend"><span><i class="lg-swing"></i>Swing</span><span><i class="lg-avg"></i>Average</span><span><i class="lg-top"></i>Top-10% average</span></div></div>`;
  return `<section class="grid2">${c1}${c2}</section>${c3}<p class="muted small" style="margin:0">Charts include hitters with ${MIN_PA}+ PA who have tracked swings and meet the Min PA filter above.</p>`;
}

/* ---------- bat tracking: single hitter ---------- */
function playerBatCharts(i, se) {
  const sw = (se.byH.get(i) || []).filter(r => r.bat != null && r.bat >= 50 && r.bat <= 95 && r.sw);
  const me = stats(se.byH.get(i) || []);
  if (me.PA < MIN_PA || !sw.length) return '';
  const team = stats(se.rows.filter(r => isBC(S.players[r.h]?.t)));
  const nm = esc(niceName(pname(i)));

  // 1. Bat speed distribution (2 mph bins)
  const lo = 50, hi = 95, bw = 2.5, nb = Math.ceil((hi - lo) / bw);
  const bins = Array(nb).fill(0); sw.forEach(r => bins[Math.min(nb - 1, Math.floor((r.bat - lo) / bw))]++);
  const first = bins.findIndex(v => v > 0), last = nb - 1 - [...bins].reverse().findIndex(v => v > 0);
  const b0 = Math.max(0, Math.min(first, Math.floor((team.batSpd - lo) / bw)) - 1), b1 = Math.min(nb - 1, Math.max(last, Math.floor((team.batSpd - lo) / bw)) + 1);
  {
    var W1 = 420, H1 = 340, m = { l: 36, r: 12, t: 26, b: 40 };
    const xA = lo + b0 * bw, xB = lo + (b1 + 1) * bw;
    const X = v => m.l + (v - xA) / (xB - xA) * (W1 - m.l - m.r);
    const ymax = Math.max(...bins), yt = niceTicks(0, ymax, 4), ytop = Math.max(ymax, yt[yt.length - 1]);
    const Y = v => H1 - m.b - v / ytop * (H1 - m.t - m.b);
    var g1 = '';
    for (const v of yt) g1 += `<line class="grid" x1="${m.l}" x2="${W1 - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    for (let k = b0; k <= b1 + 1; k++) { const v = lo + k * bw; if (Number.isInteger(v) && v % 5 === 0) g1 += `<text x="${X(v)}" y="${H1 - m.b + 15}" text-anchor="middle">${v}</text>`; }
    for (let k = b0; k <= b1; k++) {
      if (!bins[k]) continue;
      const x0 = X(lo + k * bw) + 1, x1 = X(lo + (k + 1) * bw) - 1, y = Y(bins[k]), yb = Y(0), r = Math.min(4, (x1 - x0) / 2, yb - y);
      const fast = lo + k * bw >= 75;
      g1 += `<path class="${fast ? 'bar fast' : 'bar'}" d="M${x0},${yb} V${y + r} Q${x0},${y} ${x0 + r},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${yb} Z" data-tip="${esc(`<b>${(lo + k * bw).toFixed(1)}–${(lo + (k + 1) * bw).toFixed(1)} mph</b><br>${bins[k]} swing${bins[k] === 1 ? '' : 's'}`)}"/>`;
    }
    g1 += `<line class="avgline" x1="${X(team.batSpd)}" x2="${X(team.batSpd)}" y1="${m.t - 8}" y2="${H1 - m.b}"/><text x="${X(team.batSpd) + (me.batSpd >= team.batSpd ? -5 : 5)}" y="${m.t - 2}" text-anchor="${me.batSpd >= team.batSpd ? 'end' : 'start'}" class="qlab">BC ${F.f1(team.batSpd)}</text>`;
    g1 += `<line class="meline" x1="${X(me.batSpd)}" x2="${X(me.batSpd)}" y1="${m.t}" y2="${H1 - m.b}"/>`;
    g1 += `<rect x="${(X(me.batSpd) - 6).toFixed(1)}" y="${m.t - 6}" width="12" height="12" rx="2" transform="rotate(45 ${X(me.batSpd).toFixed(1)} ${m.t})" class="avgmark" data-tip="${esc(`<b>${nm}</b><br>Average ${F.f1(me.batSpd)} mph<br>Top-10% ${F.f1(me.batTop)} · max ${F.f1(me.maxBat)}`)}"/>`;
    g1 += `<text x="${(m.l + W1 - m.r) / 2}" y="${H1 - 4}" text-anchor="middle" class="ttl">Bat speed (mph)</text>`;
  }
  const c1 = `<div class="panel"><div class="panel-h"><h2>Bat speed</h2><span class="note">${sw.length} tracked swings · ${esc(se.label)}</span></div>${svg(W1, H1, g1, 'Bat speed distribution')}
    <div class="legend"><span><i class="lg-bar"></i>Swings</span><span><i class="lg-bar fast"></i>75+ mph (fast swing)</span><span><i class="lg-avg"></i>${nm} average</span><span><i class="lg-dash"></i>BC average</span></div></div>`;

  // 2. Swing path, one dot per swing
  const pts = sw.filter(r => r.vat != null && r.hat != null && r.bs).map(r => ({ r, x: r.bs === 'L' ? r.hat : -r.hat, y: r.vat }));
  let c2 = '';
  if (pts.length) {
    const W = 420, H = 340, m = { l: 44, r: 12, t: 18, b: 40 };
    const xr = Math.min(60, Math.max(20, ...pts.map(p => Math.abs(p.x)))) + 2;
    const ys = scale(Math.max(-30, Math.min(-5, ...pts.map(p => p.y))) - 2, Math.min(50, Math.max(30, ...pts.map(p => p.y))) + 2, H - m.b, m.t, 6);
    const xs = scale(-xr, xr, m.l, W - m.r, 6);
    const clampX = v => Math.max(-xr, Math.min(xr, v)), clampY = v => Math.max(ys.ticks[0], Math.min(ys.ticks[ys.ticks.length - 1], v));
    let g = `<rect x="${m.l}" y="${ys.f(20)}" width="${W - m.r - m.l}" height="${ys.f(5) - ys.f(20)}" class="band"/><text x="${m.l + 6}" y="${ys.f(5) - 6}" class="qlab">Ideal attack angle 5°–20°</text>`;
    g += scatterFrame(W, H, m, xs, ys, '← Oppo · Attack direction (°) · Pull →', 'Attack angle (°)', v => Math.abs(v), v => v + '°');
    g += `<line class="avgline" x1="${xs.f(0)}" x2="${xs.f(0)}" y1="${m.t}" y2="${H - m.b}"/>`;
    g += pts.map(p => `<circle cx="${xs.f(clampX(p.x)).toFixed(1)}" cy="${ys.f(clampY(p.y)).toFixed(1)}" r="4" class="${p.r.c === 'X' ? 'sdot inplay' : 'sdot'}" data-tip="${esc(`${esc(fmtDate(p.r.d))} · ${esc(PT[p.r.pt]?.n || '')}<br>Bat ${F.f1(p.r.bat)} mph · AA ${F.f1(p.y)}°<br>${Math.abs(p.x).toFixed(1)}° ${p.x >= 0 ? 'pull' : 'oppo'} · ${esc(p.r.r ? RES_NAME[p.r.r] : CALL_NAME[p.r.c])}`)}"/>`).join('');
    g += `<rect x="${(xs.f(me.attackDir) - 7).toFixed(1)}" y="${(ys.f(me.attackAngle) - 7).toFixed(1)}" width="14" height="14" rx="2" transform="rotate(45 ${xs.f(me.attackDir).toFixed(1)} ${ys.f(me.attackAngle).toFixed(1)})" class="avgmark" data-tip="${esc(`<b>${nm} average</b><br>Attack angle ${F.f1(me.attackAngle)}° · ideal ${F.pct(me.idealAA)}%<br>${Math.abs(me.attackDir).toFixed(1)}° ${me.attackDir >= 0 ? 'pull' : 'oppo'}`)}"/>`;
    c2 = `<div class="panel"><div class="panel-h"><h2>Swing path</h2><span class="note">One dot per tracked swing</span></div>${svg(W, H, g, 'Swing path')}
      <div class="legend"><span><i class="lg-in"></i>Ball in play</span><span><i class="lg-out"></i>Foul or miss</span><span><i class="lg-avg"></i>Average</span></div></div>`;
  }

  // 3. Bat speed vs squared-up %, one dot per tracked contact
  const con = sw.filter(r => r.c === 'X' && r.ev != null && r.v != null && r.ht !== 'BU').map(r => ({ r, x: r.bat, y: r.ev / (1.23 * r.bat + 0.23 * r.v) }));
  let c3 = '';
  if (con.length) {
    const W = 420, H = 340, m = { l: 44, r: 12, t: 18, b: 40 };
    const xs = scale(Math.min(...con.map(p => p.x)) - 1, Math.max(...con.map(p => p.x)) + 1, m.l, W - m.r, 6);
    const yLo = Math.max(0, Math.min(0.6, Math.floor(Math.min(...con.map(p => p.y)) * 10) / 10));
    const ys = scale(yLo, 1.1, H - m.b, m.t, 5);
    const cl = v => Math.max(ys.lo, Math.min(ys.hi, v));
    // blast region: squared-up% x 100 + bat speed >= 164  ->  y >= (164 - x) / 100
    const xA = xs.lo, xB = xs.hi;
    let g = `<path class="blast" d="M${xs.f(xA)},${ys.f(cl((164 - xA) / 100))} L${xs.f(xB)},${ys.f(cl((164 - xB) / 100))} L${xs.f(xB)},${ys.f(ys.hi)} L${xs.f(xA)},${ys.f(ys.hi)} Z"/>`;
    g += scatterFrame(W, H, m, xs, ys, 'Bat speed (mph)', 'Squared-up %', v => v, v => Math.round(v * 100) + '%');
    g += `<line class="avgline" x1="${m.l}" x2="${W - m.r}" y1="${ys.f(0.8)}" y2="${ys.f(0.8)}"/><text x="${W - m.r - 4}" y="${ys.f(0.8) + 14}" text-anchor="end" class="qlab">Squared up (80%)</text>`;
    g += `<text x="${W - m.r - 4}" y="${ys.f(ys.hi) + 14}" text-anchor="end" class="qlab">Blast zone</text>`;
    g += con.sort((a, b) => (resGroup(b.r.r) === 'OUT') - (resGroup(a.r.r) === 'OUT')).map(p => { const rg = resGroup(p.r.r); return `<circle cx="${xs.f(p.x).toFixed(1)}" cy="${ys.f(cl(p.y)).toFixed(1)}" r="${rg === 'OUT' ? 4 : 5}" fill="${RES_COLOR[rg]}" fill-opacity="${rg === 'OUT' ? .55 : .9}" class="cdot" data-tip="${esc(`${esc(fmtDate(p.r.d))} · ${esc(RES_NAME[p.r.r] || p.r.r)}<br>Bat ${F.f1(p.x)} mph · squared-up ${Math.round(p.y * 100)}%<br>${F.f1(p.r.ev)} mph EV at ${F.f1(p.r.la)}°`)}"/>`; }).join('');
    c3 = `<div class="panel"><div class="panel-h"><h2>Bat speed &amp; squared-up</h2><span class="note">One dot per tracked ball in play · squared-up ${F.pct(me.sqPct)}% · blast ${F.pct(me.blastPct)}%</span></div>${svg(W, H, g, 'Bat speed versus squared-up rate per contact')}
      <div class="legend">${['1B', '2B', '3B', 'HR', 'OUT'].map(k => `<span><i style="background:${RES_COLOR[k]}"></i>${k === 'OUT' ? 'Out / other' : RES_NAME[k]}</span>`).join('')}</div></div>`;
  }
  return `<section class="grid3 batgrid">${c1}${c2}${c3}</section>`;
}

/* ---------- pages ---------- */
function setNav(r) { $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === r)); }

async function pageHome() {
  setNav('');
  const se = await loadSeason(S.season), m = S.meta.seasons.find(s => s.id === S.season);
  const H = seasonHitters(se), P = seasonPitchers(se);
  const bcHitRows = se.rows.filter(r => isBC(S.players[r.h]?.t)), bcPitRows = se.rows.filter(r => isBC(S.players[r.p]?.t));
  const th = stats(bcHitRows), tp = stats(bcPitRows), ps = pitchShape(bcPitRows);
  const top = (list, k, n, dir = -1, fmt) => [...list].filter(o => o[k] != null).sort((a, b) => dir < 0 ? b[k] - a[k] : a[k] - b[k]).slice(0, n)
    .map((o, i) => `<li><span class="rk">${i + 1}</span><span class="nm">${plink(o.i)}</span><span class="vl">${fmt(o[k])}</span></li>`).join('') || '<li class="muted">No qualifiers yet</li>';
  const qh = H.rows.filter(o => o.q), qp = P.rows.filter(o => o.q);
  const hardest = bcHitRows.filter(r => r.c === 'X' && r.ev != null).sort((a, b) => b.ev - a.ev).slice(0, 10)
    .map(r => ({ i: r.h, name: pname(r.h), ev: r.ev, la: r.la, dist: r.dist, r: r.r, d: r.d, g: r.g, pit: r.p }));
  const recent = [...se.games].map((g, gi) => ({ ...g, gi })).reverse().slice(0, 6);
  app.innerHTML = `
  <section class="hero">
    <div class="hero-l">
      <span class="eyebrow">Boston College Baseball</span>
      <h1>Birdball<span>Savant</span></h1>
      <div class="controls"><label for="home-season">Season</label>${seasonSelect('home-season', v => { setSeason(v); route(); })}</div>
    </div>
    <div class="hero-r">
      <span class="eyebrow">${esc(m.label)}</span>
      <div class="facts">
        <div><div class="fact-v">${m.games}</div><div class="fact-l">Games</div></div>
        <div><div class="fact-v">${F.int(m.pitches)}</div><div class="fact-l">Pitches tracked</div></div>
        <div><div class="fact-v">${F.int(se.rows.filter(r => r.c === 'X' && r.ev != null).length)}</div><div class="fact-l">Batted balls</div></div>
      </div>
      <div class="small" style="opacity:.85">${esc(fmtDate(m.start, true))} – ${esc(fmtDate(m.end, true))}</div>
    </div>
  </section>

  <section class="grid2">
    <div class="panel"><div class="panel-h"><h2>BC at the plate</h2><a class="small" href="#hitting">Hitting leaderboard</a></div>
      <div class="strip">
        <div class="tile"><div class="tile-v">${F.avg(th.avg)}</div><div class="tile-l">AVG</div></div>
        <div class="tile"><div class="tile-v">${F.avg(th.obp)}</div><div class="tile-l">OBP</div></div>
        <div class="tile"><div class="tile-v">${F.avg(th.slg)}</div><div class="tile-l">SLG</div></div>
        <div class="tile"><div class="tile-v">${F.avg(th.xwoba)}</div><div class="tile-l">xwOBA</div></div>
        <div class="tile"><div class="tile-v">${F.pct(th.hhPct)}</div><div class="tile-l">Hard Hit %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(th.kPct)}</div><div class="tile-l">K %</div></div>
      </div></div>
    <div class="panel"><div class="panel-h"><h2>BC on the mound</h2><a class="small" href="#pitching">Pitching leaderboard</a></div>
      <div class="strip">
        <div class="tile"><div class="tile-v">${F.pct(tp.kPct)}</div><div class="tile-l">K %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(tp.bbPct)}</div><div class="tile-l">BB %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(tp.whiff)}</div><div class="tile-l">Whiff %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(tp.chase)}</div><div class="tile-l">Chase %</div></div>
        <div class="tile"><div class="tile-v">${F.avg(tp.xwoba)}</div><div class="tile-l">xwOBA allowed</div></div>
        <div class="tile"><div class="tile-v">${F.f1(ps.fbVelo)}</div><div class="tile-l">FB Velo</div></div>
      </div></div>
  </section>

  <section>
    <div class="panel-h"><h2>${esc(m.label)} leaders</h2><span class="note muted small">Rate stats: ${H.q}+ PA hitters, ${P.q}+ batters-faced pitchers</span></div>
    <div class="leaders">
      <div class="lcard"><h3>xwOBA</h3><ol>${top(qh, 'xwoba', 5, -1, F.avg)}</ol></div>
      <div class="lcard"><h3>Avg Exit Velo</h3><ol>${top(qh, 'avgEV', 5, -1, F.f1)}</ol></div>
      <div class="lcard"><h3>Max Exit Velo</h3><ol>${top(qh, 'maxEV', 5, -1, F.f1)}</ol></div>
      <div class="lcard"><h3>Hard-Hit %</h3><ol>${top(qh, 'hhPct', 5, -1, F.pct)}</ol></div>
      <div class="lcard"><h3>Pitcher Whiff %</h3><ol>${top(qp, 'whiff', 5, -1, F.pct)}</ol></div>
      <div class="lcard"><h3>Pitcher K %</h3><ol>${top(qp, 'kPct', 5, -1, F.pct)}</ol></div>
      <div class="lcard"><h3>Max Velocity</h3><ol>${top(qp, 'maxVelo', 5, -1, F.f1)}</ol></div>
      <div class="lcard"><h3>Lowest xwOBA allowed</h3><ol>${top(qp, 'xwoba', 5, 1, F.avg)}</ol></div>
    </div>
  </section>

  <section class="grid-pp">
    <div class="panel"><div class="panel-h"><h2>Recent games</h2><a class="small" href="#games">All games</a></div>
      <div class="games-list">${recent.map(g => gameRow(se, g)).join('')}</div></div>
    <div class="panel" style="min-width:0"><div class="panel-h"><h2>Hardest-hit balls</h2><span class="note">BC hitters</span></div>
      ${table('t-hardest', [nameCol, { k: 'ev', label: 'EV', fmt: F.f1 }, { k: 'la', label: 'LA', fmt: F.f1 }, { k: 'dist', label: 'Dist', fmt: F.int },
        { k: 'r', label: 'Result', l: true, html: r => resBadge(r.r) }, { k: 'pit', label: 'Pitcher', l: true, html: r => esc(niceName(pname(r.pit))), get: r => pname(r.pit) },
        { k: 'd', label: 'Date', l: true, html: r => `<a href="#game-${se.id}-${r.g}">${esc(fmtDate(r.d))}</a>`, get: r => r.d }], hardest, { sort: 'ev' })}
    </div>
  </section>`;
}
function gameRow(se, g) {
  const opp = g.opp ? `${g.home ? 'vs' : '@'} ${esc(teamName(g.opp))}` : 'Intrasquad';
  return `<a class="grow" href="#game-${se.id}-${g.gi}"><span class="gd">${esc(fmtDate(g.d))}</span><span class="go">${opp}</span><span class="gm">${g.nt ? `${F.int(g.n)} PA · ${g.bb ? 'results + batted balls' : 'results only'}` : `${F.int(g.n)} pitches`}</span></a>`;
}

function execPct(v) { return v && v[1] ? v[0] / v[1] : null; }
function execCell(v, goal) {
  if (!v || !v[1]) return '<span class="muted">—</span>';
  const p = v[0] / v[1], cls = goal == null ? '' : p >= goal ? 'ok' : 'bad';
  return `<b class="ex ${cls}">${Math.round(p * 100)}%</b> <span class="muted small">${F.int(v[0])}/${F.int(v[1])}</span>`;
}
function execRows(se) {
  const ex = S.meta.execution?.[se.id];
  const T = seasonHitters(se), byI = new Map(T.rows.map(o => [o.i, o]));
  const rows = [], seen = new Set();
  for (const r of ex?.rows || []) {
    const i = r.k != null ? S.pidx.get(r.k) : undefined;
    const st = i != null ? byI.get(i) : null;
    if (i != null) seen.add(i);
    rows.push({ i, name: i != null ? S.players[i].n : r.name, num: r.num, k2W: st?.k2W || 0, k2PA: st?.k2PA || 0, k2win: st?.k2win ?? null, ex: r.vals });
  }
  for (const o of T.rows) if (!seen.has(o.i) && o.k2PA > 0) rows.push({ i: o.i, name: o.name, num: S.players[o.i].num, k2W: o.k2W, k2PA: o.k2PA, k2win: o.k2win, ex: {} });
  return { ex, rows };
}
function pageExecution(se, ui) {
  const { ex, rows } = execRows(se);
  const team = stats(se.rows.filter(r => isBC(S.players[r.h]?.t)));
  const goal = ex?.goal || {};
  const sortVal = v => v && v[1] ? v[0] / v[1] + v[1] * 1e-6 : null;
  const cols = [
    { k: 'name', label: 'Player', l: true, get: r => r.name,
      html: r => `${r.num != null ? `<span class="muted small" style="display:inline-block;min-width:2.2em">#${esc(r.num)}</span>` : '<span style="display:inline-block;min-width:2.2em"></span>'}${r.i != null ? plink(r.i) : esc(niceName(r.name))}` },
    { k: 'k2win', label: '2K Win', tip: 'Plate appearances that reached two strikes and did not end in a strikeout (TrackMan + results-only games)', get: r => r.k2PA ? r.k2W / r.k2PA + r.k2PA * 1e-6 : null,
      html: r => r._goal ? '' : execCell([r.k2W, r.k2PA], null) },
    ...(ex?.cats || []).map(c => ({ k: 'x_' + c.key, label: c.label, tip: `${c.label}: ${c.a} ÷ ${c.b}${goal[c.key] != null ? ` · goal ${Math.round(goal[c.key] * 100)}%` : ''}`,
      get: r => sortVal(r.ex[c.key]),
      html: r => r._goal ? (goal[c.key] != null ? `<b>${Math.round(goal[c.key] * 100)}%</b>` : '') : execCell(r.ex[c.key], goal[c.key]) })),
  ];
  const totals = [{ _label: 'BC total', _html: true, k2W: team.k2W, k2PA: team.k2PA, ex: ex?.team || {} }];
  if (ex && Object.keys(goal).length) totals.push({ _label: 'Goal', _html: true, _goal: true, ex: {} });
  const tid = 't-hit-exec';
  if (!S.sort[tid]) S.sort[tid] = { k: 'k2win', asc: false };
  return `
  <div class="controls"><span class="muted small">${ex ? `Execution chart updated through ${esc(fmtDate(ex.updated || seasonLabel(se.id), true))} · green meets the staff goal, red is below it` : 'No execution chart has been uploaded for this season. 2K Win comes from game data.'}</span></div>
  ${table(tid, cols, rows, { totals })}`;
}

async function pageLeaders(kind) {
  setNav(kind);
  const se = await loadSeason(S.season);
  const isHit = kind === 'hitting';
  const T = isHit ? seasonHitters(se) : seasonPitchers(se);
  const views = isHit ? HIT_VIEWS : PIT_VIEWS;
  const ui = S.ui[kind] || (S.ui[kind] = { view: 'standard', min: null });
  const min = ui.min ?? T.q;
  const data = T.rows.filter(o => o.PA >= min && (ui.view !== 'bat' || o.swingsTracked > 0));
  const viewOpts = Object.entries(views).map(([k, v]) => [k, v[0]]);
  if (isHit) viewOpts.push(['exec', 'Execution']);
  if (!views[ui.view] && !(isHit && ui.view === 'exec')) ui.view = 'standard';
  if (ui.view === 'exec') {
    app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))} · Boston College</span><h1>Hitting Leaderboard</h1></div>
    <div class="controls">${seasonSelect('lb-season', v => { setSeason(v); route(); })}</div></div>
  <div class="controls">${segmented('lb-view', viewOpts, ui.view, v => { ui.view = v; route(); })}</div>
  ${pageExecution(se, ui)}`;
    return;
  }
  const [vlabel, vcols] = views[ui.view];
  const defSort = isHit ? (ui.view === 'bat' ? 'batSpd' : ui.view === 'discipline' ? 'PA' : ui.view === 'statcast' ? 'xwoba' : 'ops') : (ui.view === 'standard' ? 'outs' : ui.view === 'statcast' ? 'PA' : 'pitches');
  const tid = `t-${kind}-${ui.view}`;
  if (!S.sort[tid]) S.sort[tid] = { k: defSort, asc: false };
  const total = stats(se.rows.filter(r => isBC(S.players[isHit ? r.h : r.p]?.t)));
  if (!isHit) Object.assign(total, pitchShape(se.rows.filter(r => isBC(S.players[r.p]?.t))));
  total._label = 'BC total';
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))} · Boston College</span><h1>${isHit ? 'Hitting' : 'Pitching'} Leaderboard</h1></div>
    <div class="controls">${seasonSelect('lb-season', v => { setSeason(v); route(); })}
      <label for="lb-min">Min ${isHit ? 'PA' : 'BF'}</label><input id="lb-min" type="number" min="0" value="${min}">
    </div></div>
  <div class="controls">${segmented('lb-view', viewOpts, ui.view, v => { ui.view = v; route(); })}
    ${ui.view === 'bat' ? `<span class="muted small">Bat tracking was on in ${new Set(se.rows.filter(r => r.bat != null).map(r => r.g)).size} of ${se.games.length} games this season</span>` : ''}
    <span class="muted small">${data.length} of ${T.rows.length} players · qualified = ${T.q}+ ${isHit ? 'PA' : 'batters faced'} · click a column to sort${isHit && se.games.some(g => g.nt) ? ` · includes ${se.games.filter(g => g.nt).length} results-only game(s) in counting stats` : ''}</span></div>
  ${isHit && ui.view === 'bat' ? batCharts(se, data) : ''}
  ${table(tid, [nameCol, ...(isHit ? [{ k: 'bats', label: 'B', fmt: F.str }] : [{ k: 'throws', label: 'T', fmt: F.str }]), ...vcols], data, { total })}`;
  const mi = $('#lb-min'); mi.onchange = () => { ui.min = Math.max(0, +mi.value || 0); route(); };
}

async function pageArsenal() {
  setNav('arsenal');
  const se = await loadSeason(S.season);
  const ui = S.ui.ars || (S.ui.ars = { pt: 'all', min: 1 });
  const rows = [];
  for (const [i, prs] of se.byP) {
    const p = S.players[i]; if (!p.bc) continue;
    if (prs.filter(r => r.r).length < MIN_PA) continue;   // 5+ batters faced
    for (const a of arsenal(prs)) if (a.n >= ui.min && (ui.pt === 'all' || a.pt === ui.pt)) rows.push({ i, name: p.n, th: p.th, ...a });
  }
  const types = PT_ORDER.filter(k => k !== 'UN');
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))} · Boston College</span><h1>Pitch Arsenals</h1></div>
    <div class="controls">${seasonSelect('ar-season', v => { setSeason(v); route(); })}
      <label for="ar-pt">Pitch</label><select id="ar-pt"><option value="all">All pitch types</option>${types.map(k => `<option value="${k}" ${ui.pt === k ? 'selected' : ''}>${PT[k].n}</option>`).join('')}</select>
      <label for="ar-min">Min pitches</label><input id="ar-min" type="number" min="1" value="${ui.min}"></div></div>
  ${table('t-arsenal', [nameCol, { k: 'th', label: 'T' },
    { k: 'pt', label: 'Pitch', l: true, html: r => `${ptDot(r.pt)}${PT[r.pt].n}`, get: r => PT_ORDER.indexOf(r.pt), asc: true },
    { k: 'n', label: '#', fmt: F.int }, { k: 'use', label: 'Usage%', fmt: F.pct }, { k: 'v', label: 'Velo', fmt: F.f1 }, { k: 'vmax', label: 'Max', fmt: F.f1 },
    { k: 'spin', label: 'Spin', fmt: F.int }, { k: 'ivb', label: 'IVB', fmt: F.f1 }, { k: 'hb', label: 'HB', fmt: F.f1 }, ...XMOV_COLS, { k: 'vaa', label: 'VAA', fmt: F.f1, tip: 'Vertical approach angle' },
    { k: 'ext', label: 'Ext', fmt: F.f1 }, { k: 'whiff', label: 'Whiff%', fmt: F.pct }, { k: 'csw', label: 'CSW%', fmt: F.pct }, { k: 'chase', label: 'Chase%', fmt: F.pct },
    { k: 'zone', label: 'Zone%', fmt: F.pct }, { k: 'putaway', label: 'PutAway%', fmt: F.pct, tip: 'Strikeouts per two-strike pitch' }, { k: 'avgEV', label: 'EV', fmt: F.f1 }, { k: 'xwoba', label: 'xwOBA', fmt: F.avg }],
    rows, { sort: 'n' })}
  <p class="muted small">Pitch types come from the TrackMan tag, falling back to TrackMan's auto-tag when a pitch was left untagged. "Fastball" tags are shown as four-seamers.</p>`;
  $('#ar-pt').onchange = e => { ui.pt = e.target.value; route(); };
  $('#ar-min').onchange = e => { ui.min = Math.max(1, +e.target.value || 1); route(); };
}

async function pageSpray() {
  setNav('spray');
  const se = await loadSeason(S.season);
  const f = S.ui.spray || (S.ui.spray = { bat: '', res: '', ht: '', bs: '', th: '', grp: '', minEV: '', color: 'result' });
  const opt = (arr, v) => arr.map(([k, l]) => `<option value="${esc(k)}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const qualH = new Set(seasonHitters(se).rows.filter(o => o.q).map(o => o.i));
  const batters = [...se.byH.keys()].filter(i => qualH.has(i) && se.byH.get(i).some(r => r.c === 'X' && r.dir != null)).sort((a, b) => pname(a).localeCompare(pname(b)));
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))} · Boston College hitters with ${MIN_PA}+ PA</span><h1>Spray Chart</h1></div>
    <div class="controls">${seasonSelect('sp-season', v => { setSeason(v); route(); })}</div></div>
  <form class="panel filters" id="sp-form">
    <label>Batter<select name="bat"><option value="">All BC hitters</option>${opt(batters.map(i => [i, niceName(pname(i))]), f.bat)}</select></label>
    <label>Result<select name="res"><option value="">Any</option>${opt([['hit', 'Hits'], ['xbh', 'Extra-base hits'], ['HR', 'Home runs'], ['out', 'Outs / other']], f.res)}</select></label>
    <label>Batted-ball type<select name="ht"><option value="">Any</option>${opt([['GB', 'Ground balls'], ['LD', 'Line drives'], ['FB', 'Fly balls'], ['PU', 'Popups']], f.ht)}</select></label>
    <label>Batter side<select name="bs"><option value="">Any</option>${opt([['R', 'RHH'], ['L', 'LHH']], f.bs)}</select></label>
    <label>Pitcher hand<select name="th"><option value="">Any</option>${opt([['R', 'vs RHP'], ['L', 'vs LHP']], f.th)}</select></label>
    <label>Pitch type<select name="grp"><option value="">Any</option>${opt([['Fastballs', 'Fastballs'], ['Breaking', 'Breaking balls'], ['Offspeed', 'Offspeed']], f.grp)}</select></label>
    <label>Min exit velo<input name="minEV" type="number" min="0" max="130" value="${esc(f.minEV)}"></label>
    <label>Color by<select name="color">${opt([['result', 'Result'], ['ev', 'Exit velo'], ['ht', 'Batted-ball type']], f.color)}</select></label>
  </form>
  <section class="grid-pp" style="align-items:start">
    <div class="panel"><div id="sp-chart" class="chart-box" style="max-width:640px"></div></div>
    <div style="display:grid;gap:16px;min-width:0" id="sp-side"></div>
  </section>`;
  const form = $('#sp-form');
  const run = () => {
    for (const [k, v] of new FormData(form)) f[k] = v;
    const rows = se.rows.filter(r => {
      if (!qualH.has(r.h) || r.c !== 'X' || r.ht === 'BU') return false;
      if (f.bat !== '' && r.h !== +f.bat) return false;
      const hit = ['1B', '2B', '3B', 'HR'].includes(r.r);
      if (f.res === 'hit' && !hit) return false;
      if (f.res === 'xbh' && !['2B', '3B', 'HR'].includes(r.r)) return false;
      if (f.res === 'HR' && r.r !== 'HR') return false;
      if (f.res === 'out' && hit) return false;
      if (f.ht && r.ht !== f.ht) return false;
      if (f.bs && r.bs !== f.bs) return false;
      if (f.th && r.th !== f.th) return false;
      if (f.grp && GROUP[r.pt] !== f.grp) return false;
      if (f.minEV !== '' && !(r.ev != null && r.ev >= +f.minEV)) return false;
      return true;
    });
    const plotted = rows.filter(r => r.dir != null && r.dist != null);
    const st = stats(rows);
    const hits = rows.filter(r => ['1B', '2B', '3B', 'HR'].includes(r.r)).length;
    $('#sp-chart').innerHTML = sprayChart(plotted, { color: f.color, showBatter: f.bat === '' });
    const byB = new Map(); rows.forEach(r => { if (!byB.has(r.h)) byB.set(r.h, []); byB.get(r.h).push(r); });
    const list = [...byB].map(([i, a]) => ({ i, name: pname(i), ...stats(a), n: a.length }));
    $('#sp-side').innerHTML = `
      <div class="strip">
        <div class="tile"><div class="tile-v">${F.int(rows.length)}</div><div class="tile-l">Balls in play</div></div>
        <div class="tile"><div class="tile-v">${F.int(hits)}</div><div class="tile-l">Hits</div></div>
        <div class="tile"><div class="tile-v">${F.avg(rows.length ? hits / rows.length : null)}</div><div class="tile-l">Avg on contact</div></div>
        <div class="tile"><div class="tile-v">${F.f1(st.avgEV)}</div><div class="tile-l">Avg EV</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.hhPct)}</div><div class="tile-l">Hard Hit %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.brlPct)}</div><div class="tile-l">Barrel %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.pullPct)}</div><div class="tile-l">Pull %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.centPct)}</div><div class="tile-l">Straight %</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.oppoPct)}</div><div class="tile-l">Oppo %</div></div>
      </div>
      ${f.bat === '' ? table('t-spray-b', [nameCol, { k: 'n', label: 'BIP', fmt: F.int }, C.avgEV, C.hhPct, C.pullPct, C.oppoPct, C.gbPct], list, { sort: 'n' }) : `<a class="btn" href="#player-${esc(S.players[+f.bat].k)}">Open ${esc(niceName(pname(+f.bat)))}'s page</a>`}`;
  };
  form.onchange = run; form.onsubmit = e => { e.preventDefault(); run(); };
  run();
}

async function pageGames() {
  setNav('games');
  const se = await loadSeason(S.season);
  const list = se.games.map((g, gi) => ({ ...g, gi })).reverse();
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))}</span><h1>Games</h1></div>
    <div class="controls">${seasonSelect('gm-season', v => { setSeason(v); route(); })}</div></div>
    <div class="games-list">${list.map(g => gameRow(se, g)).join('') || '<p class="empty">No games in this season.</p>'}</div>`;
}

async function pageGame(sid, gi) {
  setNav('games');
  const se = await loadSeason(sid); const g = se.games[gi];
  if (!g) { app.innerHTML = '<p class="err">That game was not found.</p>'; return; }
  const rows = se.rows.filter(r => r.g === gi);
  const lines = (key, filt) => {
    const m = new Map(); rows.filter(filt).forEach(r => { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); });
    return [...m].map(([i, a]) => ({ i, name: pname(i), ...stats(a), ...pitchShape(a) }));
  };
  const intra = !g.opp;
  // every pitch of the game, in order (BC hitters get the hitter angles, BC pitchers the pitcher angles)
  const everyQ = groupPAs(rows).flatMap(pa => {
    const f = pa.rows[0], role = g.opp && !isBC(S.players[f.h].t) ? 'pit' : 'hit';
    const t = `${f.top ? 'Top' : 'Bot'} ${f.inn} · ${niceName(pname(f.h))} vs ${niceName(pname(f.p))}`;
    const per = pa.rows.map((r, k) => ({ r, k, c: pitchClips(r, role) })).filter(o => o.c.length);
    if (!per.length) { const whole = paClips(pa.rows, role); return whole.length ? [{ t: `${t} · whole at-bat`, clips: whole }] : []; }
    return per.map(({ r, k, c }) => ({ t: `${t} · pitch ${k + 1}: ${r.b}-${r.s} ${PT[r.pt]?.n || ''} ${r.v != null ? F.f1(r.v) + ' mph' : ''} · ${pitchDesc(r)}`, clips: c }));
  });
  const everyV = everyQ.length ? vbtn(everyQ, `Watch every pitch (${everyQ.length})`, 'btn vbtn-hi') : '';
  const gameV = everyV + ((g.vid || []).length ? vbtn([{ t: `${fmtDate(g.d, true)} ${g.opp ? `BC ${g.home ? 'vs' : '@'} ${teamName(g.opp)}` : 'Intrasquad'} · full game`, clips: g.vid }], 'Full game video', 'btn vbtn-hi') : '');
  const bcBat = lines('h', r => isBC(S.players[r.h].t)), bcPit = lines('p', r => isBC(S.players[r.p].t));
  bcBat.forEach(o => { o.dec = decisionStats(se, rows.filter(r => r.h === o.i)); o.decPct = o.dec.pct; o.decN = o.dec.good; });
  const tDec = decisionStats(se, rows.filter(r => isBC(S.players[r.h].t)));
  const teamDecLine = tDec.n ? `<span class="note">BC good decisions: ${tDec.good} of ${tDec.n} (${F.pct(tDec.pct)}%)</span>` : '';
  const bb = rows.filter(r => r.c === 'X' && r.ev != null).sort((a, b) => b.ev - a.ev).slice(0, 15)
    .map(r => ({ i: r.h, name: pname(r.h), ev: r.ev, la: r.la, dist: r.dist, r: r.r, inn: r.inn, pit: r.p, team: S.players[r.h].t }));
  const decCols = rows.some(rvUsable) ? [
    { k: 'decN', label: 'Good Dec.', html: r => esc(decTxt(r.dec)), tip: 'Good swing/take decisions out of every pitch he saw' },
    { k: 'decPct', label: 'Good Dec. %', fmt: F.pct, tip: 'Share of pitches where he made the right swing/take decision for the pitch location and count' }] : [];
  const batCols = [nameCol, C.PA, C.AB, C.H, C['2B'], C.HR, C.BB, C.K, C.bbe, C.avgEV, C.maxEV, { k: 'hh', label: 'Hard Hit', get: r => r.hhPct != null ? Math.round(r.hhPct * r.bbe) : null, fmt: F.int }, C.xwoba, ...decCols];
  const pitCols = [nameCol, C.ip, C.PA, C.pitches, C.H, C.BB, C.K, C.runs, { k: 'swk', label: 'Whiffs', get: r => r.whiff != null ? Math.round(r.whiff * r.swing * r.pitches) : 0, fmt: F.int }, C.csw, C.fbVelo, { k: 'maxVelo', label: 'Max Velo', fmt: F.f1 }, C.xwoba];
  const anyV = rows.some(r => r.vid != null);
  const pbpCol = role => ({ k: 'pbp', label: '', l: true, get: () => 0, html: r => `<a class="loglink" href="#pg-${sid}-${gi}-${role}-${esc(S.players[r.i].k)}">Pitch by pitch ›</a>` });
  const vcol = role => ({ k: 'vid', label: 'Video', l: true, get: r => rows.filter(x => (role === 'hit' ? x.h : x.p) === r.i && x.vid != null).length,
    html: r => rows.some(x => (role === 'hit' ? x.h : x.p) === r.i && x.vid != null) ? `<a class="vbtn vbtn-sm" href="#pg-${sid}-${gi}-${role}-${esc(S.players[r.i].k)}" aria-label="Watch ${esc(niceName(pname(r.i)))}">▶ Watch</a>` : '' });
  if (g.nt) {
    app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(fmtDate(g.d, true))} · ${g.bb ? 'Results + batted balls' : 'Results only'}</span>
    <h1>BC ${g.home ? 'vs' : '@'} ${esc(teamName(g.opp))}</h1></div><div class="controls">${gameV}<a class="btn" href="#games">All games</a></div></div>
  <p class="muted small" style="margin:0">${g.bb ? 'Plate-appearance results plus TrackMan batted-ball data. Exit velocity, launch angle, xwOBA and the spray chart use these balls in play; pitch-level stats like swing and chase rates are not available for this game.' : 'No TrackMan file for this game. Plate-appearance results count toward AVG, OBP, SLG, wOBA, K% and BB%, and are left out of tracked stats like exit velocity and xwOBA.'}</p>
  <section><div class="panel-h"><h2>BC hitters</h2></div>${table('t-gbat', [nameCol, C.PA, C.AB, C.H, C['2B'], C['3B'], C.HR, C.BB, C.K, C.HBP, C.avg, C.obp, C.slg, ...(g.bb ? [C.bbe, C.avgEV, C.maxEV, C.xwoba] : [])], bcBat, { sort: 'PA', total: { ...stats(rows), _label: 'BC total' } })}</section>
  ${g.bb ? `<section class="grid-pp"><div class="panel"><div class="panel-h"><h2>Spray chart</h2></div><div class="chart-box">${sprayChart(rows, { showBatter: true })}</div></div>
    <div><div class="panel-h"><h2>Hardest-hit balls</h2></div>${table('t-gbb', [nameCol, { k: 'ev', label: 'EV', fmt: F.f1 }, { k: 'la', label: 'LA', fmt: F.f1 }, { k: 'dist', label: 'Dist', fmt: F.int }, { k: 'r', label: 'Result', l: true, html: r => resBadge(r.r) }],
      rows.filter(r => r.c === 'X' && r.ev != null).sort((a, b) => b.ev - a.ev).slice(0, 15).map(r => ({ i: r.h, name: pname(r.h), ev: r.ev, la: r.la, dist: r.dist, r: r.r })), { sort: 'ev' })}</div></section>` : ''}`;
    return;
  }
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(fmtDate(g.d, true))} · ${esc(g.st)}</span>
    <h1>${intra ? 'Intrasquad' : `BC ${g.home ? 'vs' : '@'} ${esc(teamName(g.opp))}`}</h1></div>
    <div class="controls">${gameV}<a class="btn" href="#games">All games</a></div></div>
  <section><div class="panel-h"><h2>BC hitters</h2>${teamDecLine || (anyV ? '<span class="note">▶ opens that player\'s at-bats with video</span>' : '')}</div>${table('t-gbat', [...batCols, ...(anyV ? [vcol('hit')] : []), pbpCol('hit')], bcBat, { sort: 'PA' })}</section>
  <section><div class="panel-h"><h2>BC pitchers</h2><span class="note">IP and runs come from TrackMan's play tagging</span></div>${table('t-gpit', [...pitCols, ...(anyV ? [vcol('pit')] : []), pbpCol('pit')], bcPit, { sort: 'pitches' })}</section>
  <section><div class="panel-h"><h2>Hardest-hit balls</h2><span class="note">Both teams</span></div>
    ${table('t-gbb', [nameCol, { k: 'team', label: 'Team', l: true, fmt: v => esc(isBC(v) ? 'BC' : teamName(v)) }, { k: 'inn', label: 'Inn', fmt: F.int }, { k: 'ev', label: 'EV', fmt: F.f1 }, { k: 'la', label: 'LA', fmt: F.f1 }, { k: 'dist', label: 'Dist', fmt: F.int }, { k: 'r', label: 'Result', l: true, html: r => resBadge(r.r) }, { k: 'pit', label: 'Pitcher', l: true, html: r => plink(r.pit), get: r => pname(r.pit) }], bb, { sort: 'ev' })}</section>`;
}

/* ---------- TruMedia / NCAA ---------- */
const LOWER_BETTER = new Set(['K%', 'Chase%', 'Whiff%', 'InZoneWhiff%', 'ERA', 'FIP', 'WHIP', 'BB/9', 'BB%|PIT', 'BA|PIT', 'OBP|PIT', 'SLG|PIT', 'wOBA|PIT', 'xwOBA|PIT', 'xBA|PIT', 'ExitVel|PIT', 'HardHit%|PIT', 'Barrel%|PIT']);
const AVG_STATS = new Set(['AVG', 'OBP', 'SLG', 'OPS', 'ISO', 'BABIP', 'wOBA', 'xwOBA', 'xBA', 'xSLG']);
function ncaaFmt(col, v) {
  if (v == null || !isFinite(v)) return '—';
  const base = col.replace('|PIT', '');
  if (base.startsWith('Hit+')) return String(Math.round(v));
  if (col.includes('%')) return (v * 100).toFixed(1);
  if (AVG_STATS.has(base) || base === 'BA') return F.avg(v);
  if (['ERA', 'FIP', 'WHIP', 'K/9', 'BB/9'].includes(base)) return v.toFixed(2);
  if (base === 'IP') return v.toFixed(1);
  if (/Spin/.test(base)) return F.int(v);
  if (/Vel|Ang|Extension|BatSpeed/.test(base)) return v.toFixed(1);
  return Number.isInteger(v) ? F.int(v) : v.toFixed(1);
}
async function loadNcaa(year) {
  S.ncaa = S.ncaa || {};
  if (S.ncaa[year]) return S.ncaa[year];
  const m = (S.meta.ncaa?.years || []).find(y => y.year === year);
  if (!m) return null;
  const j = await getJSON('data/' + m.file);
  for (const side of ['hitting', 'pitching']) {
    const d = j[side]; if (!d) continue;
    const pctCols = d.stats.filter(c => c.includes('%'));
    const max = {}; for (const c of pctCols) max[c] = 0;
    d.list = d.rows.map(r => {
      const o = {}; d.fields.forEach((f, i) => o[f] = r[i]);
      d.stats.forEach((c, i) => { o[c] = r[d.fields.length + i]; });
      for (const c of pctCols) if (o[c] != null) max[c] = Math.max(max[c], Math.abs(o[c]));
      return o;
    });
    // TruMedia may send percentages as 25.3 or 0.253; store fractions
    for (const c of pctCols) if (max[c] > 1.5) d.list.forEach(o => { if (o[c] != null) o[c] = o[c] / 100; });
    const q = j.qualify || {};
    d.qual = o => side === 'hitting' ? (o.PA ?? 0) >= (q.hitting_PA ?? 100) : (o.IP ?? 0) >= (q.pitching_IP ?? 25);
  }
  S.ncaa[year] = j;
  return j;
}
function ncaaYearFor(seasonId) {
  const ys = (S.meta.ncaa?.years || []).map(y => y.year).sort((a, b) => a - b);
  if (!ys.length) return null;
  const want = parseInt(seasonId, 10);
  return ys.includes(want) ? want : (ys.filter(y => y <= want).pop() ?? ys[ys.length - 1]);
}
async function p4Alt(seasonId, side) {
  const year = ncaaYearFor(seasonId); if (year == null) return null;
  const j = await loadNcaa(year); const d = j?.[side]; if (!d) return null;
  const map = j.percentile_map?.[side] || {};
  const p4 = d.list.filter(o => o.p4), pool = p4.filter(o => d.qual(o));
  if (!pool.length) {   // nothing to rank against yet: fall back to BC and say why
    const q = j.qualify || {};
    S.p4Why = !p4.length ? `no Power 4 ${side === 'hitting' ? 'hitters' : 'pitchers'} identified in the ${year} TruMedia data yet (see Data status)`
      : `none of the ${p4.length} Power 4 ${side === 'hitting' ? 'hitters' : 'pitchers'} in the ${year} TruMedia data reach ${side === 'hitting' ? (q.hitting_PA ?? 100) + ' PA' : (q.pitching_IP ?? 25) + ' IP'}${d.stats.includes(side === 'hitting' ? 'PA' : 'IP') ? '' : ` (TruMedia sent no ${side === 'hitting' ? 'PA' : 'IP'} column)`}`;
    return null;
  }
  S.p4Why = '';
  return { year, n: pool.length, values: k => { const c = map[k]; return c && d.stats.includes(c) ? pool.map(o => o[c]).filter(v => v != null) : null; } };
}

async function pageNcaa() {
  setNav('ncaa');
  const years = (S.meta.ncaa?.years || []).map(y => y.year).sort((a, b) => b - a);
  if (!years.length) { app.innerHTML = '<p class="empty">TruMedia data has not been pulled yet. See the Data status page.</p>'; return; }
  const ui = S.ui.ncaa || (S.ui.ncaa = { year: years[0], side: 'hitting', scope: 'p4', team: '', q: '', min: null });
  if (!years.includes(ui.year)) ui.year = years[0];
  const j = await loadNcaa(ui.year), d = j[ui.side];
  const opt = (arr, v) => arr.map(([k, l]) => `<option value="${esc(k)}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const p4confs = [...new Set((d?.list || []).filter(o => o.p4).map(o => o.conf).filter(Boolean))].sort();
  const minKey = ui.side === 'hitting' ? 'PA' : 'IP';
  const minDef = ui.side === 'hitting' ? (j.qualify?.hitting_PA ?? 100) : (j.qualify?.pitching_IP ?? 25);
  const min = ui.min ?? minDef;
  const inScope = o => ui.scope === 'all' ? true : ui.scope === 'p4' ? o.p4 : (o.conf === ui.scope);
  const teams = [...new Set((d?.list || []).filter(inScope).map(o => o.team))].sort();
  const q = ui.q.trim().toLowerCase();
  const rows = (d?.list || []).filter(o => inScope(o) && (!ui.team || o.team === ui.team) && (!q || o.name.toLowerCase().includes(q)) && (o[minKey] ?? 0) >= min);
  const statCols = (d?.stats || []).map(c => ({ k: c, label: c.replace('|PIT', ''), fmt: v => ncaaFmt(c, v), asc: LOWER_BETTER.has(c) }));
  const tid = `t-ncaa-${ui.side}`;
  if (!S.sort[tid]) S.sort[tid] = { k: ui.side === 'hitting' ? (d?.stats.includes('OPS') ? 'OPS' : 'PA') : (d?.stats.includes('IP') ? 'IP' : d?.stats[0]), asc: false };
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">TruMedia · NCAA Division I · ${ui.year}</span><h1>NCAA Research</h1></div>
    <div class="controls"><label for="nc-year">Season</label><select id="nc-year">${opt(years.map(y => [y, y]), ui.year)}</select></div></div>
  <div class="controls">${segmented('nc-side', [['hitting', 'Hitters'], ['pitching', 'Pitchers']], ui.side, v => { ui.side = v; ui.team = ''; ui.min = null; route(); })}
    <label for="nc-scope">Scope</label><select id="nc-scope">${opt([['p4', 'Power 4'], ['all', 'All D1'], ...p4confs.map(c => [c, c])], ui.scope)}</select>
    <label for="nc-team">Team</label><select id="nc-team"><option value="">All teams</option>${opt(teams.map(t => [t, t]), ui.team)}</select>
    <label for="nc-q">Player</label><input id="nc-q" type="search" placeholder="Search name" value="${esc(ui.q)}" style="width:150px">
    <label for="nc-min">Min ${minKey}</label><input id="nc-min" type="number" min="0" value="${min}"></div>
  <span class="muted small">${F.int(rows.length)} players${rows.length > 500 ? ' · showing the top 500 for the current sort' : ''} · pulled ${esc(new Date(j.pulled).toLocaleDateString())}</span>
  ${table(tid, [{ k: 'name', label: 'Player', l: true, get: r => r.name, html: r => `<a href="#ncaa-p-${ui.year}-${ui.side}-${encodeURIComponent(r.id || r.name).replace(/%/g, '~')}">${esc(r.name)}</a>` },
    { k: 'team', label: 'Team', l: true, asc: true }, { k: 'pos', label: 'Pos', l: true, asc: true }, ...statCols], rows, { limit: 500 })}`;
  $('#nc-year').onchange = e => { ui.year = +e.target.value; route(); };
  $('#nc-scope').onchange = e => { ui.scope = e.target.value; ui.team = ''; route(); };
  $('#nc-team').onchange = e => { ui.team = e.target.value; route(); };
  $('#nc-min').onchange = e => { ui.min = Math.max(0, +e.target.value || 0); route(); };
  let t; $('#nc-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value; route().then(() => { const el = $('#nc-q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); }, 250); };
}

async function pageNcaaPlayer(year, side, rawId) {
  setNav('ncaa');
  const id = decodeURIComponent(rawId.replace(/~/g, '%'));
  const j = await loadNcaa(year); const d = j?.[side];
  const o = d?.list.find(x => (x.id || x.name) === id);
  if (!o) { app.innerHTML = '<p class="err">Player not found in the TruMedia data.</p>'; return; }
  const map = j.percentile_map?.[side] || {};
  const pool = d.list.filter(x => x.p4 && d.qual(x));
  const defs = (side === 'hitting' ? HIT_PCT : PIT_PCT).filter(df => map[df[1]] && d.stats.includes(map[df[1]]))
    .map(([lab, k, dir, fmt]) => [lab, map[k], dir, v => ncaaFmt(map[k], v)]);
  const me = { ...o, q: d.qual(o) };
  const other = side === 'hitting' ? 'pitching' : 'hitting';
  const twoWay = j[other]?.list.find(x => (x.id || x.name) === id);
  app.innerHTML = `
  <div class="player-head"><div>
    <span class="eyebrow">${esc(o.team)}${o.conf ? ' · ' + esc(o.conf) : ''} · ${year} · TruMedia</span>
    <h1>${esc(o.name)}</h1>
    <div class="bio">${o.pos ? `<span><b>${esc(o.pos)}</b></span>` : ''}${o.hand ? `<span>${side === 'hitting' ? 'Bats' : 'Throws'} <b>${esc(o.hand)}</b></span>` : ''}<span>${o.p4 ? 'Power 4' : 'Division I'}</span></div>
  </div><div class="controls">${twoWay ? `<a class="btn" href="#ncaa-p-${year}-${other}-${encodeURIComponent(id).replace(/%/g, '~')}">${other === 'pitching' ? 'Pitching' : 'Hitting'} card</a>` : ''}<a class="btn" href="#ncaa">Back to research</a></div></div>
  <section class="grid-pp">
    <div class="panel"><div class="panel-h"><h2>Percentile rankings</h2><span class="note">vs ${pool.length} qualified Power 4 ${side === 'hitting' ? 'hitters' : 'pitchers'}, ${year}${me.q ? '' : ' · below the qualifying minimum, shown faded'}</span></div>
      ${defs.length ? pctBars(defs.map(df => [df[0], df[1], df[2], df[3]]), me, pool) : '<p class="empty">No percentile stats available for this player.</p>'}</div>
    <div class="panel"><div class="panel-h"><h2>${year} season</h2></div>
      <dl class="gloss" style="grid-template-columns:minmax(90px,140px) minmax(0,1fr)">${d.stats.map(c => `<dt>${esc(c.replace('|PIT', ''))}</dt><dd style="color:var(--ink)">${ncaaFmt(c, o[c])}</dd>`).join('')}</dl></div>
  </section>`;
}

/* ---------- player page ---------- */
async function pagePlayer(key) {
  setNav('');
  const i = S.pidx.get(key);
  if (i == null) { app.innerHTML = '<p class="err">Player not found. They may not have any tracked pitches yet.</p>'; return; }
  const p = S.players[i];
  const hitS = p.hit.filter(s => S.meta.seasons.some(x => x.id === s)), pitS = p.pit.filter(s => S.meta.seasons.some(x => x.id === s));
  const order = id => S.meta.seasons.findIndex(s => s.id === id);
  hitS.sort((a, b) => order(a) - order(b)); pitS.sort((a, b) => order(a) - order(b));
  await Promise.all([...new Set([...hitS, ...pitS])].map(loadSeason));
  const ui = S.ui['p:' + key] || (S.ui['p:' + key] = {});
  if (!ui.role) {
    const nH = sum(hitS.map(s => (S.seasons[s].byH.get(i) || []).filter(r => r.r).length));
    const nP = sum(pitS.map(s => (S.seasons[s].byP.get(i) || []).filter(r => r.r).length));
    ui.role = nP > nH ? 'pit' : 'hit';
  }
  const role = ui.role, seasons = role === 'hit' ? hitS : pitS;
  if (!ui.season || !seasons.includes(ui.season)) ui.season = seasons.includes(S.season) ? S.season : seasons[seasons.length - 1];
  const both = hitS.length && pitS.length;
  const head = `<div class="player-head"><div>
      <span class="eyebrow">${p.bc ? 'Boston College' : esc(teamName(p.t))}</span>
      <h1>${p.num != null ? `<span class="jersey">#${esc(p.num)}</span>` : ''}${esc(niceName(p.n))}</h1>
      <div class="bio">${p.pos ? `<span><b>${esc(p.pos)}</b></span>` : ''}${p.cls ? `<span><b>${esc(p.cls)}</b></span>` : ''}${p.ht ? `<span><b>${esc(p.ht)}, ${esc(p.wt)} lb</b></span>` : ''}${p.home ? `<span>${esc(p.home)}</span>` : ''}${p.b ? `<span>Bats <b>${esc(p.b)}</b></span>` : ''}${p.th ? `<span>Throws <b>${esc(p.th)}</b></span>` : ''}
        <span>Seasons <b>${[...new Set([...hitS, ...pitS])].sort((a, b) => order(a) - order(b)).map(seasonLabel).join(', ')}</b></span></div>
    </div>
    <div class="controls">${both ? segmented('pl-role', [['hit', 'Hitting'], ['pit', 'Pitching']], role, v => { ui.role = v; route(); }) : ''}
      ${seasons.length ? `<label for="pl-season">Season</label>${seasonSelect('pl-season', v => { ui.season = v; route(); }, seasons)}` : ''}</div></div>`;
  if (!seasons.length) { app.innerHTML = head + '<p class="empty">No tracked data yet.</p>'; return; }
  const hasNcaa = (S.meta.ncaa?.years || []).length > 0;
  if (hasNcaa && !S.pctPool) S.pctPool = ls.get('pctPool', 'p4');
  const alt = hasNcaa && S.pctPool === 'p4' ? await p4Alt(ui.season, role === 'hit' ? 'hitting' : 'pitching') : null;
  const pv = S.meta.video?.players?.[key] || [];
  const pvHtml = pv.length ? `<section class="panel"><div class="panel-h"><h2>Video</h2><span class="note">Bullpens, BP and other clips</span></div>${clipList(pv, c => c.t || 'Clip')}</section>` : '';
  app.innerHTML = head + (role === 'hit' ? hitterBody(i, p, hitS, ui, alt, hasNcaa) : pitcherBody(i, p, pitS, ui, alt, hasNcaa)) + pvHtml;
  const sel = $('#pl-season'); if (sel) sel.value = ui.season;
  bindPlayer(i, p, role, ui);
}

function poolSwitch(hasNcaa) {
  if (!hasNcaa) return '';
  return segmented('pool-sw', [['bc', 'vs BC'], ['p4', 'vs Power 4']], S.pctPool, v => { S.pctPool = v; ls.set('pctPool', v); route(); });
}
function poolNote(alt, T, pool, unit, meRow) {
  return alt ? `vs ${alt.n} qualified Power 4 ${unit === 'PA' ? 'hitters' : 'pitchers'} (TruMedia ${alt.year})` : `vs ${pool.length} qualified BC ${unit === 'PA' ? 'hitters' : 'pitchers'} (${T.q}+ ${unit})${meRow.q ? '' : ' · below qualifying ' + unit + ', shown faded'}${S.pctPool === 'p4' && S.p4Why ? ` · Power 4 unavailable: ${esc(S.p4Why)}` : ''}`;
}
function hitterBody(i, p, seasons, ui, alt, hasNcaa) {
  const se = S.seasons[ui.season], rows = se.byH.get(i) || [], me = stats(rows);
  const T = seasonHitters(se), meRow = T.rows.find(o => o.i === i) || { ...me, q: false };
  const pool = T.rows.filter(o => o.q);
  const perSeason = seasons.map(s => { const st = stats(S.seasons[s].byH.get(i) || []); return { ...st, hitPlus: hpVal(S.seasons[s], i), name: seasonLabel(s), sid: s }; });
  const all = stats(seasons.flatMap(s => S.seasons[s].byH.get(i) || [])); all._label = 'All seasons';
  const hp = se.hitPlus?.get(i);
  const sCol = { k: 'name', label: 'Season', l: true, get: r => order(r.sid), html: r => esc(r.name) };
  function order(id) { return S.meta.seasons.findIndex(s => s.id === id); }
  ui.zm = ui.zm || 'xwoba';
  const splits = [
    ['vs RHP', rows.filter(r => r.th === 'R')], ['vs LHP', rows.filter(r => r.th === 'L')],
    ['vs Fastballs', rows.filter(r => GROUP[r.pt] === 'Fastballs')], ['vs Breaking', rows.filter(r => GROUP[r.pt] === 'Breaking')], ['vs Offspeed', rows.filter(r => GROUP[r.pt] === 'Offspeed')],
  ].filter(x => x[1]).map(([n, a]) => ({ name: n, ...stats(a) }));
  const glog = gameLog(rows, se, 'h');
  return `
  <section class="grid-pp">
    <div class="panel"><div class="panel-h"><h2>Percentile rankings</h2>${poolSwitch(hasNcaa)}</div>
      <p class="muted small" style="margin:-4px 0 10px">${esc(se.label)} · ${poolNote(alt, T, pool, 'PA', meRow)}</p>
      ${pctBars(HIT_PCT.filter(d => (d[1] !== 'batSpd' || pool.some(o => o.batSpd != null)) && (d[1] !== 'hitPlus' || hp)), meRow, pool, alt)}
      ${hp ? `<p class="muted small" style="margin:8px 0 0"><b>Hit+ ${Math.round(hp.hit)}</b>${Object.keys(hp.groups).filter(g => g !== 'ALL').length ? ' · ' + Object.entries(hp.groups).map(([g, v]) => `${{ FB: 'Fastballs', BR: 'Breaking', OS: 'Offspeed' }[g] || g} ${Math.round(v)}`).join(' · ') : ''} · ${hp.src === 'TruMedia' ? 'from TruMedia' : 'from TrackMan'}, scaled to D1 ${hp.year} (100 = average)</p>` : ''}</div>
    <div class="panel"><div class="panel-h"><h2>Spray chart</h2><span class="note">${esc(se.label)}</span></div><div class="chart-box">${sprayChart(rows)}</div></div>
  </section>
  ${swingTakeChart(rows, se.rows.filter(r => !r.nt), 'hit')}
  ${decisionPanel(rows, se, i)}
  <section><div class="panel-h"><h2>Standard</h2>${all.ntPA ? `<span class="note">Includes ${all.ntPA} PA from results-only games; batted-ball and discipline stats use TrackMan games only</span>` : ''}</div>${table('t-ph-std', [sCol, ...HIT_VIEWS.standard[1]], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>
  <section><div class="panel-h"><h2>Batted ball &amp; expected stats</h2></div>${table('t-ph-sc', [sCol, ...HIT_VIEWS.statcast[1]], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>
  ${all.swingsTracked ? `<section><div class="panel-h"><h2>Bat tracking</h2><span class="note">Only games with bat tracking turned on</span></div>${table('t-ph-bat', [sCol, ...HIT_VIEWS.bat[1]], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>` : ''}
  ${playerBatCharts(i, se)}
  <section><div class="panel-h"><h2>Plate discipline</h2></div>${table('t-ph-pd', [sCol, ...HIT_VIEWS.discipline[1]], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>
  <section class="grid2">
    <div class="panel"><div class="panel-h"><h2>Zone profile</h2>
      <select id="zm" aria-label="Zone metric">${[['dmg', 'Damage (xwOBA on contact)'], ['xwoba', 'xwOBA'], ['ba', 'Batting avg'], ['ev', 'Avg exit velo'], ['swing', 'Swing %'], ['whiff', 'Whiff %'], ['pitches', 'Pitches seen']].map(([v, l]) => `<option value="${v}" ${ui.zm === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="chart-box" style="max-width:340px" id="zbox">${zoneChart(rows, ui.zm, 'hit')}</div><p class="muted small" style="text-align:center;margin:4px 0 0">Catcher's view · red = better for the hitter</p></div>
    <div class="panel"><div class="panel-h"><h2>Exit velo &amp; launch angle</h2><span class="note">Shaded box = 95+ mph at 8°–32°</span></div>${evlaChart(rows)}
      <div class="legend">${['1B', '2B', '3B', 'HR', 'OUT'].map(k => `<span><i style="background:${RES_COLOR[k]}"></i>${k === 'OUT' ? 'Out / other' : RES_NAME[k]}</span>`).join('')}</div></div>
  </section>
  ${playerExecution(i, se, me)}
  <section><div class="panel-h"><h2>Splits</h2><span class="note">${esc(se.label)}</span></div>
    ${table('t-ph-split', [{ k: 'name', label: 'Split', l: true }, C.PA, C.avg, C.obp, C.slg, C.woba, C.xwoba, C.kPct, C.bbPct, C.whiff, C.chase, C.avgEV, C.hhPct], splits, { nosort: true })}</section>
  <section><div class="panel-h"><h2>Game log</h2><span class="note">${esc(se.label)} · click a date for the pitch-by-pitch breakdown</span></div>
    ${table('t-ph-log', [{ k: 'd', label: 'Date', l: true, html: r => logLink(se, r, 'hit', i) }, { k: 'opp', label: 'Opp', l: true }, C.PA, C.AB, C.H, C['2B'], C.HR, C.BB, C.K, C.bbe, C.avgEV, C.maxEV, C.xwoba], glog, { sort: 'd', asc: false })}</section>`;
}

function playerExecution(i, se, me) {
  const ex = S.meta.execution?.[se.id];
  const row = ex?.rows.find(r => r.k === S.players[i].k);
  if (!row && !me.k2PA) return '';
  const goal = ex?.goal || {}, team = ex?.team || {};
  const tk = stats(se.rows.filter(r => isBC(S.players[r.h]?.t)));
  const lines = [{ name: '2K Win', mine: [me.k2W, me.k2PA], goal: null, team: [tk.k2W, tk.k2PA] }];
  for (const c of ex?.cats || []) if (row?.vals[c.key]?.[1]) lines.push({ name: c.label, mine: row.vals[c.key], goal: goal[c.key], team: team[c.key] });
  return `<section><div class="panel-h"><h2>Execution</h2><span class="note">${esc(se.label)}${ex?.updated ? ` · chart updated ${esc(fmtDate(ex.updated))}` : ''}</span></div>
    <div class="tbl-wrap"><table><thead><tr><th class="l nosort">Category</th><th class="nosort">${esc(niceName(S.players[i].n))}</th><th class="nosort">Team</th><th class="nosort">Goal</th></tr></thead><tbody>
    ${lines.map(l => `<tr><td class="l">${esc(l.name)}</td><td>${execCell(l.mine, l.goal)}</td><td>${l.team ? execCell(l.team, l.goal) : '<span class="muted">—</span>'}</td><td>${l.goal != null ? Math.round(l.goal * 100) + '%' : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}

function pitcherBody(i, p, seasons, ui, alt, hasNcaa) {
  const se = S.seasons[ui.season], rows = se.byP.get(i) || [];
  const T = seasonPitchers(se), meRow = T.rows.find(o => o.i === i) || { ...stats(rows), ...pitchShape(rows), q: false };
  const pool = T.rows.filter(o => o.q);
  function order(id) { return S.meta.seasons.findIndex(s => s.id === id); }
  const sCol = { k: 'name', label: 'Season', l: true, get: r => order(r.sid), html: r => esc(r.name) };
  const perSeason = seasons.map(s => { const a = S.seasons[s].byP.get(i) || []; return { ...stats(a), ...pitchShape(a), name: seasonLabel(s), sid: s }; });
  const allRows = seasons.flatMap(s => S.seasons[s].byP.get(i) || []);
  const all = { ...stats(allRows), ...pitchShape(allRows), _label: 'All seasons' };
  const ars = arsenal(rows);
  const types = ars.map(a => a.pt);
  if (!ui.active || ui.activeSeason !== ui.season) { ui.active = new Set(types); ui.activeSeason = ui.season; }
  ui.side = ui.side || 'all';
  const glog = gameLog(rows, se, 'p');
  const tot = rows.length;
  return `
  <section class="grid-pp">
    <div class="panel"><div class="panel-h"><h2>Percentile rankings</h2>${poolSwitch(hasNcaa)}</div>
      <p class="muted small" style="margin:-4px 0 10px">${esc(se.label)} · ${poolNote(alt, T, pool, 'BF', meRow)}</p>
      ${pctBars(PIT_PCT, meRow, pool, alt)}</div>
    <div class="panel"><div class="panel-h"><h2>Movement profile</h2><span class="note">${F.int(tot)} pitches · large dots = averages · dashed rings = expected for his arm slot &amp; velo</span></div>
      <div class="chart-box" id="mvbox">${movementChart(rows, ui.active)}</div>
      ${ptChips('pt-chips', types, ui.active, () => redrawPitcherCharts(rows, ui))}</div>
  </section>
  <section><div class="panel-h"><h2>Pitch arsenal</h2><span class="note">${esc(se.label)}</span></div>
    ${table('t-pp-ars', [{ k: 'pt', label: 'Pitch', l: true, html: r => `${ptDot(r.pt)}${PT[r.pt].n}`, get: r => PT_ORDER.indexOf(r.pt), asc: true },
      { k: 'n', label: '#', fmt: F.int }, { k: 'use', label: 'Usage%', fmt: F.pct }, { k: 'useR', label: 'vs RHH%', fmt: F.pct }, { k: 'useL', label: 'vs LHH%', fmt: F.pct },
      { k: 'v', label: 'Velo', fmt: F.f1 }, { k: 'vmax', label: 'Max', fmt: F.f1 }, { k: 'spin', label: 'Spin', fmt: F.int }, { k: 'ivb', label: 'IVB', fmt: F.f1 }, { k: 'hb', label: 'HB', fmt: F.f1 }, ...XMOV_COLS,
      { k: 'vaa', label: 'VAA', fmt: F.f1 }, { k: 'rh', label: 'Rel Ht', fmt: F.f1 }, { k: 'ext', label: 'Ext', fmt: F.f1 },
      { k: 'whiff', label: 'Whiff%', fmt: F.pct }, { k: 'csw', label: 'CSW%', fmt: F.pct }, { k: 'chase', label: 'Chase%', fmt: F.pct }, { k: 'zone', label: 'Zone%', fmt: F.pct },
      { k: 'putaway', label: 'PutAway%', fmt: F.pct }, { k: 'PA', label: 'PA', fmt: F.int }, { k: 'ba', label: 'BA', fmt: F.avg }, { k: 'xba', label: 'xBA', fmt: F.avg }, { k: 'avgEV', label: 'EV', fmt: F.f1 }, { k: 'xwoba', label: 'xwOBA', fmt: F.avg }],
      ars, { sort: 'n' })}</section>
  ${swingTakeChart(rows, se.rows.filter(r => !r.nt), 'pit')}
  <section><div class="panel-h"><h2>Pitching</h2></div>${table('t-pp-std', [sCol, ...PIT_VIEWS.standard[1]], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>
  <section><div class="panel-h"><h2>Stuff, command &amp; contact</h2></div>${table('t-pp-sc', [sCol, C.fbVelo, C.fbMax, C.fbSpin, C.fbIVB, C.ext, C.zone, C.chase, C.whiff, C.csw, C.fpStrike, C.avgEV, C.hhPct, C.brlPct, C.gbPct, C.xba, C.xwoba], perSeason, { sort: 'name', asc: true, total: seasons.length > 1 ? all : null })}</section>
  <section class="grid2">
    <div class="panel"><div class="panel-h"><h2>Pitch locations</h2>
      ${segmented('loc-side', [['all', 'All'], ['R', 'vs RHH'], ['L', 'vs LHH']], ui.side, v => { ui.side = v; redrawPitcherCharts(rows, ui); $$('#loc-side button').forEach(b => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-pressed', b.dataset.v === v); }); })}</div>
      <div class="chart-box" style="max-width:340px" id="locbox">${locationChart(ui.side === 'all' ? rows : rows.filter(r => r.bs === ui.side), ui.active)}</div>
      <p class="muted small" style="text-align:center;margin:4px 0 0">Pitcher's view · filter pitch types with the chips above</p></div>
    <div class="panel"><div class="panel-h"><h2>Release point</h2></div><div class="chart-box" style="max-width:440px" id="relbox">${releaseChart(rows, ui.active)}</div></div>
  </section>
  <section class="panel"><div class="panel-h"><h2>Pitch mix by count</h2><span class="note">Bar width = share of pitches; number = pitches</span></div>${usageByCount(rows)}
    <div class="legend">${types.map(k => `<span><i style="background:${PT[k].c}"></i>${PT[k].n}</span>`).join('')}</div></section>
  <section class="panel"><div class="panel-h"><h2>Velocity by outing</h2><span class="note">${esc(se.label)}</span></div>${veloTrend(rows)}</section>
  <section><div class="panel-h"><h2>Game log</h2><span class="note">${esc(se.label)} · click a date for the pitch-by-pitch breakdown</span></div>
    ${table('t-pp-log', [{ k: 'd', label: 'Date', l: true, html: r => logLink(se, r, 'pit', i) }, { k: 'opp', label: 'Opp', l: true }, C.ip, C.PA, C.pitches, C.H, C.BB, C.K, C.runs, C.whiff, C.csw, C.fbVelo, { k: 'maxVelo', label: 'Max Velo', fmt: F.f1 }, C.xwoba], glog, { sort: 'd', asc: false })}</section>`;
}
function redrawPitcherCharts(rows, ui) {
  const mv = $('#mvbox'), lb = $('#locbox'), rb = $('#relbox');
  if (mv) mv.innerHTML = movementChart(rows, ui.active);
  if (lb) lb.innerHTML = locationChart(ui.side === 'all' ? rows : rows.filter(r => r.bs === ui.side), ui.active);
  if (rb) rb.innerHTML = releaseChart(rows, ui.active);
  $$('#pt-chips .chip').forEach(b => { const on = ui.active.has(b.dataset.k); b.classList.toggle('off', !on); b.setAttribute('aria-pressed', on); });
}
function bindPlayer(i, p, role, ui) {
  const zm = $('#zm');
  if (zm) zm.onchange = () => { ui.zm = zm.value; const se = S.seasons[ui.season]; $('#zbox').innerHTML = zoneChart(se.byH.get(i) || [], ui.zm, 'hit'); };
}
/* ---------- video (AWRE / TruMedia links) ---------- */
// Clips are links only; the video itself streams from AWRE / TruMedia.
const clipsOf = r => (r.vid != null ? S.seasons[r.sid]?.clips[r.vid] : null) || [];
// Camera angles shown for a pitch, in this order:
//   CF · High Home · the open side for the player being viewed
//   hitters:  LHH Open (lefty) / RHH Open (righty), from the batter's side on that pitch
//   pitchers: LHP Open (lefty) / RHP Open (righty)
// Every other angle (broadcast, "All", the other side) is left out; missing angles are skipped.
function pickAngles(clips, r, role) {
  const name = c => String(c.l || '').toLowerCase();
  const isCF = c => /center|\bcf\b/.test(name(c));
  const isHome = c => /home ?plate|high home|\bhome\b|\bhh\b/.test(name(c)) && !/handed/.test(name(c));
  const hand = role === 'pit' ? (r.th === 'L' ? 'L' : r.th === 'R' ? 'R' : null) : (r.bs === 'L' ? 'L' : r.bs === 'R' ? 'R' : null);
  const who = role === 'pit' ? 'pitcher' : 'hitter', ab = role === 'pit' ? 'p' : 'h';
  const isOpen = c => hand && (new RegExp(`${hand === 'L' ? 'left' : 'right'}[ -]?handed ${who}`).test(name(c)) || new RegExp(`\\b${hand.toLowerCase()}h${ab}\\b`).test(name(c)));
  const out = [];
  const add = (test, label, key) => { const c = clips.find(test); if (c) out.push({ ...c, l: label, k: key }); };
  add(isCF, 'CF', 'cf');
  add(isHome, 'High Home', 'home');
  add(isOpen, `${hand}${role === 'pit' ? 'HP' : 'HH'} Open`, 'open');
  return out;
}
const pitchClips = (r, role = 'hit') => pickAngles(clipsOf(r).filter(c => !c.a), r, role);
const paClips = (rs, role = 'hit') => rs.flatMap(r => pickAngles(clipsOf(r).filter(c => c.a), r, role));
function vbtn(items, label, cls = 'vbtn') {
  if (!items.length) return '';
  S.vreg = S.vreg || [];
  S.vreg.push(items);
  return `<button type="button" class="${cls}" data-v="${S.vreg.length - 1}" aria-label="${esc(label || 'Play video')}">${label ? `<span aria-hidden="true">▶</span> ${esc(label)}` : '▶'}</button>`;
}
// one queue item per pitch (all camera angles), at-bat clips first
function paQueue(rs, title, role = 'hit') {
  const out = [], whole = paClips(rs, role);
  if (whole.length) out.push({ t: `${title} · whole at-bat`, clips: whole });
  rs.forEach((r, k) => { const c = pitchClips(r, role); if (c.length) out.push({ t: `${title} · pitch ${k + 1}: ${r.b}-${r.s} ${PT[r.pt]?.n || ''} ${r.v != null ? F.f1(r.v) + ' mph' : ''} · ${pitchDesc(r)}`, clips: c }); });
  return out;
}
function embedOf(u) {
  let m;
  if (/\.(mp4|webm|mov|m4v|m3u8)(\?|#|$)/i.test(u)) return { kind: 'video', src: u };
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/))) return { kind: 'frame', src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0&playsinline=1` };
  if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/))) return { kind: 'frame', src: `https://player.vimeo.com/video/${m[1]}?autoplay=1` };
  if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/))) return { kind: 'frame', src: `https://drive.google.com/file/d/${m[1]}/preview` };
  return { kind: 'page', src: u };   // AWRE / TruMedia player page
}
// AWRE clips are HLS streams (.m3u8): Safari/iPhone play them natively; other browsers use hls.js,
// loaded the first time a clip is opened.
const isHls = u => /\.m3u8(\?|#|$)/i.test(u || '');
let hlsLib = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLib) hlsLib = new Promise((ok, bad) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/hls.min.js';   // hls.js 1.5.13 (Apache-2.0), bundled with the site
    sc.onload = () => ok(window.Hls); sc.onerror = () => { hlsLib = null; bad(new Error('could not load the video player')); };
    document.head.appendChild(sc);
  });
  return hlsLib;
}
function playHls(v, src, speed, dlg) {
  const fail = msg => { const st = $('.vm-stage', dlg); if (st) st.insertAdjacentHTML('beforeend', `<div class="vm-msg">${esc(msg)} Use <b>Open ↗</b> to watch it on AWRE.</div>`); };
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; v.playbackRate = speed; return; }
  loadHls().then(Hls => {
    if (!Hls || !Hls.isSupported()) return fail('This browser can\'t play this clip here.');
    const h = new Hls(); S.hls = h;
    h.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      console.warn('HLS error', d.type, d.details);
      setTimeout(() => { h.destroy(); if (S.hls === h) S.hls = null; }, 0);   // not inside hls.js's own event
      const code = d.response && d.response.code;
      const why = code === 0 || code === undefined && /Load(Error|TimeOut)/.test(d.details || '') ? 'AWRE\'s server blocked this browser (no CORS permission).'
        : code === 403 || code === 401 ? 'AWRE refused the link (HTTP ' + code + ' — it may have expired).'
        : code === 404 ? 'AWRE no longer has this clip (HTTP 404).' : '';
      fail('This clip couldn\'t be loaded here. ' + why + ' [' + (d.details || d.type) + (code !== undefined ? ' · ' + code : '') + ']');
    });
    h.loadSource(src); h.attachMedia(v);
    h.on(Hls.Events.MANIFEST_PARSED, () => { v.playbackRate = speed; v.play().catch(() => {}); });
  }).catch(err => fail(err.message + '.'));
}
function openVideo(queue, start = 0) {
  if (!queue.length) return;
  let dlg = $('#vmodal');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'vmodal'; dlg.className = 'vmodal'; dlg.tabIndex = -1;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { if (S.hls) { S.hls.destroy(); S.hls = null; } dlg.innerHTML = ''; });
  }
  let at = start;
  const speedKey = 'vspeed', angleKey = 'vangle';
  const halves = [];   // [label, first index] for "Top 1", "Bot 1", ... when the queue spans innings
  queue.forEach((q, k) => { const m = /^(Top|Bot) \d+/.exec(q.t || ''); if (m && (!halves.length || halves[halves.length - 1][0] !== m[0])) halves.push([m[0], k]); });
  const jump = halves.length > 1;
  const draw = () => {
    const item = queue[at], clips = item.clips;
    const want = ls.get(angleKey, null);
    const ci = Math.max(0, clips.findIndex(c => (c.k || c.l) === want));
    const c = clips[ci], e = embedOf(c.u);
    const speed = +ls.get(speedKey, 1) || 1;
    dlg.innerHTML = `<div class="vm-in">
      <div class="vm-top"><div class="vm-title">${esc(item.t || 'Video')}</div>
        ${jump ? `<select class="vm-jump" aria-label="Jump to inning">${halves.map(([l, k], n) => `<option value="${k}" ${k <= at && (halves[n + 1]?.[1] ?? Infinity) > at ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
        <span class="vm-count muted small">${queue.length > 1 ? `${at + 1} of ${queue.length}` : ''}</span>
        <button type="button" class="vm-x" aria-label="Close">✕</button></div>
      <div class="vm-stage">${e.kind === 'video'
        ? (isHls(e.src) ? `<video controls autoplay playsinline preload="auto"></video>` : `<video src="${esc(e.src)}" controls autoplay playsinline preload="auto"></video>`)
        : `<iframe src="${esc(e.src)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`}</div>
      <div class="vm-bar">
        <div class="vm-angles">${clips.length > 1 ? clips.map((x, k) => `<button type="button" class="chip ${k === ci ? 'on' : ''}" data-angle="${esc(x.k || x.l)}">${esc(x.l)}</button>`).join('') : `<span class="muted small">${esc(c.l)}</span>`}</div>
        ${e.kind === 'video' ? `<div class="vm-speed">${[0.25, 0.5, 1].map(v => `<button type="button" class="chip ${v === speed ? 'on' : ''}" data-speed="${v}">${v === 1 ? '1×' : v + '×'}</button>`).join('')}</div>` : ''}
        <div class="vm-nav">${queue.length > 1 ? `<button type="button" class="btn" data-step="-1" ${at ? '' : 'disabled'}>‹ Prev</button><button type="button" class="btn" data-step="1" ${at < queue.length - 1 ? '' : 'disabled'}>Next ›</button>` : ''}
          <a class="btn" href="${esc(c.u)}" target="_blank" rel="noopener">Open ↗</a></div>
      </div>
      <p class="vm-src muted small">${esc(c.s || '')}${e.kind === 'page' ? ' · if the clip doesn\'t show here, use Open ↗ (you may need to be signed in to ' + esc(c.s === 'TruMedia' ? 'TruMedia' : 'AWRE') + ')' : ''}</p>
    </div>`;
    const v = $('video', dlg);
    if (S.hls) { S.hls.destroy(); S.hls = null; }
    if (v && isHls(e.src)) playHls(v, e.src, speed, dlg);
    if (v) {
      v.playbackRate = speed;
      v.addEventListener('ended', () => { if (at < queue.length - 1) { at++; draw(); } });
    }
    $('.vm-x', dlg).onclick = () => dlg.close();
    $$('[data-angle]', dlg).forEach(b => b.onclick = () => { ls.set(angleKey, b.dataset.angle); draw(); });
    $$('[data-speed]', dlg).forEach(b => b.onclick = () => { ls.set(speedKey, b.dataset.speed); draw(); });
    $$('[data-step]', dlg).forEach(b => b.onclick = () => { at = Math.max(0, Math.min(queue.length - 1, at + +b.dataset.step)); draw(); });
    const jm = $('.vm-jump', dlg); if (jm) jm.onchange = () => { at = +jm.value; draw(); };
    if (dlg.open && !dlg.contains(document.activeElement)) dlg.focus({ preventScroll: true });   // keep arrow keys working
  };
  dlg.onkeydown = e => {
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight' && at < queue.length - 1) { at++; draw(); }
    if (e.key === 'ArrowLeft' && at > 0) { at--; draw(); }
  };
  draw();
  if (!dlg.open) { dlg.showModal(); dlg.focus({ preventScroll: true }); }   // not the inning menu, so arrow keys step pitches
}
function initVideo() {
  document.addEventListener('click', e => {
    const b = e.target.closest?.('[data-v]');
    if (!b) return;
    e.preventDefault();
    openVideo(S.vreg?.[+b.dataset.v] || [], +(b.dataset.start || 0));
  });
}
function clipList(clips, titleOf) {
  return `<ul class="clip-list">${clips.map(c => `<li><span class="clip-d">${esc(c.d ? fmtDate(c.d, true) : '')}</span><span class="clip-t">${esc(titleOf(c))}</span>${vbtn([{ t: `${titleOf(c)}${c.d ? ' · ' + fmtDate(c.d, true) : ''}`, clips: [c] }], c.l)}</li>`).join('')}</ul>`;
}
async function pageVideo() {
  setNav('video');
  const V = S.meta.video || {}, other = V.other || [];
  await Promise.all(S.meta.seasons.map(s => loadSeason(s.id)));
  const games = [];
  for (const s of [...S.meta.seasons].reverse()) {
    const se = S.seasons[s.id];
    se.games.forEach((g, gi) => {
      const n = se.rows.filter(r => r.g === gi && r.vid != null).length;
      if (n || g.vid) games.push({ se, g, gi, n });
    });
  }
  games.sort((a, b) => b.g.d.localeCompare(a.g.d));
  const plist = Object.entries(V.players || {}).map(([k, c]) => ({ i: S.pidx.get(k), c })).filter(o => o.i != null)
    .sort((a, b) => S.players[a.i].n.localeCompare(S.players[b.i].n));
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">AWRE · TruMedia</span><h1>Video</h1></div></div>
    <section class="panel"><div class="panel-h"><h2>Games with video</h2><span class="note">Open a game, or a player's game page, to watch pitch by pitch</span></div>
      ${games.length ? `<ul class="clip-list">${games.map(o => `<li><span class="clip-d">${esc(fmtDate(o.g.d, true))}</span><span class="clip-t"><a href="#game-${o.se.id}-${o.gi}">${o.g.opp ? `BC ${o.g.home ? 'vs' : '@'} ${esc(teamName(o.g.opp))}` : 'Intrasquad'}</a>${o.n ? ` <span class="muted small">${F.int(o.n)} pitch${o.n === 1 ? '' : 'es'} with video</span>` : ''}</span>${(o.g.vid || []).map(c => vbtn([{ t: `${fmtDate(o.g.d, true)} full game`, clips: o.g.vid }], c.l)).slice(0, 1).join('')}</li>`).join('')}</ul>` : '<p class="empty">No game video matched yet.</p>'}</section>
    ${plist.length ? `<section class="panel"><div class="panel-h"><h2>Player video</h2><span class="note">Bullpens, BP and other clips tagged to a player</span></div>
      ${plist.map(o => `<h3 class="clip-h">${plink(o.i)}</h3>${clipList(o.c, c => c.t || 'Clip')}`).join('')}</section>` : ''}
    ${other.length ? `<section class="panel"><div class="panel-h"><h2>Practice and other video</h2></div>${clipList(other, c => c.t || 'Clip')}</section>` : ''}`;
}

/* ---------- Swing / Take run value (Savant-style) ---------- */
const AZ = [
  { k: 0, name: 'Heart', fill: 'var(--az-heart)', soft: 'var(--az-heart-soft)' },
  { k: 1, name: 'Shadow', fill: 'var(--az-shadow)', soft: 'var(--az-shadow-soft)' },
  { k: 2, name: 'Chase', fill: 'var(--az-chase)', soft: 'var(--az-chase-soft)' },
  { k: 3, name: 'Waste', fill: 'var(--az-waste)', soft: 'var(--az-waste-soft)' },
];
// role 'hit': runs for the hitter; role 'pit': runs saved by the pitcher (sign flipped)
function attackSummary(rows, role) {
  const sg = role === 'pit' ? -1 : 1;
  const z = AZ.map(a => ({ ...a, n: 0, sw: 0, tk: 0, rvSw: 0, rvTk: 0 }));
  let n = 0;
  for (const r of rows) {
    if (r.nt || r.az == null || r.c === 'IB' || r.c === 'U') continue;
    const o = z[r.az]; o.n++; n++;
    if (r.sw) { o.sw++; o.rvSw += sg * (r.rv || 0); } else { o.tk++; o.rvTk += sg * (r.rv || 0); }
  }
  return { z, n, rvSw: sum(z.map(o => o.rvSw)), rvTk: sum(z.map(o => o.rvTk)) };
}
function swingTakeChart(rows, leagueRows, role, title, minN = 20, decSe = null) {
  const me = attackSummary(rows, role), lg = attackSummary(leagueRows, role);
  if (me.n < minN) return '';
  const tot = me.rvSw + me.rvTk;
  const runsTxt = v => `${fmtRV(v)} Run${Math.abs(+v.toFixed(1)) === 1 ? '' : 's'}`;
  // --- zone diagram (catcher's view for hitters, pitcher's view for pitchers; symmetric either way)
  const W1 = 270, H1 = 330, cx = 135;
  const box = (hw, hh, fill, cls = '') => `<rect class="${cls}" x="${cx - hw}" y="${165 - hh}" width="${2 * hw}" height="${2 * hh}" fill="${fill}"/>`;
  const zr = me.z.map(o => o.rvSw + o.rvTk);
  let g1 = box(128, 152, 'var(--az-waste-soft)') + box(106, 124, 'var(--az-chase-soft)') + box(72, 88, 'var(--az-shadow-soft)') + box(30, 38, 'var(--az-heart-soft)');
  g1 += `<rect x="${cx - 50}" y="${165 - 60}" width="100" height="120" fill="none" stroke="var(--ink)" stroke-width="3" stroke-dasharray="1 6" stroke-linecap="round"/>`;
  const lab = (y, t, big) => `<text x="${cx}" y="${y}" text-anchor="middle" class="az-lab${big ? ' big' : ''}">${t}</text>`;
  const zd = decSe ? AZ.map(a => decisionStats(decSe, rows.filter(r => r.az === a.k))) : null;
  const zt = k => (zd ? (zd[k].n ? `${zd[k].good}/${zd[k].n} good` : '—') : runsTxt(zr[k]));
  g1 += lab(34, zt(3)) + lab(64, zt(2)) + lab(98, zt(1)) + lab(171, zt(0), 1);
  g1 += `<text x="${cx}" y="${H1 - 8}" text-anchor="middle" class="az-sub">Strike zone (dotted)</text>`;
  // --- three blocks: frequency · swing/take · run value (side by side on desktop, stacked on phones)
  const rowH = 66, top = 44, Hb = top + rowH * 4 + 44;
  const stripe = (o, y, w) => `<rect x="0" y="${y - 2}" width="5" height="${rowH - 14}" rx="2" fill="${o.fill}"/>`;
  let gA = `<text x="150" y="20" text-anchor="middle" class="az-h">Pitch frequency</text>`;
  let gB = `<text x="132" y="20" text-anchor="end" class="az-h">Swing</text><text x="148" y="20" class="az-h">Take</text><line x1="140" x2="140" y1="28" y2="${Hb - 30}" class="az-axis"/>`;
  let gC = `<text x="135" y="20" text-anchor="middle" class="az-h">Run value</text><line x1="135" x2="135" y1="28" y2="${Hb - 30}" class="az-axis"/>`;
  const maxRV = Math.max(1, ...me.z.flatMap(o => [Math.abs(o.rvSw), Math.abs(o.rvTk)])), rvK = 82 / maxRV, half = 92, cB = 140, cC = 135;
  me.z.forEach((o, k) => {
    const L = lg.z[k], y = top + k * rowH, mid = y + rowH / 2 - 8, pct = me.n ? o.n / me.n : 0, lpct = lg.n ? L.n / lg.n : 0;
    const swp = o.n ? o.sw / o.n : 0, lsw = L.n ? L.sw / L.n : 0;
    // A: zone name, count, circle (area ~ share), share (league)
    gA += `<rect x="0" y="${y - 2}" width="86" height="${rowH - 14}" rx="3" fill="${o.soft}"/><text x="43" y="${mid + 5}" text-anchor="middle" class="az-name">${o.name}</text>
      <text x="128" y="${mid + 5}" text-anchor="end" class="az-num">${F.int(o.n)}</text>
      <circle cx="165" cy="${mid}" r="${(5 + 22 * Math.sqrt(pct)).toFixed(1)}" fill="${o.fill}" stroke="var(--ink)" stroke-opacity=".25"/>
      <text x="200" y="${mid + 5}" class="az-num">${Math.round(pct * 100)}% <tspan class="az-muted">(${Math.round(lpct * 100)}%)</tspan></text>`;
    // B: swing / take split, player (solid) and league (dashed)
    const by = y + 10;
    gB += stripe(o, y) + `<text x="${cB - 4}" y="${by - 3}" text-anchor="end" class="az-tiny">${F.int(o.sw)}</text><text x="${cB + 4}" y="${by - 3}" class="az-tiny">${F.int(o.tk)}</text>
      <rect x="${cB - half * swp}" y="${by}" width="${half * swp}" height="14" fill="${o.fill}"/><rect x="${cB}" y="${by}" width="${half * (1 - swp)}" height="14" fill="${o.soft}"/>
      <text x="${cB - half * swp - 4}" y="${by + 11}" text-anchor="end" class="az-num">${Math.round(swp * 100)}%</text><text x="${cB + half * (1 - swp) + 4}" y="${by + 11}" class="az-num">${Math.round((1 - swp) * 100)}%</text>
      <line x1="${cB - half * lsw}" x2="${cB}" y1="${by + 25}" y2="${by + 25}" class="az-lg-sw"/><line x1="${cB}" x2="${cB + half * (1 - lsw)}" y1="${by + 25}" y2="${by + 25}" class="az-lg-tk"/>
      <text x="${cB - half * lsw - 4}" y="${by + 29}" text-anchor="end" class="az-tiny az-muted">${Math.round(lsw * 100)}%</text><text x="${cB + half * (1 - lsw) + 4}" y="${by + 29}" class="az-tiny az-muted">${Math.round((1 - lsw) * 100)}%</text>`;
    // C: swing runs (top bar) and take runs (bottom bar)
    const bar = (v, yy, cls, label) => {
      const w = v * rvK, x0 = w >= 0 ? cC : cC + w;
      return `<rect x="${x0.toFixed(1)}" y="${yy}" width="${Math.abs(w).toFixed(1)}" height="13" class="${cls}"/>
        <text x="${w >= 0 ? cC - 5 : cC + 5}" y="${yy + 11}" text-anchor="${w >= 0 ? 'end' : 'start'}" class="az-num">${label}${fmtRV(v)}</text>`;
    };
    gC += stripe(o, y) + bar(o.rvSw, y + 6, 'az-rv-sw', k === 0 ? 'Swing ' : '') + bar(o.rvTk, y + 27, 'az-rv-tk', k === 0 ? 'Take ' : '');
  });
  const yb = top + rowH * 4 + 8;
  gA += `<text x="150" y="${yb + 10}" text-anchor="middle" class="az-tiny az-muted">${F.int(me.n)} pitches (league in parentheses)</text>`;
  gB += `<text x="${cB - 4}" y="${yb + 10}" text-anchor="end" class="az-tiny">${F.int(sum(me.z.map(o => o.sw)))}</text><text x="${cB + 4}" y="${yb + 10}" class="az-tiny">${F.int(sum(me.z.map(o => o.tk)))}</text>
    <line x1="${cB - 70}" x2="${cB - 40}" y1="${yb + 26}" y2="${yb + 26}" class="az-lg-sw"/><text x="${cB - 34}" y="${yb + 30}" class="az-tiny az-muted">League avg</text>`;
  gC += `<text x="${cC}" y="${yb + 12}" text-anchor="middle" class="az-tot az-sw-t">${fmtRV(me.rvSw)} Swing runs</text>
    <text x="${cC}" y="${yb + 30}" text-anchor="middle" class="az-tot az-tk-t">${fmtRV(me.rvTk)} Take runs</text>`;
  return `<section class="panel az-panel"><div class="panel-h"><h2>${esc(title || 'Swing / Take')}</h2>
      ${decSe ? '' : `<span class="note">${role === 'pit' ? 'Runs saved by the pitcher' : 'Runs added by the hitter'} · <b class="az-big ${tot >= 0 ? 'pos' : 'neg'}">${fmtRV(tot)} run value</b></span>`}</div>
    <div class="az-grid"><div class="az-zone">${svg(W1, H1, g1, decSe ? 'Good decisions by attack zone' : 'Run value by attack zone')}</div>
      <div class="az-rows">${svg(290, Hb, gA, 'Pitch frequency by attack zone')}${svg(280, Hb, gB, 'Swing and take rates by attack zone')}${decSe ? '' : svg(270, Hb, gC, 'Swing and take run value by attack zone')}</div></div>
    <p class="muted small" style="margin:6px 0 0">Attack zones follow Baseball Savant: heart = middle of the zone, shadow = the edges (about a ball's width in and out), chase = just off the plate, waste = well off it. League = every ${role === 'pit' ? 'pitcher' : 'hitter'} in this season's data. ${decSe ? 'Good decisions: swinging or taking, whichever is the better choice for that zone and count.' : 'Run values come from the count and base-out run value matrix.'}</p>
  </section>`;
}
function decisionPanel(rows, se, i) {
  const st = stats(rows);
  if (!st.rvPitches) return '';
  const grade = rvGrade(se, rows, false);
  const me = attackSummary(rows, 'hit'), lg = attackSummary(se.rows.filter(r => !r.nt), 'hit');
  const zrows = me.z.map((o, k) => ({ name: o.name, k, n: o.n, pct: me.n ? o.n / me.n : null, lpct: lg.n ? lg.z[k].n / lg.n : null,
    swPct: o.n ? o.sw / o.n : null, lsw: lg.z[k].n ? lg.z[k].sw / lg.z[k].n : null, rvSw: o.rvSw, rvTk: o.rvTk, rv: o.rvSw + o.rvTk }));
  const tile = (v, l, tip) => `<div class="tile"${tip ? ` data-tip="${esc(tip)}"` : ''}><div class="tile-v">${v}</div><div class="tile-l">${l}</div></div>`;
  return `<section class="panel"><div class="panel-h"><h2>Swing / Take run value</h2><span class="note">${F.int(st.rvPitches)} pitches · ${esc(se.label)}</span></div>
    <div class="strip pg-strip" style="margin-bottom:12px">
      ${tile(grade == null ? '—' : Math.round(grade), 'Swing/Take grade (20–80)', 'Run value per 100 pitches on the 20–80 scale: 50 = average hitter in this season\'s data, every 10 = one standard deviation (needs 40+ pitches)')}
      ${tile(fmtRV(st.rv), 'Run value', 'Swing runs + take runs')}
      ${tile(fmtRV(st.rvSwing), 'Swing runs', 'Run value of every pitch he swung at')}
      ${tile(fmtRV(st.rvTake), 'Take runs', 'Run value of every pitch he took')}
      ${tile(fmtRV(st.rv100, 2), 'Per 100 pitches')}
    </div>
    ${table('t-dec-' + i, [{ k: 'name', label: 'Region', l: true, get: r => r.k, html: r => `<span class="az-chip" style="background:${AZ[r.k].soft}">${r.name}</span>` },
      { k: 'n', label: 'Pitches', fmt: F.int }, { k: 'pct', label: 'Freq%', fmt: F.pct }, { k: 'lpct', label: 'Lg Freq%', fmt: F.pct },
      { k: 'swPct', label: 'Swing%', fmt: F.pct }, { k: 'lsw', label: 'Lg Swing%', fmt: F.pct },
      { k: 'rvSw', label: 'Swing runs', fmt: v => fmtRV(v) }, { k: 'rvTk', label: 'Take runs', fmt: v => fmtRV(v) }, { k: 'rv', label: 'Run value', fmt: v => fmtRV(v) }], zrows, { nosort: true })}
    <p class="muted small" style="margin:6px 0 0">Baseball Savant's Swing/Take method: every pitch gets a run value from what happened (ball, strike, foul, out, hit, home run): the change in run expectancy from the count and base-out state before the pitch to the state after it, plus any runs that scored. Those values are added up for the pitches he swung at and the pitches he took in each region. League = every hitter in this season's data.</p>
  </section>`;
}

/* ---------- player game breakdown (pitch by pitch) ---------- */
function logLink(se, r, role, i) {
  const gm = se.games[r.g];
  if (gm.nt) return `<a href="#game-${se.id}-${r.g}" title="Results-only game">${esc(fmtDate(r.d))}</a>`;
  const hasV = (role === 'hit' ? se.byH.get(i) : se.byP.get(i) || []).some(x => x.g === r.g && x.vid != null);
  return `<a href="#pg-${se.id}-${r.g}-${role}-${esc(S.players[i].k)}" class="loglink">${esc(fmtDate(r.d))}${hasV ? ' <span class="vtag" title="Video available">▶</span>' : ''} <span aria-hidden="true">›</span></a>`;
}
function groupPAs(rows) {
  const out = []; let cur = null, key = null;
  for (const r of rows) {
    const k = `${r.inn}|${r.top}|${r.pa}|${r.h}|${r.p}`;
    if (k !== key || !cur) { cur = { rows: [] }; out.push(cur); key = k; }
    cur.rows.push(r);
    if (r.r) { key = null; }   // PA ended on this pitch
  }
  return out;
}
function pitchDesc(r) { return r.r ? RES_NAME[r.r] || r.r : CALL_NAME[r.c] || '—'; }
function seqChart(pitches, catcher = false) {
  const W = 230, H = 250, sgn = catcher ? -1 : 1, X = v => 115 + sgn * v * 52, Y = v => 222 - (v - 0.2) * 52;
  let g = `<rect class="zone" x="${Math.min(X(-ZW), X(ZW))}" y="${Y(ZT)}" width="${Math.abs(X(ZW) - X(-ZW))}" height="${Y(ZB) - Y(ZT)}"/>`;
  for (let k = 1; k < 3; k++) {
    g += `<line class="grid" x1="${X(-ZW + k * 2 * ZW / 3)}" x2="${X(-ZW + k * 2 * ZW / 3)}" y1="${Y(ZT)}" y2="${Y(ZB)}"/>`;
    g += `<line class="grid" y1="${Y(ZB + k * (ZT - ZB) / 3)}" y2="${Y(ZB + k * (ZT - ZB) / 3)}" x1="${X(-ZW)}" x2="${X(ZW)}"/>`;
  }
  const pl = 115 - 0.71 * 52, pw = 1.42 * 52;
  g += catcher
    ? `<path class="plate" d="M${pl},${H - 18} h${pw} v5 l-${pw / 2},5 l-${pw / 2},-5 Z"/>`
    : `<path class="plate" d="M${pl},${H - 8} h${pw} v-5 l-${pw / 2},-5 l-${pw / 2},5 Z"/>`;
  pitches.forEach((r, n) => {
    if (r.px == null || r.pz == null) return;
    const x = X(Math.max(-2, Math.min(2, r.px))), y = Y(Math.max(0.1, Math.min(4.6, r.pz)));
    const cls = r.c === 'X' ? 'sq inplay' : r.wh ? 'sq whiff' : 'sq';
    g += `<g class="${cls}" data-tip="${esc(`<b>Pitch ${n + 1}</b> · ${r.b}-${r.s}<br>${esc(PT[r.pt].n)} ${F.f1(r.v)} mph<br>${esc(pitchDesc(r))}`)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${PT[r.pt].c}"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${n + 1}</text></g>`;
  });
  return svg(W, H, g, catcher ? 'Pitch sequence, catcher\'s view' : 'Pitch sequence, pitcher\'s view');
}
function paCard(se, pa, role, n) {
  const rs = pa.rows, last = rs[rs.length - 1], first = rs[0];
  const opp = role === 'hit' ? first.p : first.h;
  const oppHand = role === 'hit' ? (first.th ? `${first.th}HP` : '') : (first.bs ? `${first.bs}HH` : '');
  const outs = first.o != null ? `${first.o} out${first.o === 1 ? '' : 's'}` : '';
  const bb = rs.find(r => r.c === 'X' && r.ev != null);
  const res = last.r ? resBadge(last.r) : '<span class="muted small">No result recorded</span>';
  const vtitle = `${niceName(pname(first.h))} vs ${niceName(pname(first.p))}, ${first.top ? 'Top' : 'Bot'} ${first.inn}`;
  const vq = paQueue(rs, vtitle, role), hasV = rs.some(r => pitchClips(r, role).length);
  const showDec = false;   // per-pitch decisions are left off the pitch-by-pitch tables
  const pd = showDec && role === 'hit' ? decisionStats(se, rs) : null;
  const paDec = pd && pd.n ? `<span class="pa-dec small"><b class="${pd.good === pd.n ? 'dec-good' : ''}">${pd.good}/${pd.n}</b> good decisions</span>` : '';
  const rows = rs.map((r, k) => `<tr class="${r.r ? 'pa-end' : ''}">
      <td>${k + 1}</td><td>${r.b}-${r.s}</td>
      <td class="l">${ptDot(r.pt)}${esc(PT[r.pt].n)}</td>
      <td>${F.f1(r.v)}</td><td>${F.int(r.spin)}</td><td>${F.f1(r.ivb)}</td><td>${F.f1(r.hb)}</td>
      <td class="l">${r.iz == null ? '—' : r.iz ? 'Zone' : '<span class="muted">Out</span>'}</td>
      <td class="l">${r.r ? resBadge(r.r) : esc(CALL_NAME[r.c] || '—')}</td>${showDec ? decCell(se, r, role) : ''}
      <td>${r.c === 'X' ? F.f1(r.ev) : ''}</td><td>${r.c === 'X' ? F.f1(r.la) : ''}</td><td>${r.c === 'X' ? F.int(r.dist) : ''}</td>
      <td>${r.bat != null && r.sw ? F.f1(r.bat) : ''}</td>${hasV ? `<td>${pitchClips(r, role).length ? vbtn([{ t: `${vtitle} · pitch ${k + 1}: ${r.b}-${r.s} ${PT[r.pt]?.n || ''} · ${pitchDesc(r)}`, clips: pitchClips(r, role) }], '', 'vbtn vbtn-sm') : ''}</td>` : ''}</tr>`).join('');
  return `<article class="pa-card">
    <header class="pa-head">
      <span class="pa-n">${n}</span>
      <span class="pa-inn">${first.top ? 'Top' : 'Bot'} ${F.int(first.inn)}${outs ? ' · ' + outs : ''}</span>
      <span class="pa-vs">${role === 'hit' ? 'vs' : 'to'} ${plink(opp)} <span class="muted small">${esc(oppHand)}</span></span>
      <span class="pa-res">${res}${bb ? ` <span class="muted small">${F.f1(bb.ev)} mph · ${F.f1(bb.la)}°${bb.dist != null ? ' · ' + F.int(bb.dist) + ' ft' : ''}${bb.xw != null ? ' · xwOBA ' + F.avg(bb.xw) : ''}</span>` : ''}</span>
      ${paDec}<span class="pa-pc muted small">${rs.length} pitch${rs.length === 1 ? '' : 'es'}</span>
      ${vq.length ? `<span class="pa-v">${vbtn(vq, 'Watch at-bat')}</span>` : ''}
    </header>
    <div class="pa-body">
      <div class="pa-zone">${seqChart(rs, role === 'hit')}</div>
      <div class="tbl-wrap pa-tbl"><table><thead><tr><th class="nosort">#</th><th class="nosort">Count</th><th class="l nosort">Pitch</th><th class="nosort">Velo</th><th class="nosort">Spin</th><th class="nosort">IVB</th><th class="nosort">HB</th><th class="l nosort">Loc</th><th class="l nosort">Result</th>${showDec ? `<th class="l nosort" title="${role === 'pit' ? 'Where the pitch was (attack zone) and whether the hitter swung' : 'Where the pitch was, swing or take, and whether it was the right decision'}">${role === 'pit' ? 'Zone · Swing/Take' : 'Decision'}</th>` : ''}<th class="nosort">EV</th><th class="nosort">LA</th><th class="nosort">Dist</th><th class="nosort">Bat Spd</th>${hasV ? '<th class="nosort">Video</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    </div>
  </article>`;
}
function veloByPitch(rows) {
  const pts = rows.map((r, n) => ({ n: n + 1, r })).filter(o => o.r.v != null);
  if (pts.length < 2) return '';
  const W = 560, H = 230, m = { l: 52, r: 12, t: 14, b: 34 };
  const xs = scale(1, pts[pts.length - 1].n, m.l, W - m.r, 8), vv = pts.map(o => o.r.v);
  const ys = scale(Math.floor(Math.min(...vv)) - 1, Math.ceil(Math.max(...vv)) + 1, H - m.b, m.t, 5);
  let g = scatterFrame(W, H, m, xs, ys, 'Pitch # in game', 'Velo (mph)', v => v, v => (Number.isInteger(v) ? v : v.toFixed(1)));
  const by = {}; pts.forEach(o => (by[o.r.pt] = by[o.r.pt] || []).push(o));
  for (const k of Object.keys(by)) {
    const a = by[k];
    if (a.length > 1) g += `<path d="M${a.map(o => `${xs.f(o.n).toFixed(1)},${ys.f(o.r.v).toFixed(1)}`).join(' L')}" fill="none" stroke="${PT[k].c}" stroke-width="1.5" stroke-opacity=".5"/>`;
    g += a.map(o => `<circle cx="${xs.f(o.n).toFixed(1)}" cy="${ys.f(o.r.v).toFixed(1)}" r="4" fill="${PT[k].c}" stroke="var(--surface)" stroke-width="1.5" data-tip="${esc(`Pitch ${o.n} · ${esc(PT[k].n)} ${F.f1(o.r.v)} mph<br>${esc(pitchDesc(o.r))}`)}"/>`).join('');
  }
  return `<div class="panel"><div class="panel-h"><h2>Velocity by pitch</h2></div>${svg(W, H, g, 'Velocity by pitch number')}
    <div class="legend">${Object.keys(by).map(k => `<span><i style="background:${PT[k].c}"></i>${PT[k].n}</span>`).join('')}</div></div>`;
}
async function pagePlayerGame(sid, gi, role, key) {
  setNav('');
  const se = await loadSeason(sid), g = se.games[gi], i = S.pidx.get(key);
  if (!g || i == null) { app.innerHTML = '<p class="err">That game or player was not found.</p>'; return; }
  const p = S.players[i];
  const rows = se.rows.filter(r => r.g === gi && (role === 'hit' ? r.h === i : r.p === i));
  const opp = g.opp ? `${g.home ? 'vs' : '@'} ${teamName(g.opp)}` : 'Intrasquad';
  // prev / next games for this player in the season
  const mine = [...new Set((role === 'hit' ? se.byH.get(i) : se.byP.get(i) || []).filter(r => !se.games[r.g].nt).map(r => r.g))].sort((a, b) => a - b);
  const pos = mine.indexOf(gi), prev = mine[pos - 1], next = mine[pos + 1];
  const allQ = groupPAs(rows).flatMap(pa => paQueue(pa.rows, `${niceName(pname(pa.rows[0].h))} vs ${niceName(pname(pa.rows[0].p))}, ${pa.rows[0].top ? 'Top' : 'Bot'} ${pa.rows[0].inn}`, role));
  const allV = allQ.length ? vbtn(allQ, `Watch all (${allQ.length})`, 'btn vbtn-hi') : '';
  const nav = `<div class="controls">
    ${prev != null ? `<a class="btn" href="#pg-${sid}-${prev}-${role}-${esc(key)}">‹ ${esc(fmtDate(se.games[prev].d))}</a>` : ''}
    ${next != null ? `<a class="btn" href="#pg-${sid}-${next}-${role}-${esc(key)}">${esc(fmtDate(se.games[next].d))} ›</a>` : ''}
    <a class="btn" href="#game-${sid}-${gi}">Full game</a>${allV}</div>`;
  const head = `<div class="phead"><div><span class="eyebrow">${esc(fmtDate(g.d, true))} · ${esc(opp)} · ${role === 'hit' ? 'Hitting' : 'Pitching'}</span>
    <h1><a href="#player-${esc(key)}" class="plain">${p.num != null ? `<span class="jersey">#${esc(p.num)}</span>` : ''}${esc(niceName(p.n))}</a></h1></div>${nav}</div>`;
  if (!rows.length) { app.innerHTML = head + '<p class="empty">No tracked pitches for this player in this game.</p>'; return; }
  const st = stats(rows), pas = groupPAs(rows);
  let tiles, extra, decStrip = '';
  if (role === 'hit') {
    tiles = [[`${st.H}-${st.AB}`, 'H-AB'], [F.int(st.PA), 'PA'], [F.int(st.BB + st.HBP), 'BB + HBP'], [F.int(st.K), 'SO'], [F.int(st.pitches), 'Pitches seen'],
      [F.int(Math.round((st.swing || 0) * st.pitches)), 'Swings'], [F.int(Math.round((st.whiff || 0) * (st.swing || 0) * st.pitches)), 'Whiffs'], [F.pct(st.chase), 'Chase %'],
      [F.f1(st.maxEV), 'Max EV'], [F.avg(st.xwoba), 'xwOBA']];
    const ds = decisionStats(se, rows);
    if (ds.n) {
      decStrip = `<section class="panel dec-panel"><div class="panel-h"><h2>Swing / Take decisions this game</h2></div>
        <div class="strip">${[[F.pct(ds.pct) + "%", "Good decisions"], [`${ds.good}/${ds.n}`, 'Good / pitches'], [F.int(ds.badSw), 'Bad swings'], [F.int(ds.badTk), 'Bad takes']]
          .map(([v, l]) => `<div class="tile"><div class="tile-v">${v}</div><div class="tile-l">${l}</div></div>`).join('')}</div></section>
        ${swingTakeChart(rows, se.rows.filter(r => !r.nt), 'hit', 'Swing / Take by region', 1)}`;
    }
    extra = `<section class="grid2">
      <div class="panel"><div class="panel-h"><h2>Pitches seen</h2><span class="note">Catcher's view</span></div><div class="chart-box" style="max-width:340px">${locationChart(rows, new Set(PT_ORDER), true)}</div>
        <div class="legend">${[...new Set(rows.map(r => r.pt))].map(k => `<span><i style="background:${PT[k].c}"></i>${PT[k].n}</span>`).join('')}</div></div>
      <div class="panel"><div class="panel-h"><h2>Balls in play</h2></div><div class="chart-box">${sprayChart(rows)}</div></div></section>`;
  } else {
    const ps = pitchShape(rows), strikes = rows.filter(r => ['C', 'S', 'F', 'X'].includes(r.c)).length;
    tiles = [[F.ip(st.outs), 'IP'], [F.int(st.PA), 'Batters'], [F.int(st.pitches), 'Pitches'], [F.pct(strikes / rows.length), 'Strike %'], [F.int(st.K), 'SO'],
      [F.int(st.BB + st.HBP), 'BB + HBP'], [F.int(st.H), 'H'], [F.int(Math.round((st.whiff || 0) * (st.swing || 0) * st.pitches)), 'Whiffs'], [F.pct(st.csw), 'CSW %'], [F.f1(ps.maxVelo), 'Max velo']];
    const ars = arsenal(rows);
    extra = `<section><div class="panel-h"><h2>Pitch mix</h2></div>${table('t-pg-ars', [{ k: 'pt', label: 'Pitch', l: true, html: r => `${ptDot(r.pt)}${PT[r.pt].n}`, get: r => PT_ORDER.indexOf(r.pt), asc: true },
      { k: 'n', label: '#', fmt: F.int }, { k: 'use', label: 'Usage%', fmt: F.pct }, { k: 'v', label: 'Velo', fmt: F.f1 }, { k: 'vmax', label: 'Max', fmt: F.f1 }, { k: 'spin', label: 'Spin', fmt: F.int },
      { k: 'ivb', label: 'IVB', fmt: F.f1 }, { k: 'hb', label: 'HB', fmt: F.f1 }, ...XMOV_COLS, { k: 'ext', label: 'Ext', fmt: F.f1 }, { k: 'zone', label: 'Zone%', fmt: F.pct }, { k: 'whiff', label: 'Whiff%', fmt: F.pct },
      { k: 'csw', label: 'CSW%', fmt: F.pct }, { k: 'avgEV', label: 'EV', fmt: F.f1 }], ars, { sort: 'n' })}</section>
      <section class="grid2">
        <div class="panel"><div class="panel-h"><h2>Pitch locations</h2><span class="note">Pitcher's view</span></div><div class="chart-box" style="max-width:340px">${locationChart(rows, new Set(PT_ORDER))}</div>
          <div class="legend">${ars.map(a => `<span><i style="background:${PT[a.pt].c}"></i>${PT[a.pt].n}</span>`).join('')}</div></div>
        ${veloByPitch(rows)}</section>`;
  }
  app.innerHTML = head + `
    <div class="strip pg-strip">${tiles.map(([v, l]) => `<div class="tile"><div class="tile-v">${v}</div><div class="tile-l">${l}</div></div>`).join('')}</div>
    ${decStrip}${extra}
    <section><div class="panel-h"><h2>${role === 'hit' ? 'Every at-bat' : 'Every batter faced'}</h2><span class="note">Numbers on the zone match the pitch order · ${role === 'hit' ? 'catcher' : 'pitcher'}'s view · hover a pitch for details</span></div>
      <div class="pa-list">${pas.map((pa, n) => paCard(se, pa, role, n + 1)).join('')}</div></section>`;
}

function gameLog(rows, se, side) {
  const m = new Map(); rows.forEach(r => { if (!m.has(r.g)) m.set(r.g, []); m.get(r.g).push(r); });
  return [...m].map(([g, a]) => {
    const gm = se.games[g];
    return { g, d: gm.d, opp: gm.opp ? `${gm.home ? 'vs' : '@'} ${teamName(gm.opp)}` : 'Intrasquad', ...stats(a), ...(side === 'p' ? pitchShape(a) : {}) };
  });
}

/* ---------- pitch search ---------- */
async function pageSearch() {
  setNav('search');
  const se = await loadSeason(S.season);
  const f = S.ui.search || (S.ui.search = { pit: '', bat: '', pt: '', call: '', res: '', bs: '', th: '', count: '', minEV: '', team: 'bcp' });
  const opt = (arr, v) => arr.map(([k, l]) => `<option value="${esc(k)}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const pitchers = [...se.byP.keys()].filter(i => S.players[i].bc).sort((a, b) => pname(a).localeCompare(pname(b)));
  const batters = [...se.byH.keys()].filter(i => S.players[i].bc).sort((a, b) => pname(a).localeCompare(pname(b)));
  app.innerHTML = `
  <div class="phead"><div><span class="eyebrow">${esc(seasonLabel(S.season))}</span><h1>Pitch Search</h1></div>
    <div class="controls">${seasonSelect('sr-season', v => { setSeason(v); route(); })}</div></div>
  <form class="panel filters" id="sr-form">
    <label>Side<select name="team">${opt([['bcp', 'BC pitching'], ['bch', 'BC hitting'], ['all', 'All pitches']], f.team)}</select></label>
    <label>Pitcher<select name="pit"><option value="">Any</option>${opt(pitchers.map(i => [i, niceName(pname(i))]), f.pit)}</select></label>
    <label>Batter<select name="bat"><option value="">Any</option>${opt(batters.map(i => [i, niceName(pname(i))]), f.bat)}</select></label>
    <label>Pitch type<select name="pt"><option value="">Any</option>${opt(PT_ORDER.map(k => [k, PT[k].n]), f.pt)}</select></label>
    <label>Pitch result<select name="call"><option value="">Any</option>${opt([['S', 'Swinging strike'], ['C', 'Called strike'], ['B', 'Ball'], ['F', 'Foul'], ['X', 'In play'], ['sw', 'Any swing']], f.call)}</select></label>
    <label>PA result<select name="res"><option value="">Any</option>${opt([['hit', 'Any hit'], ['1B', 'Single'], ['2B', 'Double'], ['3B', 'Triple'], ['HR', 'Home run'], ['K', 'Strikeout'], ['BB', 'Walk'], ['OUT', 'Out in play'], ['end', 'Any PA-ending pitch']], f.res)}</select></label>
    <label>Batter side<select name="bs"><option value="">Any</option>${opt([['R', 'RHH'], ['L', 'LHH']], f.bs)}</select></label>
    <label>Pitcher hand<select name="th"><option value="">Any</option>${opt([['R', 'RHP'], ['L', 'LHP']], f.th)}</select></label>
    <label>Count<select name="count"><option value="">Any</option>${opt([['0-0', '0-0'], ['ahead', 'Pitcher ahead'], ['behind', 'Batter ahead'], ['2s', 'Two strikes'], ['3-2', 'Full count']], f.count)}</select></label>
    <label>Min exit velo<input name="minEV" type="number" min="0" max="130" value="${esc(f.minEV)}"></label>
  </form>
  <div id="sr-out"></div>`;
  const form = $('#sr-form');
  const run = () => {
    const fd = new FormData(form); for (const [k, v] of fd) f[k] = v;
    const res = se.rows.filter(r => {
      if (r.nt) return false;
      if (f.team === 'bcp' && !isBC(S.players[r.p].t)) return false;
      if (f.team === 'bch' && !isBC(S.players[r.h].t)) return false;
      if (f.pit !== '' && r.p !== +f.pit) return false;
      if (f.bat !== '' && r.h !== +f.bat) return false;
      if (f.pt && r.pt !== f.pt) return false;
      if (f.call === 'sw' ? !r.sw : f.call && r.c !== f.call) return false;
      if (f.res === 'hit' ? !['1B', '2B', '3B', 'HR'].includes(r.r) : f.res === 'end' ? !r.r : f.res && r.r !== f.res) return false;
      if (f.bs && r.bs !== f.bs) return false;
      if (f.th && r.th !== f.th) return false;
      if (f.count === '0-0' && !(r.b === 0 && r.s === 0)) return false;
      if (f.count === 'ahead' && !(r.s > r.b)) return false;
      if (f.count === 'behind' && !(r.b > r.s)) return false;
      if (f.count === '2s' && r.s !== 2) return false;
      if (f.count === '3-2' && !(r.b === 3 && r.s === 2)) return false;
      if (f.minEV !== '' && !(r.ev != null && r.ev >= +f.minEV)) return false;
      return true;
    });
    const st = stats(res);
    const show = res.slice(-400).reverse().map(r => ({ ...r, i: r.p }));
    $('#sr-out').innerHTML = `
      <div class="strip" style="margin-bottom:16px">
        <div class="tile"><div class="tile-v">${F.int(res.length)}</div><div class="tile-l">Pitches</div></div>
        <div class="tile"><div class="tile-v">${F.int(st.PA)}</div><div class="tile-l">PA ended</div></div>
        <div class="tile"><div class="tile-v">${F.avg(st.avg)}</div><div class="tile-l">AVG</div></div>
        <div class="tile"><div class="tile-v">${F.avg(st.xwoba)}</div><div class="tile-l">xwOBA</div></div>
        <div class="tile"><div class="tile-v">${F.pct(st.whiff)}</div><div class="tile-l">Whiff %</div></div>
        <div class="tile"><div class="tile-v">${F.f1(st.avgEV)}</div><div class="tile-l">Avg EV</div></div>
        <div class="tile"><div class="tile-v">${F.f1(mean(res.map(r => r.v).filter(x => x != null)))}</div><div class="tile-l">Avg Velo</div></div>
      </div>
      <div class="panel-h"><h2>Pitches</h2><span class="note">${res.length > 400 ? 'Showing the latest 400 · ' : ''}<button type="button" class="btn" id="sr-csv">Download CSV (${F.int(res.length)})</button></span></div>
      ${table('t-search', [
        { k: 'd', label: 'Date', l: true, html: r => `<a href="#game-${se.id}-${r.g}">${esc(fmtDate(r.d))}</a>` },
        { k: 'p', label: 'Pitcher', l: true, html: r => plink(r.p), get: r => pname(r.p) }, { k: 'h', label: 'Batter', l: true, html: r => plink(r.h), get: r => pname(r.h) },
        { k: 'inn', label: 'Inn', fmt: F.int }, { k: 'cnt', label: 'Count', get: r => `${r.b}-${r.s}` },
        { k: 'pt', label: 'Pitch', l: true, html: r => `${ptDot(r.pt)}${PT[r.pt].n}` }, { k: 'v', label: 'Velo', fmt: F.f1 }, { k: 'spin', label: 'Spin', fmt: F.int },
        { k: 'ivb', label: 'IVB', fmt: F.f1 }, { k: 'hb', label: 'HB', fmt: F.f1 }, { k: 'c', label: 'Pitch result', l: true, fmt: v => esc(CALL_NAME[v] || v) },
        { k: 'r', label: 'PA result', l: true, html: r => resBadge(r.r) }, { k: 'ev', label: 'EV', fmt: F.f1 }, { k: 'la', label: 'LA', fmt: F.f1 }, { k: 'dist', label: 'Dist', fmt: F.int }, { k: 'xw', label: 'xwOBA', fmt: F.avg }],
        show, { nosort: true })}`;
    $('#sr-csv').onclick = () => downloadCSV(res, se);
  };
  form.onchange = run; form.onsubmit = e => { e.preventDefault(); run(); };
  run();
}
function downloadCSV(rows, se) {
  const head = ['Date', 'Opponent', 'Pitcher', 'Batter', 'PitcherThrows', 'BatterSide', 'Inning', 'Balls', 'Strikes', 'PitchType', 'Velo', 'Spin', 'IVB', 'HB', 'RelHeight', 'RelSide', 'Extension', 'PlateX', 'PlateZ', 'PitchResult', 'PAResult', 'HitType', 'ExitVelo', 'LaunchAngle', 'Direction', 'Distance', 'xBA', 'xwOBA'];
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = rows.map(r => [r.d, teamName(se.games[r.g].opp) || 'Intrasquad', pname(r.p), pname(r.h), r.th, r.bs, r.inn, r.b, r.s, PT[r.pt].n, r.v, r.spin, r.ivb, r.hb, r.rh, r.rsd, r.ext, r.px, r.pz, CALL_NAME[r.c], RES_NAME[r.r] || '', HT_NAME[r.ht] || '', r.ev, r.la, r.dir, r.dist, r.xba, r.xw].map(q).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `birdballsavant-${se.id}-search.csv`; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- glossary & data ---------- */
function pageGlossary() {
  setNav('glossary');
  const g = [
    ['xBA / xSLG / xwOBA', 'Expected batting average, slugging and wOBA. Each tracked batted ball gets the average result of balls hit at a similar exit velocity and launch angle, learned from every tracked ball in this site\'s data (BC and opponents). Walks, HBP and strikeouts count at their actual value.'],
    ['wOBA', 'Weighted on-base average, using MLB linear weights: BB .69, HBP .72, 1B .89, 2B 1.27, 3B 1.62, HR 2.10. Denominator is AB + BB + SF + HBP.'],
    ['Barrel', 'A batted ball of 98+ mph whose launch angle falls in the Statcast barrel window: 26°–30° at 98 mph, widening with each extra mph until it spans 8°–50° at 116 mph.'],
    ['Hard-Hit %', 'Share of tracked batted balls hit 95 mph or harder. Bunts are excluded from all batted-ball quality stats.'],
    ['Sweet-Spot %', 'Share of tracked batted balls with a launch angle between 8° and 32°.'],
    ['EV90', 'The 90th-percentile exit velocity, a steadier measure of top-end power than max EV.'],
    ['Bat Speed', 'Average TrackMan bat speed on swings between 50 and 95 mph (readings outside that range are checked swings, bunts or tracking errors and are removed). Only available in games where bat tracking was on.'],
    ['Bat tracking', 'TrackMan bat speed and attack angles, recorded only in games where bat tracking was on, and only for swings between 50 and 95 mph. Fast-Swing% is the share of those swings at 75+ mph. Attack Angle is the bat\'s vertical angle at contact; Ideal AA% is the share between 5° and 20°. Attack Direction is the bat\'s horizontal angle, shown toward the pull or opposite field.'],
    ['Squared-Up % / Blast %', 'Per tracked contact. A ball is squared up when its exit velocity reaches 80% of the most the swing could produce (1.23 × bat speed + 0.23 × pitch speed, the MLB Statcast formula). A blast is contact where squared-up % × 100 + bat speed is at least 164. Swing length is not recorded by TrackMan, so it is not shown.'],
    ['Zone', `The strike zone used for Zone%, Chase% and zone charts is ±${ZW} ft from the center of the plate (plate plus a ball's width) and ${ZB}–${ZT} ft high.`],
    ['Chase %', 'Swings at pitches outside the zone ÷ pitches outside the zone.'],
    ['Whiff %', 'Swinging strikes ÷ swings.'],
    ['CSW %', 'Called strikes plus swinging strikes ÷ pitches.'],
    ['PutAway %', 'Strikeouts on a pitch type ÷ two-strike pitches of that type.'],
    ['IVB / HB', 'Induced vertical break and horizontal break in inches, from TrackMan. Movement, release and pitch location charts on pitcher pages are drawn from the pitcher\'s point of view. Hitter zone profiles and hitter game charts are drawn from the catcher\'s point of view.'],
    ['Run Value', 'How many runs each pitch added or took away, from the count and base-out run value matrix (RE288): the change in run expectancy from before the pitch to after it, plus any runs that scored. TrackMan does not record baserunners, so the base state is rebuilt from play results. The count matrix is lightly repaired where small samples made it illogical (so a ball never costs the hitter and a strike never helps him), and run expectancy for each base-out state comes from this site\'s games, smoothed so that more runners or fewer outs always means more runs. The Data status page lists every adjustment. Hitter pages show runs added by the hitter; pitcher pages show runs saved by the pitcher.'],
    ['Good decision', 'Game pages grade every pitch a hitter sees as a good or bad swing/take decision. It judges the decision, not the result. Start: for the pitch\'s attack zone and the count, swinging and taking are each worth a certain number of runs on average across that season\'s data. Then his damage heat map (xwOBA on contact in each zone, on his player page under Zone profile → Damage) adjusts it: where he does more damage than the league, swinging is worth more; where he does less, taking is. Small samples are pulled toward his overall level. He made a good decision if he picked the option worth more for him. Hover a Good/Bad tag to see his damage in that zone.'],
    ['Attack zones', 'Baseball Savant\'s split of the strike zone: Heart (green) is the middle of the zone, Shadow (yellow) the edges, about a ball\'s width in and out, Chase (red) just off the plate and Waste (grey) well off it. Swing runs and take runs add up the run value of the pitches swung at and taken in each zone.'],
    ['Swing/Take grade', 'Baseball Savant\'s Swing/Take method: every pitch is credited with its run value (what actually happened, from the count and base-out state before and after the pitch, plus runs scored), and those values are added up for swings and takes in each region (heart, shadow, chase, waste). Swing runs + take runs = run value. The grade puts run value per 100 pitches on the 20–80 scale: on player pages against every hitter in that season\'s data with 40+ pitches, and on game pages against every hitter-game with 8+ pitches. On pitch-by-pitch pages each pitch shows its region, swing or take, and its run value (green = good for the hitter, red = bad; on pitcher pages the sign is flipped).'],
    ['Hit+', 'Baseball America\'s hitting-quality metric. Five inputs (contact %, 90th-percentile exit velocity, chase %, barrel % and xwOBA on contact) are measured separately against fastballs, breaking balls and offspeed pitches. Each is regressed toward average by sample size, put on a 100 / 10-SD scale and weighted by how strongly it tracks wOBA, and the three pitch types count equally. Here the scale is set by every D1 hitter in the TruMedia pull, so 100 = D1 average and 110 = one standard deviation better. BC hitters that TruMedia has use TruMedia\'s inputs; fall seasons are scored from TrackMan, lined up with TruMedia using BC hitters who appear in both. Baseball America does not publish its exact weights, so this follows their method rather than copying their numbers.'],
    ['Expected movement (IVB vs x, HB vs x)', 'What a pitch type usually does for pitchers with the same arm slot (release height, release side and extension) and velocity. Each pitch is compared with the 60 most similar pitches of the same type thrown by other pitchers in this site\'s data (BC and opponents, all seasons), with lefties mirrored so both hands share one pool. IVB vs x: + means more carry or less drop than expected. HB vs x is in arm-side terms: + means more arm-side run, − means more glove-side sweep. On the movement chart, dashed rings show the expected spot and a dashed line runs to the actual average.'],
    ['VAA', 'Vertical approach angle: how steeply the pitch enters the zone. Flatter (closer to 0) four-seamers tend to miss more bats.'],
    ['Percentile rankings', 'Each bar ranks a player against qualified Boston College players in the same season (red = better, blue = worse). Hitters qualify with 5 or more plate appearances and pitchers with 5 or more batters faced. Non-qualified players are shown faded against the same pool.'],
    ['IP and R', 'Innings pitched and runs come from TrackMan outs-on-play and runs-scored tagging. They are close to the official box score but are not official, and runs are not split into earned and unearned.'],
    ['Results-only games', 'Games uploaded as plate-appearance results instead of a full TrackMan file. They count toward PA, AB, hits, AVG, OBP, SLG, wOBA, K%, BB%, 2K Win and batted-ball type. If the file also has TrackMan batted-ball columns (ExitSpeed, Angle, Direction, Distance), those balls in play also count toward exit velocity, hard-hit and barrel rates, xBA/xSLG/xwOBA and the spray charts. Pitch-level stats (pitch counts, swing, chase and whiff rates, bat tracking) only come from full TrackMan files.'],
    ['2K Win %', 'Share of plate appearances that reached two strikes and did not end in a strikeout (a hit, walk, HBP or ball in play all count as wins). Uses TrackMan and results-only games.'],
    ['Execution', 'Hit-and-run, stolen bases, bunting, 3-2 and the other categories on the Execution tab come straight from the coaching staff\'s weekly execution chart, matched to players by jersey number. Green means the player or team is at or above the staff goal for that category; red means below it.'],
    ['Data corrections', 'A few TrackMan tagging mistakes confirmed by the staff are fixed during every build (listed on the Data status page and in scripts/corrections.json).'],
    ['Power 4 percentiles', 'When TruMedia data is loaded, percentile bars can rank a BC player against every qualified hitter or pitcher in the ACC, SEC, Big Ten and Big 12 for that season (TruMedia season stats; fall data is compared with the most recent spring). The BC player\'s own numbers still come from this site\'s TrackMan data. Stats TruMedia doesn\'t provide are ranked against BC and marked BC.'],
    ['Seasons', 'Games from January–July are grouped as Spring; August–December as Fall. Fall data includes intrasquad scrimmages.'],
  ];
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">Reference</span><h1>Glossary</h1></div></div>
    <div class="panel prose" style="max-width:none"><dl class="gloss">${g.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('')}</dl></div>`;
}
function runValueStatus(R) {
  if (!R || R.error) return R?.error ? `<section class="panel"><div class="panel-h"><h2>Run values</h2></div><p style="margin:0">${esc(R.error)}</p></section>` : '';
  const f = R.matrix_repair || {}, re = R.re24 || {};
  const reRows = ['Empty', '1B', '2B', '3B', '1B,2B', '1B,3B', '2B,3B', 'Loaded'].map(b => ({ b, o0: re[`${b} | 0 out`], o1: re[`${b} | 1 out`], o2: re[`${b} | 2 out`] }));
  return `<section class="panel"><div class="panel-h"><h2>Run values</h2><span class="note">From scripts/re288.csv and ${F.int(R.pa_used)} plate appearances</span></div>
    <p class="small" style="margin:0 0 8px">${F.int(R.pitches_valued)} pitches valued · run level ${R.run_level_vs_mlb}× MLB.
      Count matrix: <b>${F.int(f.cells_changed || 0)} of 288 cells adjusted</b> so that a ball never lowers the count's value, a strike never raises it, ball four is never negative and strike three is never positive (largest change ${f.max_change ?? 0} runs; cells that already followed those rules were left alone).</p>
    ${(f.biggest || []).length ? `<details><summary class="small">Largest adjustments</summary><ul class="small" style="margin:6px 0">${f.biggest.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    <details><summary class="small">Run expectancy by base-out state (RE24) used for walks, strikeouts and balls in play</summary>
      ${table('t-re24', [{ k: 'b', label: 'Bases', l: true }, { k: 'o0', label: '0 out', fmt: F.f2 }, { k: 'o1', label: '1 out', fmt: F.f2 }, { k: 'o2', label: '2 out', fmt: F.f2 }], reRows, { nosort: true })}</details>
  </section>`;
}
function videoStatus(V) {
  const r = V?.report; if (!r) return '';
  if (!r.enabled) return `<section class="panel"><div class="panel-h"><h2>Video</h2></div><p style="margin:0">Turned off in scripts/video.json.</p></section>`;
  const t = r.trumedia;
  return `<section class="panel"><div class="panel-h"><h2>Video</h2><span class="note">AWRE clip lists in data/video/ and TruMedia GameVideo</span></div>
    <p style="margin:0 0 8px"><b>${F.int(r.pitches)}</b> pitches · <b>${F.int(r.pas)}</b> at-bats · <b>${F.int(r.games)}</b> full games · <b>${F.int(r.players)}</b> player clips · <b>${F.int(r.other)}</b> other clips</p>
    ${t ? `<p class="small" style="margin:4px 0"><b>TruMedia</b> (${esc(new Date(t.ran).toLocaleString())}): ${esc(t.status)}${t.request ? ` · request: ${esc(t.request)}` : ''}${(t.attempts || []).length ? `<br><span class="muted">Tried: ${esc(t.attempts.join(' | '))}</span>` : ''}${(t.columns || []).length ? ` · columns returned: ${esc(t.columns.join(', '))}` : ''}${Object.keys(t.errors || {}).length ? `<br><span class="err" style="padding:0">${esc(Object.entries(t.errors).slice(0, 3).map(([g, e]) => g + ': ' + e).join(' | '))}</span>` : ''}</p>
      ${t.sample ? `<details><summary class="small">What TruMedia sent for ${esc(t.sample.gid)}</summary><pre class="small" style="white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(t.sample, null, 1))}</pre></details>` : ''}` : '<p class="small muted" style="margin:4px 0">TruMedia video has not run yet.</p>'}
    ${r.awre ? `<p class="small" style="margin:4px 0"><b>AWRE</b> (${esc(new Date(r.awre.ran).toLocaleString())}): ${esc(r.awre.status)} · ${F.int(r.awre.games || 0)} games/sessions on AWRE, ${F.int(r.awre.pitches_with_video || 0)} pitches with video${(r.awre.errors || []).length ? `<br><span class="err" style="padding:0">${esc(r.awre.errors.join(' | '))}</span>` : ''}</p>` : '<p class="small muted" style="margin:4px 0">AWRE video has not run yet.</p>'}
    ${(r.sources || []).map(s => `<p class="small" style="margin:4px 0"><b>${esc(s.file)}</b>: ${s.status ? esc(s.status) : `${F.int(s.rows)} clip rows → ${['pitch', 'pa', 'game', 'player', 'other', 'none'].filter(k => s[k]).map(k => `${F.int(s[k])} ${{ pitch: 'pitches', pa: 'at-bats', game: 'games', player: 'player clips', other: 'other', none: 'not matched' }[k]}`).join(', ')}`}</p>`).join('')}
    ${(r.unmatched || []).length ? `<details><summary class="small">Clips that didn't match (${r.unmatched.length}${r.unmatched.length >= 60 ? '+' : ''})</summary>
      ${table('t-vun', [{ k: 'src', label: 'File', l: true }, { k: 'why', label: 'Why', l: true, html: x => `<span style="white-space:normal">${esc(x.why)}</span>` }, { k: 'row', label: 'Row', l: true, html: x => `<span style="white-space:normal">${esc(Object.entries(x.row).map(([k, v]) => k + ': ' + v).join(' · '))}</span>` }], r.unmatched, { nosort: true })}</details>` : ''}
  </section>`;
}
function pageData() {
  setNav('');
  const m = S.meta;
  app.innerHTML = `<div class="phead"><div><span class="eyebrow">Data status</span><h1>What's loaded</h1></div></div>
  <section class="panel"><div class="panel-h"><h2>Seasons</h2><span class="note">Last rebuilt ${esc(new Date(m.built).toLocaleString())}</span></div>
    ${table('t-seasons', [{ k: 'label', label: 'Season', l: true }, { k: 'games', label: 'Games', fmt: F.int }, { k: 'pitches', label: 'Pitches', fmt: F.int }, { k: 'start', label: 'First game', l: true, fmt: v => esc(fmtDate(v, true)) }, { k: 'end', label: 'Last game', l: true, fmt: v => esc(fmtDate(v, true)) }], m.seasons, { nosort: true })}</section>
  <section class="panel"><div class="panel-h"><h2>Files in the data folder</h2><span class="note">Duplicate pitches across files are counted once</span></div>
    ${table('t-files', [{ k: 'file', label: 'File', l: true }, { k: 'kind', label: 'Type', l: true }, { k: 'rows', label: 'Rows read', fmt: F.int }, { k: 'status', label: 'Status', l: true },
      { k: 'notes', label: 'Notes', l: true, html: r => {
        if (r.kind !== 'Results' || r.status !== 'ok') return '';
        const bits = [`${esc(fmtDate(r.date, true))} vs ${esc(teamName(r.opp))}, ${r.pa} PA`];
        const nm = (r.names || []).filter(x => x.as).map(x => `${esc(x.raw)} → ${esc(x.as)}`);
        const nw = (r.names || []).filter(x => !x.as).map(x => esc(x.raw));
        if (nm.length) bits.push('Matched: ' + nm.join(', '));
        if (nw.length) bits.push('New names: ' + nw.join(', '));
        if (r.unread && r.unread.length) bits.push('Could not read: ' + r.unread.map(esc).join(', '));
        return `<span style="white-space:normal">${bits.join(' · ')}</span>`;
      } }], m.files, { nosort: true })}</section>
  ${m.ncaa?.report ? `<section class="panel"><div class="panel-h"><h2>TruMedia</h2><span class="note">Last run ${esc(new Date(m.ncaa.report.ran).toLocaleString())}</span></div>
    <p style="margin:0 0 10px"><b>${esc(m.ncaa.report.status)}</b></p>
    ${Object.entries(m.ncaa.report.years || {}).map(([y, r]) => `<p class="small" style="margin:4px 0"><b>${esc(y)}</b>${r.state ? ` <span class="muted">(${esc(r.state)}${r.state !== 'complete' && (r.steps_done || []).length ? ': ' + esc(r.steps_done.join(', ')) + ' done' : ''})</span>` : ''}: ${r.error ? `<span class="err" style="padding:0">${esc(r.error)}</span>` : ['hitting', 'pitching'].map(sd => r[sd] && !r[sd].rows && (r[sd].attempts || []).length ? `${sd}: nothing pulled · ${esc(r[sd].attempts.join(' | '))}` : r[sd] ? `${sd} ${F.int(r[sd].rows)} players (${F.int(r[sd].power4_rows || 0)} Power 4)${r[sd].query ? ' via ' + esc(r[sd].query) : ''}${r[sd].team_source ? ` · teams from ${esc(r[sd].team_source)}${r[sd].players_with_team != null ? ` (${F.int(r[sd].players_with_team)} placed)` : ''}` : ''}${(r[sd].columns_rejected || []).length ? ` · columns TruMedia didn't recognise: ${esc(r[sd].columns_rejected.join(', '))}` : ''}${r[sd].power4_teams_missing && Object.keys(r[sd].power4_teams_missing).length ? ` · Power 4 teams not matched: ${esc(Object.values(r[sd].power4_teams_missing).flat().join(', '))}` : ''}` : '').filter(Boolean).join('<br>')}${r.hitplus ? `<br>Hit+: ${r.hitplus.error ? `<span class="err" style="padding:0">${esc(r.hitplus.error)}</span>` : `${F.int(r.hitplus.players || 0)} hitters · ${esc(r.hitplus.source || ((r.hitplus.groups || []).join(', ') === 'ALL' ? 'all pitches' : 'by pitch type: ' + (r.hitplus.groups || []).join(', ')))} · inputs: ${esc(Object.entries(r.hitplus.inputs || {}).map(([k, v]) => k + ' = ' + v).join(', '))}`}` : ''}</p>`).join('')}
  </section>` : ''}
  ${videoStatus(m.video)}
  ${runValueStatus(m.runvalue)}
  ${(m.corrections || []).length ? `<section class="panel"><div class="panel-h"><h2>TrackMan corrections</h2><span class="note">From scripts/corrections.json</span></div>
    ${table('t-corr', [{ k: 'batter', label: 'Batter', l: true }, { k: 'date', label: 'Date', l: true, fmt: v => esc(fmtDate(v, true)) }, { k: 'pitchno', label: 'Pitch #', fmt: F.int }, { k: 'note', label: 'Fix', l: true, html: r => `<span style="white-space:normal">${esc(r.note || '')}</span>` }, { k: 'applied', label: 'Status', l: true, fmt: v => v ? 'Applied' : 'Pitch not found' }], m.corrections, { nosort: true })}</section>` : ''}
  <section class="panel prose" style="max-width:none"><h2 style="margin-bottom:8px">Adding new games</h2>
    <p>Upload TrackMan CSV or Excel exports into the <b>data</b> folder of the GitHub repository (Add file → Upload files). The site rebuilds itself in a couple of minutes. You can upload single games or combined season files; any pitch that appears in more than one file is only counted once.</p>
    <p>For the execution chart, download the sheet as CSV each week and upload it to the <b>data</b> folder. The newest "Updated through" date for each season is used, so you can replace last week's file or add a new one.</p>
    <p>For a game without TrackMan, upload a results file with <b>Batter</b>, <b>Balls</b>, <b>Strikes</b> and <b>Result</b> columns, and put the date and opponent in the file name, for example <b>2026-09-26 URI Results.xlsx</b>. Check the Notes column above to confirm each batter matched the right player.</p></section>`;
}

/* ---------- player search box ---------- */
function initTooltips() {
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
  const show = (el, x, y) => {
    tip.innerHTML = el.getAttribute('data-tip'); tip.hidden = false;
    const r = tip.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    let left = x + 14, top = y + 14;
    if (left + r.width > vw - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
  };
  document.addEventListener('pointermove', e => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else tip.hidden = true; });
  document.addEventListener('pointerdown', e => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}
function initTheme() {
  const btn = $('#theme-btn'); if (!btn) return;
  const label = () => { btn.textContent = document.documentElement.dataset.theme === 'light' ? 'Dark mode' : 'Light mode'; };
  label();
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bbs:theme', next); } catch { /* storage unavailable */ }
    label();
    route();   // redraw charts so their colors follow the new theme
  };
}
function initSearch() {
  const inp = $('#psearch-input'), list = $('#psearch-list');
  let act = -1, items = [];
  const show = () => {
    const q = inp.value.trim().toLowerCase();
    if (!q) { list.hidden = true; return; }
    const m = S.players.map((p, i) => ({ p, i, nm: niceName(p.n).toLowerCase() }))
      .filter(o => o.nm.includes(q) || o.p.n.toLowerCase().includes(q))
      .sort((a, b) => (b.p.bc - a.p.bc) || (a.nm.indexOf(q) - b.nm.indexOf(q)) || a.nm.localeCompare(b.nm)).slice(0, 12);
    items = m; act = m.length ? 0 : -1;
    list.innerHTML = m.map((o, k) => `<a href="#player-${esc(o.p.k)}" class="${k === act ? 'act' : ''}"><span>${esc(niceName(o.p.n))}</span><span class="tag">${o.p.bc ? (o.p.pit.length && o.p.hit.length ? 'BC · two-way' : o.p.pit.length && !o.p.hit.length ? 'BC · P' : 'BC') : esc(teamName(o.p.t))}</span></a>`).join('') || '<div class="empty" style="padding:10px 12px">No player found</div>';
    list.hidden = false;
  };
  inp.oninput = show;
  inp.onfocus = show;
  inp.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; act = (act + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; $$('a', list).forEach((a, k) => a.classList.toggle('act', k === act)); }
    if (e.key === 'Enter' && act >= 0) { location.hash = 'player-' + items[act].p.k; inp.value = ''; list.hidden = true; inp.blur(); }
    if (e.key === 'Escape') { list.hidden = true; }
  };
  document.addEventListener('click', e => { if (!e.target.closest('.psearch')) list.hidden = true; else if (e.target.closest('a')) { list.hidden = true; inp.value = ''; } });
}

/* ---------- router ---------- */
async function route() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  S.vreg = [];
  try {
    if (!S.meta.seasons.length) { app.innerHTML = '<p class="empty">No data has been uploaded yet. Add TrackMan files to the data folder of the repository.</p>'; return; }
    if (!h || h === 'home') await pageHome();
    else if (h === 'hitting' || h === 'pitching') await pageLeaders(h);
    else if (h === 'arsenal') await pageArsenal();
    else if (h === 'spray') await pageSpray();
    else if (h === 'games') await pageGames();
    else if (h.startsWith('game-')) { const m = h.match(/^game-(.+)-(\d+)$/); if (m) await pageGame(m[1], +m[2]); }
    else if (h.startsWith('player-')) await pagePlayer(h.slice(7));
    else if (h.startsWith('pg-')) { const m = h.match(/^pg-(\d{4}-(?:spring|fall))-(\d+)-(hit|pit)-(.+)$/); if (m) await pagePlayerGame(m[1], +m[2], m[3], m[4]); }
    else if (h === 'search') await pageSearch();
    else if (h === 'ncaa') await pageNcaa();
    else if (h.startsWith('ncaa-p-')) { const m = h.match(/^ncaa-p-(\d{4})-(hitting|pitching)-(.+)$/); if (m) await pageNcaaPlayer(+m[1], m[2], m[3]); }
    else if (h === 'glossary') pageGlossary();
    else if (h === 'video') await pageVideo();
    else if (h === 'data') pageData();
    else await pageHome();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="err">Something went wrong loading this page: ${esc(err.message)}</p>`;
  }
}
let lastHash = null;
window.addEventListener('hashchange', () => { const changedPage = location.hash !== lastHash; lastHash = location.hash; route().then(() => { if (changedPage) window.scrollTo(0, 0); }); });
(async () => {
  try { await loadMeta(); } catch (err) {
    app.innerHTML = `<p class="err">Could not load the data files. If you're opening this from your computer, run <code>python scripts/build.py</code> and serve the <code>site</code> folder (for example <code>python -m http.server -d site</code>). (${esc(err.message)})</p>`;
    return;
  }
  initSearch();
  initTooltips();
  initTheme();
  initVideo();
  lastHash = location.hash;
  route();
})();
