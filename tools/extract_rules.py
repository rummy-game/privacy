"""Liest die rules_*-Texte aus der App und schreibt src/data/rules.json.
Aufruf: python tools/extract_rules.py [pfad-zu-rummy/app/src/main/res]"""
import json, re, sys
import xml.etree.ElementTree as ET
from pathlib import Path

res = Path(sys.argv[1] if len(sys.argv) > 1 else "../rummy/app/src/main/res")
DEFAULTS = {"1$d": None}  # %1$d: Startplättchen bzw. Mindestpunkte, je nach Abschnitt
SECTIONS = ["goal", "tiles", "melds", "turn", "first", "rebuild", "end", "app", "multi", "ai"]

def load(folder):
    out = {}
    for s in ET.parse(res / folder / "strings.xml").getroot().iter("string"):
        n = s.get("name", "")
        if n.startswith("rules_"):
            t = "".join(s.itertext())
            t = t.replace(chr(92) + "n", chr(10)).replace(chr(92) + "'", "'").replace(chr(92) + '"', '"')
            out[n] = t
    return out

def fill(key, text):
    value = "14" if key == "rules_tiles_b" else "30"
    return text.replace("%1$d", value)

data = {}
for lang, folder in (("de", "values"), ("en", "values-en")):
    d = load(folder)
    data[lang] = {
        "title": d["rules_title"],
        "sections": [
            {"id": s, "heading": d[f"rules_{s}_h"], "body": fill(f"rules_{s}_b", d[f"rules_{s}_b"])}
            for s in SECTIONS
        ],
    }
Path("src/data/rules.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print({k: len(v["sections"]) for k, v in data.items()})
