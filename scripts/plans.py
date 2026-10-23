#!/usr/bin/env python3
"""
Development plans and weekly feedback (PDFs from the staff), published locked.

Coaches upload PDFs to GitHub, named for the player:
    Toomey - Weekly feedback 2026-10-19.pdf
    Jack Toomey - Fall development plan.pdf
    #6 - Hitting plan.pdf                      (jersey number works too)
or inside a folder named for the player (plans/Toomey/anything.pdf).

Where the PDFs come from (first that exists):
    plans-private/   the team's private plans repository, checked out by the deploy workflow
    plans/           a plans folder in this repository (simpler, but visible on GitHub if the
                     repository is public)

Nothing is published in readable form. Each player gets a personal code (xxxx-xxxx) made from
the PLANS_SECRET repository secret; his list of plans and every PDF are encrypted with a key
made from that code (PBKDF2-SHA256 + AES-256-GCM) and published under a folder name that also
comes from the code, so without the code you can't tell whose files are whose or how many there
are. The staff file (codes for every player + all plans) is encrypted with PLANS_SECRET itself,
which is the staff password typed on the coach dashboard.

Writes site/data/plans/... and site/data/plans-report.json. Run after build.py (it reads the
player list from site/data/meta.json).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "plans"
REPORT = ROOT / "site" / "data" / "plans-report.json"
META = ROOT / "site" / "data" / "meta.json"
SOURCES = [ROOT / "plans-private", ROOT / "plans"]
ITER = 150_000                       # PBKDF2 rounds (the site uses the same number)
ALPHA = "abcdefghjkmnpqrstuvwxyz23456789"   # no 0/o, 1/l/i


def log(*a):
    print(*a, flush=True)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def initials(p) -> str:
    f = re.sub(r"[^A-Za-z]", "", p["nice"].split(" ")[0])[:1] if p["nice"] else ""
    last = p["nice"].split(" ")[-1] if " " in p["nice"] else ""
    return (f + re.sub(r"[^A-Za-z]", "", last)[:1]).upper()


def assign_codes(players, secret: str):
    """Jersey number + initials (16-JS). A player with no number, or a clash, gets a random code."""
    codes, used = {}, set()
    for p in sorted(players, key=lambda x: (x["num"] is None, x["k"])):
        ini = initials(p)
        c = f"{p['num']}-{ini}" if p["num"] is not None and ini else None
        if c is None or code_norm(c) in used:
            c = player_code(secret, p["k"])
        used.add(code_norm(c))
        codes[p["k"]] = c
    return codes


def player_code(secret: str, key: str) -> str:
    d = hmac.new(secret.encode(), ("code:" + key).encode(), hashlib.sha256).digest()
    c = "".join(ALPHA[b % len(ALPHA)] for b in d[:8])
    return c[:4] + "-" + c[4:]


def code_norm(code: str) -> str:
    return re.sub(r"[^a-z0-9]", "", code.lower())


def folder_of(code: str) -> str:
    return hashlib.sha256(("bbs-plans-path:" + code_norm(code)).encode()).hexdigest()[:24]


def derive(secret_text: str, salt: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", secret_text.encode(), salt.encode(), ITER, 32)


def seal(key: bytes, data: bytes) -> bytes:
    """nonce (12 bytes) + AES-GCM ciphertext; WebCrypto decrypts the same layout."""
    n = os.urandom(12)
    return n + AESGCM(key).encrypt(n, data, None)


# ---------------------------------------------------------------------------
# Which player a file belongs to
# ---------------------------------------------------------------------------
def roster():
    meta = json.loads(META.read_text())
    out = []
    for p in meta["players"]:
        if not p.get("bc") or not (p.get("hit") or p.get("pit")):
            continue
        n = p["n"]
        last, first = (n.split(",", 1) + [""])[:2] if "," in n else (n.split()[-1], " ".join(n.split()[:-1]))
        out.append({"k": p["k"], "n": n, "first": norm(first), "last": norm(last),
                    "num": str(p["num"]) if p.get("num") is not None else None,
                    "nice": f"{first.strip()} {last.strip()}".strip()})
    return out


def match_player(text: str, players):
    """Player named at the start of a file or folder name. Returns (player, error)."""
    t = norm(text)
    m = re.match(r"^\s*#?\s*(\d{1,2})\b", text)
    if m:
        hits = [p for p in players if p["num"] == m.group(1)]
        if len(hits) == 1:
            return hits[0], None
    words = t.split()
    best = []
    for p in players:
        full1, full2 = f"{p['first']} {p['last']}".strip(), f"{p['last']} {p['first']}".strip()
        for cand, score in ((full1, 3), (full2, 3), (p["last"], 1)):
            if cand and (t == cand or t.startswith(cand + " ")):
                best.append((score, len(cand), p))
    if not best:
        return None, "no player name at the start"
    top = max(b[0] for b in best)
    tops = {id(b[2]): b[2] for b in best if b[0] == top}
    if len(tops) == 1:
        return next(iter(tops.values())), None
    # same last name: first initial or first name right after it ("Ryan J", "Ryan Jack")
    for p in tops.values():
        rest = t[len(p["last"]):].split()
        if rest and p["first"] and (rest[0] == p["first"] or rest[0] == p["first"][0]):
            return p, None
    return None, "more than one player matches: " + ", ".join(sorted(p["nice"] for p in tops.values())) + " (use the full name)"


DATE_RES = [
    (re.compile(r"(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"(?<!\d)(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})(?!\d)"), lambda m: (int(m[3]) + (2000 if int(m[3]) < 100 else 0), int(m[1]), int(m[2]))),
]


def date_in(name: str):
    for rx, f in DATE_RES:
        m = rx.search(name)
        if m:
            try:
                return date(*f(m)).isoformat(), m.group(0)
            except ValueError:
                pass
    return None, None


def git_date(repo: Path, rel: str):
    try:
        out = subprocess.run(["git", "-C", str(repo), "log", "-1", "--format=%cs", "--", rel],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        return out or None
    except Exception:
        return None


def strip_player(stem: str, p) -> str:
    """Drop the player's name / number from the front of a file name."""
    ids = {p["first"], p["last"], p["num"] or "-", "#" + (p["num"] or "-")} | ({p["first"][0]} if p["first"] else set())
    toks = re.split(r"([\s_,\-–—:]+)", stem.strip())
    i = 0
    while i < len(toks) and (norm(toks[i]) in ids or not norm(toks[i])):
        i += 1
    return "".join(toks[i:])


def clean_title(text: str, date_txt: str | None):
    t = text.replace(date_txt, " ") if date_txt else text
    t = re.sub(r"_+", " ", t)
    t = re.sub(r"^[\s\-–—:,.()]+|[\s\-–—:,.()]+$", "", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def main():
    report = {"ran": datetime.now(timezone.utc).isoformat(timespec="seconds"), "status": "", "source": None,
              "players": 0, "plans": 0, "skipped": []}

    def finish(status):
        report["status"] = status
        REPORT.write_text(json.dumps(report, indent=1))
        log(f"Plans: {status}")

    if OUT.exists():
        shutil.rmtree(OUT)
    src = next((d for d in SOURCES if d.is_dir()), None)
    if src is None:
        return finish("no plans folder yet")
    report["source"] = "private plans repository" if src.name == "plans-private" else "plans/ folder in this repository"
    secret = os.environ.get("PLANS_SECRET", "").strip()
    if not secret:
        return finish("not published: add the PLANS_SECRET repository secret (see README)")
    if len(secret) < 8:
        return finish("not published: PLANS_SECRET must be at least 8 characters")
    players = roster()
    by_key = {p["k"]: p for p in players}
    plans = {}
    for f in sorted(src.rglob("*")):
        if not f.is_file() or ".git" in f.parts:
            continue
        rel = f.relative_to(src).as_posix()
        if f.suffix.lower() != ".pdf":
            if f.name.lower() not in ("readme.md", ".gitkeep") and not rel.startswith(".github/"):
                report["skipped"].append({"file": rel, "why": "not a PDF"})
            continue
        # player: from the folder (plans/Toomey/x.pdf) or the start of the file name
        parts = f.relative_to(src).parts
        p, why, from_folder = None, None, False
        if len(parts) > 1:
            p, why = match_player(parts[-2], players)
            from_folder = p is not None
        if p is None:
            p, why = match_player(f.stem, players)
        if p is None:
            report["skipped"].append({"file": rel, "why": why})
            continue
        d, dtxt = date_in(f.name)
        when = d or git_date(src, rel) or date.today().isoformat()
        kind = "feedback" if re.search(r"feedback|weekly|week\b", f.stem, re.I) else "plan"
        title = clean_title(f.stem if from_folder else strip_player(f.stem, p), dtxt)
        if not title or norm(title) in (p["last"], norm(p["nice"])):
            title = "Weekly feedback" if kind == "feedback" else "Development plan"
        pid = hashlib.sha256((p["k"] + "|" + rel).encode()).hexdigest()[:16]
        plans.setdefault(p["k"], []).append({"id": pid, "title": title, "kind": kind, "date": when,
                                              "size": f.stat().st_size, "file": f, "rel": rel})
    OUT.mkdir(parents=True, exist_ok=True)
    staff = {"v": 1, "built": report["ran"], "upload": os.environ.get("PLANS_UPLOAD_URL", ""),
             "publish": os.environ.get("PLANS_PUBLISH_URL", ""), "players": []}
    codes = assign_codes(players, secret)
    for p in players:
        code = codes[p["k"]]
        folder = folder_of(code)
        key = derive(code_norm(code), "bbs-plans:" + folder)
        mine = sorted(plans.get(p["k"], []), key=lambda x: (x["date"], x["title"]), reverse=True)
        d = OUT / folder
        d.mkdir(parents=True, exist_ok=True)
        for x in mine:
            (d / f"{x['id']}.bin").write_bytes(seal(key, x["file"].read_bytes()))
        listing = [{k: x[k] for k in ("id", "title", "kind", "date", "size")} for x in mine]
        (d / "index.bin").write_bytes(seal(key, json.dumps({"v": 1, "player": p["k"], "name": p["nice"], "plans": listing}).encode()))
        staff["players"].append({"k": p["k"], "name": p["nice"], "num": p["num"], "code": code, "folder": folder,
                                 "key": b64(key), "plans": listing})
    skey = derive(secret, "bbs-plans-staff")
    (OUT / "staff.bin").write_bytes(seal(skey, json.dumps(staff).encode()))
    report["players"] = sum(1 for k in plans)
    report["plans"] = sum(len(v) for v in plans.values())
    finish(f"published {report['plans']} PDF(s) for {report['players']} player(s)"
           + (f"; {len(report['skipped'])} file(s) skipped" if report["skipped"] else ""))


if __name__ == "__main__":
    sys.exit(main())
