"""Render the social-preview cover (assets/og-image.png, 1200x630) and the
home-screen icon (assets/icon-180.png).

Run:  python3 scripts/make_cover.py
Needs Pillow. On first run it downloads the Barlow Condensed font (SIL Open Font
License) from the Google Fonts repository into data/.cache/fonts.
"""
import math
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "data" / ".cache" / "fonts"
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/barlowcondensed/{}"
S = 2  # supersampling factor: draw at 2x, downsample for smooth edges

BG_TOP = (14, 23, 45)
BG_BOTTOM = (7, 11, 20)
LIME = (198, 244, 50)
TEXT = (238, 242, 248)
MUTED = (138, 150, 173)
PIN = (255, 93, 115)
INK = (11, 18, 0)


def font(name, size):
    path = FONT_DIR / name
    if not path.exists():
        FONT_DIR.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(FONT_URL.format(name), headers={"User-Agent": "ArenaLocatorPrototype/0.1"})
        path.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    return ImageFont.truetype(str(path), size * S)


def rgba(color, alpha):
    return (*color, round(255 * alpha))


def layer(size):
    return Image.new("RGBA", size, (0, 0, 0, 0))


def box(cx, cy, w, h):
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]


def background(w, h):
    top = Image.new("RGB", (w, h), BG_TOP)
    bottom = Image.new("RGB", (w, h), BG_BOTTOM)
    mask = Image.linear_gradient("L").resize((w, h)).transpose(Image.FLIP_TOP_BOTTOM)
    return Image.composite(top, bottom, mask).convert("RGBA")


def draw_globe_grid(img, cx, cy, r):
    """Faint orthographic globe lines behind the stadium."""
    grid = layer(img.size)
    d = ImageDraw.Draw(grid)
    lw = max(1, round(1.2 * S))
    d.ellipse(box(cx, cy, 2 * r, 2 * r), outline=rgba(TEXT, 0.09), width=lw)
    for deg in (20, 40, 60, 80):  # meridians
        w = 2 * r * math.cos(math.radians(deg))
        d.ellipse(box(cx, cy, w, 2 * r), outline=rgba(TEXT, 0.05), width=lw)
    for deg in (-60, -30, 0, 30, 60):  # parallels
        y = cy + r * math.sin(math.radians(deg))
        half = r * math.cos(math.radians(deg))
        d.line([cx - half, y, cx + half, y], fill=rgba(TEXT, 0.05), width=lw)
    img.alpha_composite(grid)


def draw_stadium(img, cx, cy, k):
    """Perspective stadium bowl with pitch, floodlights and a guess pin.
    k scales the whole mark (1.0 = 620px-wide bowl at 1x)."""
    u = k * S

    def blurred(draw_fn, radius):
        lyr = layer(img.size)
        draw_fn(ImageDraw.Draw(lyr))
        img.alpha_composite(lyr.filter(ImageFilter.GaussianBlur(radius)))

    # Soft floodlit glow under the bowl.
    blurred(lambda d: d.ellipse(box(cx, cy, 720 * u, 380 * u), fill=rgba(LIME, 0.13)), 70 * u)

    lines = layer(img.size)
    d = ImageDraw.Draw(lines)
    width = lambda px: max(1, round(px * u))

    # Stands: seating spokes between the roof rim and the pitch edge.
    for i in range(64):
        t = 2 * math.pi * i / 64
        d.line([cx + 300 * u * math.cos(t), cy + 154 * u * math.sin(t),
                cx + 226 * u * math.cos(t), cy + 113 * u * math.sin(t)],
               fill=rgba(LIME, 0.10), width=width(1.4))
    # Roof rim, stand tiers, pitch edge.
    for w, h, a, lw in [(620, 320, 0.95, 5), (560, 284, 0.30, 2.5), (500, 252, 0.30, 2.5), (452, 228, 0.65, 3)]:
        d.ellipse(box(cx, cy, w * u, h * u), outline=rgba(LIME, a), width=width(lw))

    # Pitch in perspective: far edge a little narrower than the near edge.
    top, bot = cy - 72 * u, cy + 72 * u
    far, near = 138 * u, 158 * u
    pitch = [(cx - far, top), (cx + far, top), (cx + near, bot), (cx - near, bot)]
    d.polygon(pitch, fill=rgba(LIME, 0.07))
    d.line(pitch + [pitch[0]], fill=rgba(LIME, 0.75), width=width(2.5))
    d.line([cx, top, cx, bot], fill=rgba(LIME, 0.6), width=width(2))
    d.ellipse(box(cx, cy, 78 * u, 40 * u), outline=rgba(LIME, 0.6), width=width(2))
    for side in (-1, 1):  # penalty boxes
        edge_top, edge_bot = cx + side * far * 0.93, cx + side * near * 0.93
        inner = cx + side * (far + near) / 2 * 0.62
        d.line([(edge_top, cy - 34 * u), (inner, cy - 34 * u), (inner, cy + 34 * u), (edge_bot, cy + 34 * u)],
               fill=rgba(LIME, 0.55), width=width(2))
    img.alpha_composite(lines)

    # Floodlight towers on the rim.
    towers = []
    for deg in (200, 340, 160, 20):
        t = math.radians(deg)
        towers.append((cx + 310 * u * math.cos(t), cy + 160 * u * math.sin(t)))
    poles = layer(img.size)
    pd = ImageDraw.Draw(poles)
    for x, y in towers:
        pd.line([x, y, x, y - 70 * u], fill=rgba(LIME, 0.55), width=width(2.5))
    img.alpha_composite(poles)
    blurred(lambda d: [d.ellipse(box(x, y - 74 * u, 70 * u, 70 * u), fill=rgba(LIME, 0.45)) for x, y in towers], 14 * u)
    heads = layer(img.size)
    hd = ImageDraw.Draw(heads)
    for x, y in towers:
        hd.rounded_rectangle(box(x, y - 74 * u, 22 * u, 11 * u), radius=3 * u, fill=rgba((248, 255, 220), 1))
    img.alpha_composite(heads)

    # Guess pin landing on the centre spot, with pulse rings.
    tip_y = cy - 6 * u
    rings = layer(img.size)
    rd = ImageDraw.Draw(rings)
    rd.ellipse(box(cx, tip_y, 96 * u, 34 * u), outline=rgba(PIN, 0.55), width=width(2.5))
    rd.ellipse(box(cx, tip_y, 156 * u, 56 * u), outline=rgba(PIN, 0.25), width=width(2))
    img.alpha_composite(rings)
    blurred(lambda d: d.ellipse(box(cx, tip_y, 44 * u, 12 * u), fill=(0, 0, 0, 150)), 4 * u)

    r = 32 * u
    head_y = tip_y - 88 * u
    # Tangent points from the tip to the head circle give a clean teardrop.
    dist = tip_y - head_y
    ang = math.asin(r / dist)
    tx = r * math.cos(ang)
    ty = r * math.sin(ang)
    pin = layer(img.size)
    pn = ImageDraw.Draw(pin)
    pn.polygon([(cx - tx, head_y + ty), (cx + tx, head_y + ty), (cx, tip_y)], fill=rgba(PIN, 1))
    pn.ellipse(box(cx, head_y, 2 * r, 2 * r), fill=rgba(PIN, 1))
    pn.ellipse(box(cx, head_y, 26 * u, 26 * u), fill=rgba(INK, 1))
    blurred(lambda d: d.ellipse(box(cx, head_y + 6 * u, 2 * r, 2 * r), fill=(0, 0, 0, 110)), 10 * u)
    img.alpha_composite(pin)


def tracked(d, xy, text, fnt, fill, tracking):
    """Draw text with extra letter spacing (tracking in px at 1x)."""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += d.textlength(ch, font=fnt) + tracking * S
    return x


def cover():
    W, H = 1200 * S, 630 * S
    img = background(W, H)
    # Stadium sits right of the title with a clear gap (bowl spans ~620–1160px).
    scx, scy = 890 * S, 350 * S
    draw_globe_grid(img, scx, scy - 20 * S, 400 * S)
    draw_stadium(img, scx, scy, 0.88)

    d = ImageDraw.Draw(img)
    x0 = 80 * S
    label = font("BarlowCondensed-SemiBold.ttf", 26)
    tracked(d, (x0, 118 * S), "DAILY STADIUM GEOGRAPHY GAME", label, rgba(LIME, 1), 3.5)

    big = font("BarlowCondensed-ExtraBold.ttf", 146)
    d.text((x0 - 4 * S, 158 * S), "ARENA", font=big, fill=rgba(TEXT, 1))
    d.text((x0 - 4 * S, 290 * S), "LOCATOR", font=big, fill=rgba(LIME, 1))

    tag = font("BarlowCondensed-SemiBold.ttf", 40)
    d.text((x0, 470 * S), "See the stadium. Find it on the globe.", font=tag, fill=rgba(MUTED, 1))

    url = font("BarlowCondensed-SemiBold.ttf", 30)
    pill_w = d.textlength("arenalocator.lol", font=url) + 44 * S
    d.rounded_rectangle([x0, 536 * S, x0 + pill_w, 584 * S], radius=24 * S, outline=rgba(LIME, 0.6), width=2 * S)
    d.text((x0 + 22 * S, 541 * S), "arenalocator.lol", font=url, fill=rgba(TEXT, 1))

    out = ROOT / "assets" / "og-image.png"
    img.convert("RGB").resize((W // S, H // S), Image.LANCZOS).save(out, optimize=True)
    return out


def icon():
    N = 180 * S
    img = background(N, N)
    draw_stadium(img, N / 2, 106 * S, 0.25)
    out = ROOT / "assets" / "icon-180.png"
    img.convert("RGB").resize((180, 180), Image.LANCZOS).save(out, optimize=True)
    return out


if __name__ == "__main__":
    for path in (cover(), icon()):
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
