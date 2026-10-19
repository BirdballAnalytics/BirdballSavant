"""Prints a fingerprint of the TruMedia data the site shows (stats + matched video), ignoring
run timestamps, so the TruMedia workflow only republishes the site when something changed."""
import hashlib
import json
from pathlib import Path

d = Path(__file__).resolve().parent.parent / "site" / "data"
h = hashlib.sha1()
for f in sorted(d.glob("ncaa-[0-9]*.json")):
    try:
        j = json.loads(f.read_text())
    except ValueError:
        continue
    j.pop("pulled", None)
    h.update(f.name.encode() + json.dumps(j, sort_keys=True).encode())
for f in sorted((d / "video-tm").glob("*.json")) if (d / "video-tm").exists() else []:
    try:
        j = json.loads(f.read_text())
    except ValueError:
        continue
    if j.get("rows"):
        h.update(f.name.encode() + json.dumps(j["rows"], sort_keys=True, default=str).encode())
for f in sorted((d / "video-awre").glob("*.json")) if (d / "video-awre").exists() else []:
    try:
        j = json.loads(f.read_text())
    except ValueError:
        continue
    h.update(f.name.encode() + str(sum(1 for p in j.get("pitches", []) if p.get("clips"))).encode())
print(h.hexdigest()[:16])
