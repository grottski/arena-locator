# Arena Locator

See a stadium photo, find it on the globe. Five rounds, each harder than the last.

Live at **https://arenalocator.lol**

## Run it locally

```bash
python3 scripts/serve.py
```

Then open http://localhost:8765, or the "phone" address it prints from any device on the
same Wi-Fi. There's no build step. It's plain HTML/CSS/JS, and the server turns caching off
so reloads always show your latest edits.

## Deploy

The site is hosted on GitHub Pages from the `main` branch root. Pushing to `main` redeploys
within a minute or two. The `CNAME` file holds the custom domain.

DNS for `arenalocator.lol` (at Porkbun):

| Type | Host | Answer |
|---|---|---|
| A | *(blank)* | 185.199.108.153 |
| A | *(blank)* | 185.199.109.153 |
| A | *(blank)* | 185.199.110.153 |
| A | *(blank)* | 185.199.111.153 |
| CNAME | www | grottski.github.io |

## How it works

- **Data:** `data/stadiums.js` holds 100 venues each for soccer, American football,
  basketball, baseball and tennis, generated from Wikidata. Photos are hotlinked from
  Wikimedia Commons and credited on the result screen.
- **Difficulty:** within each sport, venues are ranked by how many Wikipedia language
  editions have an article on them (a proxy for fame) and split into 5 tiers of 20.
  Round 1 draws from tier 1 (most famous), round 5 from tier 5.
- **Sports mix:** "All sports" gives one round of each sport, in random order.
- **Scoring:** `20 × e^(−distance_km / 1500)`, rounded, per round, so the maximum is 100.
  A guess 100 km off earns 19, 500 km 14, 1,000 km 10, 2,500 km 4, and 5,000 km 1.
- **Repeats:** the last ~60 stadiums shown are remembered in the browser and skipped
  when possible.
- **No globe hints:** the globe doesn't spin, and every round opens on the same view.
- **Photo zoom:** scroll or pinch to zoom (up to 24×), drag to pan, double-click to zoom
  in, `+` / `−` / `0` keys, and `F` for full screen. The full-resolution original from
  Commons loads the first time you zoom in.
- **Sport assignment:** each venue gets the sport with the strongest evidence (venue
  type, home teams, tournaments). Ice hockey, cricket and rugby are scored too, so a
  hockey arena or cricket ground is dropped rather than labelled basketball or soccer.

## Curating photos

1. Open http://localhost:8765/review.html.
2. Click any stadium with a bad photo (wrong sport, visible name or logo, a concert
   instead of a game, and so on) to mark it excluded.
3. Press **Copy excluded IDs** and paste them into `data/overrides.json` under `"exclude"`.
4. Run `python3 scripts/build_data.py`. The next venue in line fills each gap. API
   responses are cached in `data/.cache`, so rebuilds take seconds. Use `--refresh` to
   re-download.

`"sport"` in `overrides.json` forces a venue into a sport even if Wikidata's tagging
misses it (that's how Wimbledon and Rod Laver Arena got in).

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `game.js` | The game |
| `review.html` | Photo curation page |
| `scripts/build_data.py` | Wikidata/Commons → `data/stadiums.js` |
| `scripts/serve.py` | Local no-cache server, reachable from your phone |
| `CNAME` | Custom domain for GitHub Pages |
| `data/overrides.json` | Hand fixes: excludes and forced sports |
| `assets/` | Globe library, Earth textures and country borders (local, so no CDN is needed) |
