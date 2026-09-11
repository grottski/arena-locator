"""Stamp index.html's local script/stylesheet URLs with content hashes.

GitHub Pages lets browsers cache files for 10 minutes, so after a deploy a phone
can end up with the new index.html but an old game.js, which breaks the page.
Adding ?v=<hash> to each URL means a changed file always gets a new URL, so the
page and its scripts always match.

Run before every commit that touches the site:  python3 scripts/stamp.py
"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
ASSET = re.compile(r'(?P<attr>src|href)="(?P<path>[\w./-]+\.(?:js|css))(?:\?v=[0-9a-f]*)?"')


def stamp(match):
    path = ROOT / match["path"]
    if not path.is_file():
        return match[0]  # external or missing: leave untouched
    digest = hashlib.sha1(path.read_bytes()).hexdigest()[:10]
    return f'{match["attr"]}="{match["path"]}?v={digest}"'


def main():
    html = INDEX.read_text()
    stamped = ASSET.sub(stamp, html)
    INDEX.write_text(stamped)
    for line in stamped.splitlines():
        if "?v=" in line:
            print(line.strip())


if __name__ == "__main__":
    main()
