"""Build data/stadiums.js for Arena Locator.

Pulls active sports venues with a photo and coordinates from Wikidata, decides
each venue's primary sport, keeps the 100 most famous per sport (famousness =
number of Wikipedia language editions covering it), and fetches photo credits
from Wikimedia Commons.

Hand curation lives in data/overrides.json:
  "exclude": ["Q123", ...]          drop these venues (bad photo, closed, ...)
  "sport":   {"Q456": "tennis"}     force a venue into a sport (and include it)

Run:  python3 scripts/build_data.py            (reuses cached API responses)
      python3 scripts/build_data.py --refresh  (re-download everything)
"""
import hashlib
import html
import json
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = "ArenaLocatorPrototype/0.1 (educational game prototype)"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / ".cache"
PER_SPORT = 100
TIERS = 5
SPORTS_VENUE = "Q1076486"
MAX_FULL_PIXELS = 40_000_000  # larger originals get a 3840px rendition instead

# (key, label, sport item, hand-picked venue class roots, min Wikipedia editions)
SPORTS = [
    ("soccer", "Soccer", "Q2736", ["Q1154710"], 4),
    ("american_football", "American Football", "Q41323", [], 4),
    ("baseball", "Baseball", "Q5369", ["Q595452"], 4),
    ("basketball", "Basketball", "Q5372", ["Q81670826"], 4),
    ("tennis", "Tennis", "Q847", ["Q13380226"], 2),
]
# Sports we don't play but still score, so a hockey arena or a cricket ground
# isn't mislabelled as basketball or soccer. Venues whose main sport is one of
# these are dropped.
OTHER_SPORTS = [
    ("ice_hockey", "Q41466"),
    ("cricket", "Q5375"),
    ("rugby_union", "Q5849"),
    ("rugby_league", "Q10962"),
    ("aussie_rules", "Q50776"),
]
# Primary-sport ties go to the earlier sport: a generic stadium that merely
# lists tennis among many sports is almost always a soccer/football ground, and
# a shared NBA/NHL arena stays basketball.
SPORT_ORDER = [s[0] for s in SPORTS]
ALL_ORDER = SPORT_ORDER + [k for k, _ in OTHER_SPORTS]

# Many big indoor arenas host one tennis tournament a year but their photos show
# hockey or concerts. Only count a venue as tennis if it is built for tennis.
TENNIS_NAME = re.compile(r"tennis|court\b|roland|melbourne park|country club|rothenbaum|foro italico|caja m", re.I)

# Venue classes tied to each sport (e.g. "baseball venue" and its subclasses).
SPORT_CLASSES_QUERY = """
SELECT ?sport ?c WHERE {
  VALUES ?sport { %(sports)s }
  { ?root wdt:P641 ?sport ; wdt:P279+ wd:%(venue)s . } UNION { VALUES (?root ?sport) { %(roots)s } }
  ?c wdt:P279* ?root .
}
"""

CANDIDATE_TEMPLATE = """
SELECT ?v (COUNT(DISTINCT ?o) AS ?n) WHERE {
  %s
  ?v wdt:P625 [] ; wdt:P18 [] ; wikibase:sitelinks ?links .
  FILTER(?links >= %d)
} GROUP BY ?v ?links ORDER BY DESC(?links) LIMIT 1200
"""
# Ways Wikidata ties a venue to a sport. ?o is whatever supplies the evidence.
BRANCHES = {
    "direct": "?v wdt:P641 wd:{sport} . BIND(?v AS ?o)",          # venue's own "sport" property
    "tenants": "{{ ?v wdt:P466 ?o }} UNION {{ ?o wdt:P115 ?v }} ?o wdt:P641 wd:{sport} .",  # teams playing there
    "typed": "VALUES ?c {{ {classes} }} ?v wdt:P31 ?c . BIND(?c AS ?o)",  # e.g. instance of "tennis venue"
    "events": "?o wdt:P641 wd:{sport} ; wdt:P276 ?v .",           # tournaments held there
}
BRANCHES_BY_SPORT = {
    "soccer": ["direct", "tenants", "typed"],
    "american_football": ["direct", "tenants", "typed"],
    "baseball": ["direct", "tenants", "typed"],
    "basketball": ["direct", "tenants", "typed"],
    "tennis": ["direct", "typed", "events"],  # tennis has tournaments, not teams
    **{k: ["direct", "tenants"] for k, _ in OTHER_SPORTS},
}
WEIGHTS = {"typed": 3, "tenants": 2, "events": 2, "direct": 1}

DETAILS_TEMPLATE = """
SELECT ?v ?vLabel ?links ?type ?coord ?img ?countryLabel ?placeLabel ?cap ?closed WHERE {
  VALUES ?v { %s }
  ?v wdt:P625 ?coord ; wdt:P18 ?img ; wikibase:sitelinks ?links .
  OPTIONAL { ?v wdt:P31 ?type }
  OPTIONAL { ?v wdt:P17 ?country }
  OPTIONAL { ?v wdt:P131 ?place }
  OPTIONAL { ?v wdt:P1083 ?cap }
  OPTIONAL { { ?v wdt:P576 ?closed } UNION { ?v wdt:P3999 ?closed } UNION { ?v wdt:P5817 wd:Q56556915 . BIND(1 AS ?closed) } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""


def get_json(url, data=None, tries=5):
    key = hashlib.sha1(url.encode() + (data or b"")).hexdigest()
    cached = CACHE / f"{key}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                result = json.load(r)
            CACHE.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(result))
            time.sleep(1)  # be polite to the public endpoints
            return result
        except Exception as e:  # noqa: BLE001 - retry any network/parse hiccup
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"failed: {url[:120]}")


def sparql(query):
    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    return get_json("https://query.wikidata.org/sparql", data=body)["results"]["bindings"]


def qid(binding):
    return binding["value"].rsplit("/", 1)[1]


def parse_point(wkt):
    lon, lat = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", wkt).groups()
    return float(lat), float(lon)


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def load_overrides():
    path = ROOT / "data" / "overrides.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    return set(data.get("exclude", [])), dict(data.get("sport", {}))


def fetch_sport_classes():
    key_of = {q: k for k, _, q, _, _ in SPORTS}
    rows = sparql(SPORT_CLASSES_QUERY % {
        "sports": " ".join("wd:" + q for _, _, q, _, _ in SPORTS),
        "venue": SPORTS_VENUE,
        "roots": " ".join(f"(wd:{r} wd:{q})" for _, _, q, roots, _ in SPORTS for r in roots),
    })
    classes = {k: set() for k in SPORT_ORDER}
    for b in rows:
        classes[key_of[qid(b["sport"])]].add(qid(b["c"]))
    return classes


def fetch_candidates(sport_classes):
    """Return {qid: {sport: {branch: count}}}. Only our five sports add candidates;
    the other sports only add evidence to venues already found."""
    signals = {}
    queries = [(k, label, q, n) for k, label, q, _, n in SPORTS] + [(k, k, q, 4) for k, q in OTHER_SPORTS]
    for key, label, sport_q, min_links in queries:
        for branch in BRANCHES_BY_SPORT[key]:
            classes = " ".join("wd:" + c for c in sport_classes.get(key, ()))
            if branch == "typed" and not classes:
                continue
            pattern = BRANCHES[branch].format(sport=sport_q, classes=classes)
            rows = sparql(CANDIDATE_TEMPLATE % (pattern, min_links))
            added = 0
            for b in rows:
                vid = qid(b["v"])
                if key not in SPORT_ORDER and vid not in signals:
                    continue
                signals.setdefault(vid, {}).setdefault(key, {})[branch] = int(b["n"]["value"])
                added += 1
            print(f"  {label:18} {branch:8} {len(rows)} rows, {added} used")
    return signals


def primary_sport(name, signals, types, sport_classes):
    scores = {}
    for key in ALL_ORDER:
        sig = dict(signals.get(key, {}))
        typed = bool(types & sport_classes.get(key, set()))
        if typed:
            sig["typed"] = 1
        if key == "tennis" and not (typed or TENNIS_NAME.search(name)):
            continue
        score = sum(WEIGHTS[b] * min(n, 3) for b, n in sig.items())
        if score:
            scores[key] = score
    if not scores:
        return None
    best = max(ALL_ORDER, key=lambda k: (scores.get(k, 0), -ALL_ORDER.index(k)))
    return best if best in SPORT_ORDER else None


def fetch_details(signals, venue_classes, sport_classes, exclude, forced):
    venues = {}
    ids = sorted((set(signals) | set(forced)) - exclude)
    dropped_other = 0
    for i in range(0, len(ids), 150):
        batch = ids[i:i + 150]
        rows = sparql(DETAILS_TEMPLATE % " ".join("wd:" + q for q in batch))
        grouped = {}
        for b in rows:
            g = grouped.setdefault(qid(b["v"]), {"types": set(), "closed": False, "caps": [], "row": b})
            if b.get("type"):
                g["types"].add(qid(b["type"]))
            if b.get("closed"):
                g["closed"] = True
            if b.get("cap"):
                try:
                    g["caps"].append(int(float(b["cap"]["value"])))
                except ValueError:
                    pass
        for vid, g in grouped.items():
            b = g["row"]
            name = b["vLabel"]["value"]
            if vid in forced:
                sport = forced[vid]
            else:
                if g["closed"] or not (g["types"] & venue_classes) or re.fullmatch(r"Q\d+", name):
                    continue
                sport = primary_sport(name, signals.get(vid, {}), g["types"], sport_classes)
                if not sport and any(k in signals.get(vid, {}) for k, _ in OTHER_SPORTS):
                    dropped_other += 1
            if not sport:
                continue
            venues[vid] = {
                "id": vid, "name": name, "links": int(b["links"]["value"]), "sport": sport,
                "coord": parse_point(b["coord"]["value"]),
                "image": urllib.parse.unquote(b["img"]["value"].rsplit("/", 1)[1]),
                "country": b.get("countryLabel", {}).get("value", ""),
                "place": b.get("placeLabel", {}).get("value", ""),
                "capacity": max(g["caps"], default=0),
            }
    print(f"  {len(venues)} usable venues ({dropped_other} dropped as hockey/cricket/rugby grounds)")
    return venues


def fetch_credits(records):
    by_title = {"File:" + r["image"]: r for r in records}
    titles = sorted(by_title)
    for i in range(0, len(titles), 40):
        batch = titles[i:i + 40]
        params = urllib.parse.urlencode({
            "action": "query", "format": "json", "prop": "imageinfo",
            "iiprop": "url|extmetadata|mime|size", "iiurlwidth": 1280,
            "titles": "|".join(batch),
        })
        data = get_json("https://commons.wikimedia.org/w/api.php?" + params)
        norm = {n["to"]: n["from"] for n in data["query"].get("normalized", [])}
        for page in data["query"]["pages"].values():
            rec = by_title.get(norm.get(page["title"], page["title"]))
            if not rec or "imageinfo" not in page:
                continue
            ii = page["imageinfo"][0]
            meta = ii.get("extmetadata", {})
            rec["mime"] = ii.get("mime", "")
            rec["photo"] = ii.get("thumburl") or ii["url"]
            # Full resolution for deep zoom, capped so huge panoramas stay loadable.
            too_big = ii.get("width", 0) * ii.get("height", 0) > MAX_FULL_PIXELS
            rec["full"] = re.sub(r"/1280px-", "/3840px-", rec["photo"]) if too_big and "thumburl" in ii else ii["url"]
            rec["credit"] = {
                "author": strip_html(meta.get("Artist", {}).get("value", ""))[:120] or "Unknown",
                "license": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
                "licenseUrl": meta.get("LicenseUrl", {}).get("value", ""),
                "source": ii.get("descriptionurl", ""),
            }
    print(f"  credits for {len(titles)} photos")


def main():
    if "--refresh" in sys.argv:
        shutil.rmtree(CACHE, ignore_errors=True)
    exclude, forced = load_overrides()

    print("Fetching venue classes...")
    venue_classes = {qid(b["c"]) for b in sparql("SELECT ?c WHERE { ?c wdt:P279* wd:%s }" % SPORTS_VENUE)}
    sport_classes = fetch_sport_classes()
    print(f"  {len(venue_classes)} venue classes; per sport: " + ", ".join(f"{k}={len(v)}" for k, v in sport_classes.items()))

    print("Fetching candidates...")
    signals = fetch_candidates(sport_classes)
    print(f"  {len(signals)} unique candidates")

    print("Fetching details...")
    venues = fetch_details(signals, venue_classes, sport_classes, exclude, forced)

    # Over-select so records with unusable photos can be dropped and refilled.
    pools = {k: [] for k in SPORT_ORDER}
    for v in sorted(venues.values(), key=lambda v: (-v["links"], -v["capacity"])):
        if len(pools[v["sport"]]) < PER_SPORT + 25:
            pools[v["sport"]].append(v)

    print("Fetching photo credits from Commons...")
    fetch_credits([v for pool in pools.values() for v in pool])

    out = []
    for key, label, _, _, _ in SPORTS:
        good = [v for v in pools[key] if v.get("mime") in ("image/jpeg", "image/png", "image/webp")][:PER_SPORT]
        n = len(good)
        for rank, v in enumerate(good):
            lat, lon = v["coord"]
            out.append({
                "id": v["id"], "name": v["name"], "sport": key, "sportLabel": label,
                "lat": round(lat, 5), "lon": round(lon, 5),
                "country": v["country"], "place": v["place"], "capacity": v["capacity"] or None,
                "fame": v["links"], "rank": rank + 1, "tier": min(TIERS, rank * TIERS // n + 1),
                "photo": v["photo"], "full": v["full"], "credit": v["credit"],
            })
        print(f"{label}: {n} stadiums")

    (ROOT / "data" / "stadiums.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    (ROOT / "data" / "stadiums.js").write_text(
        "// Generated by scripts/build_data.py — do not edit by hand.\nwindow.STADIUMS = "
        + json.dumps(out, ensure_ascii=False) + ";\n")
    print(f"Wrote {len(out)} stadiums")


if __name__ == "__main__":
    main()
