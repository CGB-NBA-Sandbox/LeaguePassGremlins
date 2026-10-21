/*
  Box score: tap a live or finished game to see every player's stats, starters first, then the
  bench, with a toggle between the two teams. Data comes from ESPN's game summary and refreshes
  every 30 seconds while the game is live.
*/
(() => {
  "use strict";
  const L = window.__lpg;
  if (!L) return;
  const { esc } = L;
  const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=";
  const REFRESH_MS = 30e3;

  // Column order as requested. `key` matches ESPN's stat keys, so ESPN reordering can't scramble them.
  const COLS = [
    { k: "minutes", h: "MIN" }, { k: "points", h: "PTS", strong: true }, { k: "rebounds", h: "REB" },
    { k: "assists", h: "AST" }, { k: "steals", h: "STL" }, { k: "blocks", h: "BLK" },
    { k: "turnovers", h: "TO" }, { k: "fouls", h: "PF" }, { k: "plusMinus", h: "+/-", pm: true },
    { k: "fieldGoalsMade-fieldGoalsAttempted", h: "FG", wide: true },
    { k: "freeThrowsMade-freeThrowsAttempted", h: "FT", wide: true },
    { k: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", h: "3PT", wide: true },
    { k: "offensiveRebounds", h: "OREB" }, { k: "defensiveRebounds", h: "DREB" }
  ];

  const state = { id: null, data: null, side: 0, timer: null, error: "", loading: false, opener: null, token: 0 };
  const cache = new Map(); // finished games don't change, so reopening them is instant
  const ownerOf = (name) => (L.teamIndex.find((t) => t.label === name) || {}).owner || null;
  const logoOf = (t) => (t && (t.logo || (t.logos && t.logos[0] && t.logos[0].href))) || "";

  // ---------- data ----------
  function parse(j) {
    const comp = (j.header && j.header.competitions && j.header.competitions[0]) || {};
    const st = (comp.status && comp.status.type) || {};
    const meta = {};
    (comp.competitors || []).forEach((c) => {
      meta[c.team.id] = { homeAway: c.homeAway, score: c.score, winner: c.winner === true, team: c.team };
    });
    const sides = ((j.boxscore && j.boxscore.players) || []).map((p, i) => {
      const t = p.team || {};
      const m = meta[t.id] || {};
      const block = (p.statistics && p.statistics[0]) || { keys: [], athletes: [], totals: [] };
      const idx = Object.fromEntries((block.keys || []).map((key, n) => [key, n]));
      const pick = (arr) => COLS.map((c) => { const v = idx[c.k] != null ? (arr || [])[idx[c.k]] : ""; return v == null ? "" : String(v); });
      const players = (block.athletes || []).map((a) => {
        const stats = a.stats || [];
        const ath = a.athlete || {};
        return {
          id: ath.id, name: ath.displayName || ath.shortName || "", short: ath.shortName || ath.displayName || "",
          pos: (ath.position && ath.position.abbreviation) || "", jersey: ath.jersey || "",
          starter: a.starter === true, played: stats.length > 0 && !a.didNotPlay, reason: a.reason || "", vals: pick(stats)
        };
      });
      const tm = (t.name || t.shortDisplayName || t.abbreviation || "");
      return {
        abbr: t.abbreviation || "", name: tm, logo: logoOf(t) || logoOf(m.team), score: m.score,
        homeAway: m.homeAway || (i === 0 ? "away" : "home"), winner: !!m.winner,
        players, totals: pick(block.totals)
      };
    });
    sides.sort((a, b) => (a.homeAway === "away" ? 0 : 1) - (b.homeAway === "away" ? 0 : 1)); // away first, like the game cards
    return { state: st.state || "pre", status: st.shortDetail || st.detail || "", sides };
  }

  async function fetchBox(id, force) {
    const hit = cache.get(id);
    if (hit && !force) return hit;
    const r = await fetch(SUMMARY + encodeURIComponent(id), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = parse(await r.json());
    if (d.state === "post") cache.set(id, d);
    return d;
  }

  // ---------- rendering ----------
  let el = null;
  function build() {
    el = document.createElement("div");
    el.className = "bx";
    el.id = "bx";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Box score");
    el.innerHTML = `
      <div class="bx-back"></div>
      <div class="bx-panel">
        <div class="bx-head">
          <span class="bx-status" id="bxStatus"></span>
          <button type="button" class="bx-close" id="bxClose" aria-label="Close box score">×</button>
        </div>
        <div class="bx-teams" id="bxTeams" role="tablist" aria-label="Teams"></div>
        <div class="bx-body" id="bxBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector(".bx-back").onclick = close;
    el.querySelector("#bxClose").onclick = close;
    el.querySelector("#bxTeams").addEventListener("click", (e) => {
      const b = e.target.closest("[data-side]");
      if (!b) return;
      state.side = Number(b.dataset.side);
      paint();
      const sc = el.querySelector(".bx-scroll"); if (sc) sc.scrollLeft = 0;
    });
    el.querySelector("#bxBody").addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) load(true); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) close(); });
  }

  function rowHTML(p, live) {
    if (!p.played) {
      const why = live ? "Hasn't played yet" : (p.reason ? p.reason.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "Did not play");
      return `<tr class="dnp"><th scope="row"><span class="nm" title="${esc(p.name)}">${esc(p.short)}</span><small>${esc(p.pos)}</small></th><td colspan="${COLS.length}">${esc(why)}</td></tr>`;
    }
    return `<tr><th scope="row"><span class="nm" title="${esc(p.name)}">${esc(p.short)}</span><small>${esc(p.pos)}</small></th>${
      COLS.map((c, i) => {
        const v = p.vals[i];
        const cls = [c.strong ? "strong" : "", c.wide ? "wide" : "", c.pm ? (v.startsWith("+") && v !== "+0" ? "pos" : v.startsWith("-") ? "neg" : "") : ""].filter(Boolean).join(" ");
        return `<td${cls ? ` class="${cls}"` : ""}>${esc(v)}</td>`;
      }).join("")}</tr>`;
  }

  function paint() {
    if (!el) return;
    const d = state.data;
    const status = el.querySelector("#bxStatus"), teams = el.querySelector("#bxTeams"), body = el.querySelector("#bxBody");
    if (!d) {
      status.textContent = "";
      teams.innerHTML = "";
      body.innerHTML = state.error
        ? `<p class="bx-msg error">${esc(state.error)}</p><button type="button" class="bx-retry" data-retry>Try again</button>`
        : `<p class="bx-msg">Loading box score…</p>`;
      return;
    }
    const live = d.state === "in";
    status.innerHTML = live ? `<i class="live-dot"></i>${esc(d.status)}` : esc(d.status || (d.state === "pre" ? "Not started" : "Final"));
    if (!d.sides.length || d.state === "pre") {
      teams.innerHTML = "";
      body.innerHTML = `<p class="bx-msg">The box score shows up once the game tips off.</p>`;
      return;
    }
    const side = d.sides[state.side] || d.sides[0];
    teams.innerHTML = d.sides.map((s, i) => {
      const owner = ownerOf(s.name);
      const o = owner ? L.owners.find((x) => x.name === owner) : null;
      return `<button type="button" role="tab" data-side="${i}" aria-selected="${i === state.side}"${o ? ` style="--c:${esc(o.color)}"` : ""}>
        ${s.logo ? `<img src="${esc(s.logo)}" alt="" width="26" height="26">` : ""}
        <span class="bt"><b>${esc(s.abbr || s.name)}</b>${owner ? `<small>${esc(owner)}</small>` : `<small>${s.homeAway === "home" ? "Home" : "Away"}</small>`}</span>
        <span class="bs${s.winner && d.state === "post" ? " win" : ""}">${esc(s.score == null ? "" : s.score)}</span>
      </button>`;
    }).join("");

    const starters = side.players.filter((p) => p.starter && p.played);
    const bench = side.players.filter((p) => !p.starter && p.played);
    const out = side.players.filter((p) => !p.played);
    const sec = (title, list) => (list.length ? `<tr class="sec"><th scope="rowgroup">${title}</th><td colspan="${COLS.length}"></td></tr>${list.map((p) => rowHTML(p, live)).join("")}` : "");
    body.innerHTML = `
      <div class="bx-scroll" tabindex="0" aria-label="${esc(side.name)} player stats, scrolls sideways">
        <table class="bx-tbl">
          <thead><tr><th scope="col">Player</th>${COLS.map((c) => `<th scope="col"${c.wide ? ' class="wide"' : ""}>${c.h}</th>`).join("")}</tr></thead>
          <tbody>
            ${sec("Starters", starters)}
            ${sec("Bench", bench)}
            ${sec(live ? "Not in yet" : "Did not play", out)}
            <tr class="tot"><th scope="row">Team</th>${COLS.map((c, i) => `<td${c.wide ? ' class="wide"' : ""}>${esc(side.totals[i] || "")}</td>`).join("")}</tr>
          </tbody>
        </table>
      </div>
      <p class="bx-foot"><span>${live ? "Live. Updates every 30 seconds. " : ""}</span><span id="bxSide">Scroll sideways for more stats.</span></p>`;
    fitHint();
  }

  // Only mention side scrolling when the table is actually wider than the screen.
  function fitHint() {
    if (!el) return;
    const sc = el.querySelector(".bx-scroll"), hint = el.querySelector("#bxSide");
    if (sc && hint) hint.hidden = sc.scrollWidth <= sc.clientWidth + 1;
  }
  window.addEventListener("resize", fitHint);

  async function load(force) {
    const token = ++state.token;
    clearTimeout(state.timer);
    const id = state.id;
    state.loading = true;
    try {
      const d = await fetchBox(id, force);
      if (token !== state.token || state.id !== id) return;
      const keepScroll = el.querySelector(".bx-scroll");
      const left = keepScroll ? keepScroll.scrollLeft : 0, top = el.querySelector(".bx-body").scrollTop;
      state.data = d; state.error = "";
      paint();
      const sc = el.querySelector(".bx-scroll"); if (sc) sc.scrollLeft = left;
      el.querySelector(".bx-body").scrollTop = top;
      if (d.state === "in") {
        // Refresh while the game is live; pause quietly if the phone is locked or the tab is hidden.
        const tick = () => {
          if (el.hidden) return;
          if (document.hidden) { state.timer = setTimeout(tick, REFRESH_MS); return; }
          load(true);
        };
        state.timer = setTimeout(tick, REFRESH_MS);
      }
    } catch (e) {
      if (token !== state.token || state.id !== id) return;
      state.error = "Couldn't load the box score. Check your connection and try again.";
      if (!state.data) paint();
    }
    state.loading = false;
  }

  function open(id, opener) {
    if (!el) build();
    state.id = String(id); state.data = null; state.error = ""; state.side = 0; state.opener = opener || null;
    const cached = cache.get(state.id);
    if (cached) state.data = cached;
    el.hidden = false;
    document.body.classList.add("bx-open");
    paint();
    el.querySelector("#bxClose").focus({ preventScroll: true });
    load(false);
  }

  function close() {
    if (!el || el.hidden) return;
    el.hidden = true;
    state.token++;
    clearTimeout(state.timer);
    document.body.classList.remove("bx-open");
    if (state.opener && document.contains(state.opener)) state.opener.focus({ preventScroll: true });
  }

  // Tap or press Enter/Space on any live or finished game card.
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-game]");
    if (card && !e.target.closest("a, button")) open(card.dataset.game, card);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-game]")) { e.preventDefault(); open(e.target.dataset.game, e.target); }
  });

  window.LPGBox = { open, close, parse };
})();
