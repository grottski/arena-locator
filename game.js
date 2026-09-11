(() => {
  "use strict";

  const ROUNDS = 5;
  const MAX_POINTS = 20; // 5 rounds × 20 = 100
  const SCORE_SCALE_KM = 1500; // points = 20 * e^(-km / 1500), rounded
  const RECENT_KEY = "arena-locator:recent";
  const DAILY_KEY = "arena-locator:daily";
  const SITE_URL = "https://arenalocator.lol";
  // Daily #1 is 10 Sep 2026. Days follow each player's local calendar, like Wordle.
  const DAILY_EPOCH = Date.UTC(2026, 8, 10);
  // Every round opens on this exact view so the globe never hints at the answer.
  const START_VIEW = { lat: 20, lng: 0, altitude: 2.4 };
  const MAX_ZOOM = 24;
  const SPORTS = [
    { key: "all", label: "All sports", icon: "🌍" },
    { key: "soccer", label: "Soccer", icon: "⚽" },
    { key: "american_football", label: "American Football", icon: "🏈" },
    { key: "basketball", label: "Basketball", icon: "🏀" },
    { key: "baseball", label: "Baseball", icon: "⚾" },
    { key: "tennis", label: "Tennis", icon: "🎾" },
  ];
  const ICON = Object.fromEntries(SPORTS.map((s) => [s.key, s.icon]));
  const TIER_NAMES = ["Warm-up", "Easy", "Medium", "Hard", "Expert"];

  const $ = (id) => document.getElementById(id);
  const stadiums = window.STADIUMS || [];
  const byId = new Map(stadiums.map((s) => [s.id, s]));

  const state = {
    mode: "practice", // or "daily"
    day: 0,
    sport: "all",
    rounds: [],
    index: 0,
    total: 0,
    guess: null,
    results: [],
    locked: false,
    armed: false,
  };

  // ---------- helpers ----------
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  function distanceKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  // Great-circle midpoint, so the camera and distance label sit on the arc.
  function midpoint(a, b) {
    const v = [a, b].map(({ lat, lon }) => [
      Math.cos(toRad(lat)) * Math.cos(toRad(lon)),
      Math.cos(toRad(lat)) * Math.sin(toRad(lon)),
      Math.sin(toRad(lat)),
    ]);
    const [x, y, z] = [0, 1, 2].map((i) => v[0][i] + v[1][i]);
    return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
  }
  const pointsFor = (km) => (km < 0.5 ? MAX_POINTS : Math.round(MAX_POINTS * Math.exp(-km / SCORE_SCALE_KM)));
  const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km).toLocaleString()} km`);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (arr) => arr.reduce((t, n) => t + n, 0);
  const shuffle = (arr, rand = Math.random) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pick = (arr, rand = Math.random) => arr[Math.floor(rand() * arr.length)];
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- storage ----------
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }
  const loadRecent = () => new Set(readJSON(RECENT_KEY, []));
  const saveRecent = (ids) => writeJSON(RECENT_KEY, [...loadRecent(), ...ids].slice(-60));

  // ---------- rounds ----------
  // Round N draws from difficulty tier N, so the game ramps from famous to obscure.
  function buildRounds(sport) {
    const recent = loadRecent();
    const sportOrder = sport === "all" ? shuffle(SPORTS.slice(1).map((s) => s.key)) : Array(ROUNDS).fill(sport);
    const chosen = [];
    for (let r = 0; r < ROUNDS; r++) {
      const tier = r + 1;
      const inTier = stadiums.filter((s) => s.sport === sportOrder[r % sportOrder.length] && s.tier === tier && !chosen.includes(s));
      const fresh = inTier.filter((s) => !recent.has(s.id));
      chosen.push(pick(fresh.length ? fresh : inTier));
    }
    return chosen;
  }

  // ---------- daily challenge ----------
  function todayNumber(now = new Date()) {
    return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - DAILY_EPOCH) / 864e5) + 1;
  }
  function msUntilTomorrow(now = new Date()) {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight - now;
  }
  const fmtCountdown = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  };

  // Small seeded PRNG: the same day number always yields the same puzzle.
  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One stadium per sport, in a daily-shuffled order, tiers 1→5.
  function dailyRounds(day) {
    const rand = mulberry32(Math.imul(day, 2654435761));
    const sports = shuffle(SPORTS.slice(1).map((s) => s.key), rand);
    return sports.map((sport, r) => {
      const pool = stadiums
        .filter((s) => s.sport === sport && s.tier === r + 1)
        .sort((a, b) => a.id.localeCompare(b.id));
      return pick(pool, rand);
    });
  }

  const dailyStore = () => readJSON(DAILY_KEY, {});
  const dailyEntry = (day) => dailyStore()[day] || null;
  function saveDailyEntry(day, entry) {
    const all = dailyStore();
    all[day] = entry;
    writeJSON(DAILY_KEY, all);
  }

  function dailyStats() {
    const done = Object.entries(dailyStore())
      .filter(([, e]) => e.done)
      .map(([d, e]) => ({ day: +d, score: sum(e.results.map((r) => r.pts)) }));
    const days = new Set(done.map((d) => d.day));
    const today = todayNumber();
    let streak = 0;
    for (let d = days.has(today) ? today : today - 1; days.has(d); d--) streak++;
    const scores = done.map((d) => d.score);
    return {
      played: done.length,
      streak,
      best: scores.length ? Math.max(...scores) : 0,
      avg: scores.length ? Math.round(sum(scores) / scores.length) : 0,
    };
  }

  function renderStats(el) {
    const s = dailyStats();
    el.hidden = !s.played;
    el.innerHTML = [["Played", s.played], ["Streak", s.streak], ["Best", s.best], ["Average", s.avg]]
      .map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  }

  // ---------- sharing ----------
  const square = (pts) => (pts >= 16 ? "🟩" : pts >= 10 ? "🟨" : pts >= 4 ? "🟧" : "🟥");

  function shareText() {
    return [
      `Arena Locator #${state.day} 🏟️ ${state.total}/100`,
      ...state.results.map((r) => `${ICON[r.stadium.sport]} ${square(r.pts)} ${r.pts}`),
      SITE_URL,
    ].join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs HTTPS; fall back to the old selection trick.
      const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
      Object.assign(ta.style, { position: "fixed", opacity: "0" });
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
      ta.remove();
      return ok;
    }
  }

  async function share() {
    const text = shareText();
    // Phones get the native share sheet; desktops just copy.
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    toast((await copyText(text)) ? "Score copied. Paste it anywhere!" : "Couldn't copy. Try again.");
  }

  let toastTimer;
  function toast(msg) {
    $("toast").textContent = msg;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2400);
  }

  // ---------- photo viewer (zoom + pan) ----------
  // The image is sized in real pixels (not CSS-scaled) so it stays sharp at any zoom,
  // and the full-resolution original is swapped in the first time you zoom.
  const view = { s: 1, x: 0, y: 0, fitW: 0, fitH: 0, ratio: 0, fullUrl: "", fullState: "none" };
  const viewerEl = $("viewer");
  const photoEl = $("photo");

  function viewerSize() {
    return { W: viewerEl.clientWidth, H: viewerEl.clientHeight };
  }

  function fitPhoto() {
    const { W, H } = viewerSize();
    if (!view.ratio || !W || !H) return;
    const k = Math.min(W / view.ratio, H);
    view.fitW = k * view.ratio;
    view.fitH = k;
  }

  function applyView() {
    const { W, H } = viewerSize();
    const w = view.fitW * view.s;
    const h = view.fitH * view.s;
    view.x = w <= W ? (W - w) / 2 : clamp(view.x, W - w, 0);
    view.y = h <= H ? (H - h) / 2 : clamp(view.y, H - h, 0);
    Object.assign(photoEl.style, { width: `${w}px`, height: `${h}px`, left: `${view.x}px`, top: `${view.y}px` });
    viewerEl.classList.toggle("zoomed", view.s > 1.01);
    const status = $("zoom-status");
    status.hidden = view.s <= 1.01;
    status.textContent = `${view.s.toFixed(view.s < 10 ? 1 : 0)}×${view.fullState === "loading" ? " · loading full resolution…" : ""}`;
    if (view.s > 1.01) $("zoom-tip").style.opacity = 0;
  }

  function zoomAt(cx, cy, s) {
    const next = clamp(s, 1, MAX_ZOOM);
    // Keep the image point under (cx, cy) fixed while scaling.
    view.x = cx - ((cx - view.x) * next) / view.s;
    view.y = cy - ((cy - view.y) * next) / view.s;
    view.s = next;
    if (next > 1.3) loadFullRes();
    applyView();
  }
  const zoomCenter = (factor) => { const { W, H } = viewerSize(); zoomAt(W / 2, H / 2, view.s * factor); };

  function resetZoom() {
    view.s = 1;
    applyView();
  }

  function loadFullRes() {
    if (view.fullState !== "none" || !view.fullUrl || view.fullUrl === photoEl.src) return;
    view.fullState = "loading";
    const url = view.fullUrl;
    const img = new Image();
    img.onload = () => {
      if (url !== view.fullUrl) return; // round changed meanwhile
      view.fullState = "done";
      photoEl.src = url;
      applyView();
    };
    img.onerror = () => { view.fullState = "failed"; applyView(); };
    img.src = url;
  }

  function showPhoto(stadium) {
    view.s = 1;
    view.ratio = 0;
    view.fullUrl = stadium.full || stadium.photo;
    view.fullState = "none";
    photoEl.style.opacity = 0;
    $("zoom-status").hidden = true;
    $("zoom-tip").style.opacity = 1;
    $("photo-loading").hidden = false;
    $("photo-loading").textContent = "Loading photo…";
    $("photo-backdrop").style.backgroundImage = `url("${stadium.photo}")`;
    photoEl.onload = () => {
      if (!view.ratio) {
        view.ratio = photoEl.naturalWidth / photoEl.naturalHeight;
        fitPhoto();
        applyView();
      }
      photoEl.style.opacity = 1;
      $("photo-loading").hidden = true;
    };
    photoEl.onerror = () => { $("photo-loading").textContent = "Photo failed to load"; };
    photoEl.src = stadium.photo;
  }

  function initViewer() {
    const pointers = new Map();
    let pinch = null;
    let lastTap = 0;

    const local = (e) => {
      const r = viewerEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    viewerEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = local(e);
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const speed = e.ctrlKey ? 0.012 : 0.0025;
      zoomAt(p.x, p.y, view.s * Math.exp(-e.deltaY * speed));
    }, { passive: false });

    viewerEl.addEventListener("pointerdown", (e) => {
      viewerEl.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      }
      viewerEl.classList.add("dragging");
    });

    viewerEl.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = local(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        view.x += mid.x - pinch.mid.x;
        view.y += mid.y - pinch.mid.y;
        pinch.mid = mid;
        zoomAt(mid.x, mid.y, pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
      } else if (pointers.size === 1) {
        view.x += cur.x - prev.x;
        view.y += cur.y - prev.y;
        applyView();
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) viewerEl.classList.remove("dragging");
    };
    viewerEl.addEventListener("pointerup", (e) => {
      // Double-tap (touch) mirrors double-click.
      if (e.pointerType === "touch" && pointers.size === 1) {
        const now = Date.now();
        if (now - lastTap < 300) { const p = local(e); view.s > 1.5 ? resetZoom() : zoomAt(p.x, p.y, 4); }
        lastTap = now;
      }
      end(e);
    });
    viewerEl.addEventListener("pointercancel", end);
    viewerEl.addEventListener("dblclick", (e) => {
      const p = local(e);
      view.s > 1.5 ? resetZoom() : zoomAt(p.x, p.y, 4);
    });

    // Keep the same spot centred when the panel resizes (e.g. full screen).
    new ResizeObserver(() => {
      if (!view.ratio) return;
      const { W, H } = viewerSize();
      const fx = view.fitW ? (W / 2 - view.x) / (view.fitW * view.s) : 0.5;
      const fy = view.fitH ? (H / 2 - view.y) / (view.fitH * view.s) : 0.5;
      fitPhoto();
      view.x = W / 2 - fx * view.fitW * view.s;
      view.y = H / 2 - fy * view.fitH * view.s;
      applyView();
    }).observe(viewerEl);

    $("zoom-in").addEventListener("click", () => zoomCenter(1.6));
    $("zoom-out").addEventListener("click", () => zoomCenter(1 / 1.6));
    $("zoom-reset").addEventListener("click", resetZoom);
    $("fullscreen").addEventListener("click", toggleFullscreen);
  }

  function toggleFullscreen(force) {
    const on = typeof force === "boolean" ? force : !$("photo-panel").classList.contains("fs");
    $("photo-panel").classList.toggle("fs", on);
    $("fullscreen").textContent = on ? "✕" : "⤢";
    $("fullscreen").title = on ? "Exit full screen (Esc)" : "Full screen (F)";
    if (on) loadFullRes();
  }

  // ---------- globe ----------
  let globe;

  function markerElement(d) {
    const el = document.createElement("div");
    if (d.kind === "label") {
      el.className = "arc-label";
      el.textContent = d.text;
      return el;
    }
    el.className = `pin pin-${d.kind}`;
    el.innerHTML = `<svg viewBox="0 0 24 32" width="26" height="34" aria-hidden="true">
      <path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z"/>
      <circle cx="12" cy="12" r="4.5" fill="#0b1200"/></svg>`;
    return el;
  }

  function initGlobe() {
    const el = $("globe");
    globe = Globe()(el)
      .globeImageUrl("assets/earth.jpg")
      .bumpImageUrl("assets/earth-topology.png")
      .backgroundColor("rgba(0,0,0,0)")
      .atmosphereColor("#7fb2ff")
      .atmosphereAltitude(0.18)
      .polygonCapColor(() => "rgba(0,0,0,0)")
      .polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor(() => "rgba(255,255,255,0.45)")
      .polygonAltitude(0.002)
      .htmlLat("lat").htmlLng("lon").htmlAltitude(0.005)
      .htmlElement(markerElement)
      .arcStartLat("sLat").arcStartLng("sLon").arcEndLat("eLat").arcEndLng("eLon")
      .arcColor(() => ["#ff5d73", "#c6f432"]).arcStroke(0.6)
      .arcDashLength(0.4).arcDashGap(0.15).arcDashAnimateTime(1600)
      .ringLat("lat").ringLng("lon").ringColor(() => (t) => `rgba(198,244,50,${1 - t})`)
      .ringMaxRadius(4).ringPropagationSpeed(3).ringRepeatPeriod(900)
      .onGlobeClick(({ lat, lng }) => placeGuess(lat, lng))
      .onPolygonClick((_p, _e, { lat, lng }) => placeGuess(lat, lng));

    fetch("assets/countries.geojson")
      .then((r) => r.json())
      .then((geo) => globe.polygonsData(geo.features.filter((f) => f.properties.ISO_A2 !== "AQ")))
      .catch(() => { /* borders are optional */ });

    globe.controls().autoRotate = false;

    // The click that starts a round can land on the freshly created canvas;
    // only accept guesses from a press that began on the globe.
    el.addEventListener("pointerdown", () => { state.armed = true; });

    const resize = () => globe.width(el.clientWidth).height(el.clientHeight);
    new ResizeObserver(resize).observe(el);
    resize();
  }

  function resetGlobe() {
    globe.htmlElementsData([]).arcsData([]).ringsData([]);
    globe.pointOfView(START_VIEW, 0);
  }

  function placeGuess(lat, lon) {
    if (state.locked || !state.armed) return;
    state.guess = { lat, lon };
    globe.htmlElementsData([{ lat, lon, kind: "guess" }]);
    $("guess-btn").disabled = false;
    $("guess-btn").textContent = "Guess";
    $("globe-hint").textContent = "Click again to move your pin";
  }

  // ---------- menu ----------
  function show(id) {
    for (const s of ["menu", "game", "final"]) $(s).hidden = s !== id;
  }

  function renderPicker() {
    $("sport-picker").innerHTML = SPORTS.map((s) => {
      const n = s.key === "all" ? stadiums.length : stadiums.filter((x) => x.sport === s.key).length;
      return `<button class="chip ${s.key === state.sport ? "on" : ""}" data-sport="${s.key}">${s.icon} ${s.label} <span class="muted">${n}</span></button>`;
    }).join("");
  }

  function renderMenu() {
    const day = todayNumber();
    const entry = dailyEntry(day);
    $("daily-title").textContent = `#${day}`;
    $("daily-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (entry?.done) {
      const score = sum(entry.results.map((r) => r.pts));
      $("daily-desc").innerHTML = `You scored <strong>${score}/100</strong> today. Next daily in <strong class="countdown"></strong>`;
      $("daily-btn").textContent = "See results & share";
    } else if (entry?.results?.length) {
      $("daily-desc").textContent = `In progress: round ${entry.results.length + 1} of ${ROUNDS}.`;
      $("daily-btn").textContent = "Continue";
    } else {
      $("daily-desc").textContent = "5 stadiums, one per sport, getting harder each round. Same puzzle for everyone today.";
      $("daily-btn").textContent = "Play today's";
    }
    renderStats($("stats"));
    renderPicker();
    tickCountdown();
    show("menu");
  }

  // Updates every visible countdown, and rolls the menu over at midnight.
  let renderedDay = todayNumber();
  function tickCountdown() {
    const text = fmtCountdown(msUntilTomorrow());
    document.querySelectorAll(".countdown").forEach((el) => { el.textContent = text; });
    const day = todayNumber();
    if (day !== renderedDay) {
      renderedDay = day;
      if (!$("menu").hidden) renderMenu();
    }
  }

  // ---------- flow ----------
  function startDaily() {
    const day = todayNumber();
    const entry = dailyEntry(day);
    state.mode = "daily";
    state.day = day;
    state.rounds = dailyRounds(day);
    // Resume a daily in progress (or show the finished one) instead of re-rolling.
    state.results = (entry?.results || [])
      .map((r) => ({ stadium: byId.get(r.id), km: r.km, pts: r.pts }))
      .filter((r) => r.stadium);
    state.total = sum(state.results.map((r) => r.pts));
    saveRecent(state.rounds.map((s) => s.id));
    if (entry?.done) return finish();
    state.index = state.results.length;
    enterGame();
  }

  function startPractice() {
    state.mode = "practice";
    state.day = 0;
    state.rounds = buildRounds(state.sport);
    state.index = 0;
    state.total = 0;
    state.results = [];
    saveRecent(state.rounds.map((s) => s.id));
    enterGame();
  }

  function enterGame() {
    show("game");
    if (!globe) initGlobe();
    // Warm the cache so later rounds load instantly.
    state.rounds.slice(state.index).forEach((s) => { new Image().src = s.photo; });
    startRound();
  }

  function startRound() {
    const s = state.rounds[state.index];
    state.guess = null;
    state.locked = false;
    state.armed = false;
    $("result").hidden = true;
    $("guess-btn").hidden = false;
    $("guess-btn").disabled = true;
    $("guess-btn").textContent = "Place a pin";
    $("globe-hint").hidden = false;
    $("globe-hint").textContent = "Click the globe to drop your pin";
    $("score").textContent = state.total;
    const mode = state.mode === "daily" ? `Daily #${state.day}` : "Practice";
    $("round-label").textContent = `${mode} · Round ${state.index + 1}/${ROUNDS} · ${TIER_NAMES[s.tier - 1]}`;
    $("round-dots").innerHTML = Array.from({ length: ROUNDS }, (_, i) =>
      `<span class="dot ${i < state.index ? "done" : i === state.index ? "now" : ""}"></span>`).join("");
    $("sport-badge").textContent = `${ICON[s.sport]} ${s.sportLabel}`;
    showPhoto(s);
    resetGlobe();
  }

  function submitGuess() {
    if (!state.guess || state.locked) return;
    state.locked = true;
    const s = state.rounds[state.index];
    const km = distanceKm(state.guess, s);
    const pts = pointsFor(km);
    state.total += pts;
    state.results.push({ stadium: s, km, pts });
    if (state.mode === "daily") {
      saveDailyEntry(state.day, {
        results: state.results.map((r) => ({ id: r.stadium.id, km: Math.round(r.km * 10) / 10, pts: r.pts })),
        done: state.results.length === ROUNDS,
      });
    }

    // Show the result card first: it takes space below the globe, the globe
    // shrinks to fit above it, and the camera then frames both pins.
    $("guess-btn").hidden = true;
    $("globe-hint").hidden = true;
    $("score").textContent = state.total;
    $("res-points").textContent = pts;
    $("res-bar").style.width = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => { $("res-bar").style.width = `${(pts / MAX_POINTS) * 100}%`; }));
    $("res-dist").textContent = km < 0.5 ? "Bullseye! You found it." : `${fmtKm(km)} away`;
    $("res-name").textContent = s.name;
    const where = [s.place, s.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
    const cap = s.capacity ? ` · ${s.capacity.toLocaleString()} seats` : "";
    $("res-meta").textContent = `${ICON[s.sport]} ${where}${cap}`;
    const c = s.credit || {};
    const lic = c.licenseUrl ? `<a href="${escapeHtml(c.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(c.license)}</a>` : escapeHtml(c.license || "");
    $("res-credit").innerHTML = `Photo: ${escapeHtml(c.author || "Unknown")} · ${lic} · <a href="${escapeHtml(c.source || "#")}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
    $("next-btn").textContent = state.index === ROUNDS - 1 ? "See final score" : "Next round";
    $("result").hidden = false;

    const mid = midpoint(state.guess, s);
    const markers = [
      { lat: state.guess.lat, lon: state.guess.lon, kind: "guess" },
      { lat: s.lat, lon: s.lon, kind: "answer" },
    ];
    if (km >= 50) markers.push({ lat: mid.lat, lon: mid.lon, kind: "label", text: fmtKm(km) });
    globe.htmlElementsData(markers);
    globe.arcsData([{ sLat: state.guess.lat, sLon: state.guess.lon, eLat: s.lat, eLon: s.lon }]);
    globe.ringsData([{ lat: s.lat, lon: s.lon }]);
    globe.pointOfView({ lat: mid.lat, lng: mid.lon, altitude: clamp(km / 3000, 0.35, 2.8) }, 1200);
  }

  function nextRound() {
    if (state.index === ROUNDS - 1) return finish();
    state.index++;
    startRound();
  }

  function finish() {
    toggleFullscreen(false);
    const daily = state.mode === "daily";
    const t = state.total;
    const verdict =
      t >= 88 ? "Groundskeeper of the world. Incredible." :
      t >= 68 ? "You clearly watch a lot of sports." :
      t >= 44 ? "Solid. You know your venues." :
      t >= 24 ? "Decent start. The later rounds are tough." :
      "The hard rounds got you. Try again!";
    const sportLabel = SPORTS.find((s) => s.key === state.sport).label;
    $("final-title").textContent = daily ? `Daily Challenge #${state.day}` : `Practice · ${sportLabel}`;
    $("final-score").textContent = t;
    $("final-verdict").textContent = verdict;
    $("final-list").innerHTML = state.results.map(({ stadium: s, km, pts }, i) => `
      <li>
        <img src="${escapeHtml(s.photo)}" alt="">
        <div>
          <div class="fl-name">${escapeHtml(s.name)}</div>
          <div class="fl-sub">R${i + 1} · ${TIER_NAMES[s.tier - 1]} · ${ICON[s.sport]} ${escapeHtml(s.country || "")} · ${fmtKm(km)} off</div>
        </div>
        <div class="fl-pts">${square(pts)} ${pts}</div>
      </li>`).join("");
    $("share-block").hidden = !daily;
    $("final-stats").hidden = true;
    if (daily) renderStats($("final-stats"));
    $("again-btn").textContent = daily ? "Practice" : "Play again";
    show("final");
    tickCountdown();
  }

  function quitToMenu() {
    toggleFullscreen(false);
    renderMenu();
  }

  // ---------- events ----------
  $("sport-picker").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.sport = chip.dataset.sport;
    renderPicker();
  });
  $("daily-btn").addEventListener("click", startDaily);
  $("practice-btn").addEventListener("click", startPractice);
  $("guess-btn").addEventListener("click", submitGuess);
  $("next-btn").addEventListener("click", nextRound);
  $("again-btn").addEventListener("click", startPractice);
  $("menu-btn").addEventListener("click", renderMenu);
  $("quit-btn").addEventListener("click", quitToMenu);
  $("share-btn").addEventListener("click", share);
  document.addEventListener("keydown", (e) => {
    if ($("game").hidden) return;
    const fs = $("photo-panel").classList.contains("fs");
    if (e.key === "Escape" && fs) return toggleFullscreen(false);
    if (e.key === "f" || e.key === "F") return toggleFullscreen();
    if (e.key === "+" || e.key === "=") return zoomCenter(1.6);
    if (e.key === "-" || e.key === "_") return zoomCenter(1 / 1.6);
    if (e.key === "0") return resetZoom();
    if ((e.key !== "Enter" && e.key !== " ") || fs) return;
    e.preventDefault();
    if (!$("result").hidden) nextRound();
    else submitGuess();
  });

  initViewer();
  if (!stadiums.length) {
    $("daily-btn").disabled = true;
    $("practice-btn").disabled = true;
    $("daily-desc").textContent = "No data. Run scripts/build_data.py.";
  }
  renderMenu();
  setInterval(tickCountdown, 1000);
})();
