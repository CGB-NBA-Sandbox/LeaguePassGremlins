(() => {
  "use strict";

  const C = window.LEAGUE;
  const API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
  const TZ = "America/New_York";
  const CACHE = `lpg:${C.season}:v1:`;

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const etYMD = (d) => etFmt.format(d);
  const parseYMD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
  const dayList = (a, b) => { const out = []; for (let d = parseYMD(a); ymd(d) <= b; d = addDays(d, 1)) out.push(ymd(d)); return out; };
  const compact = (s) => s.replace(/-/g, "");
  const shortDate = (s) => parseYMD(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const longDay = (s) => parseYMD(s).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const pctStr = (p) => (p == null ? "–" : (p * 100).toFixed(1) + "%");
  const money = (n) => "$" + (Number.isInteger(n) ? n : n.toFixed(2));
  const today = () => etYMD(new Date());

  // ---------- owners & teams ----------
  const owners = C.owners;
  const ownerByName = Object.fromEntries(owners.map((o) => [o.name, o]));
  const teamIndex = owners.flatMap((o) => o.teams.map((t) => ({ nick: t.toLowerCase(), label: t, owner: o.name })));
  const logos = {};

  function lookupTeam(team) {
    const nick = (team.name || "").toLowerCase();
    const full = (team.displayName || "").toLowerCase();
    return teamIndex.find((t) => t.nick === nick) ||
      teamIndex.find((t) => full === t.nick || full.endsWith(" " + t.nick)) || null;
  }

  // ---------- weeks ----------
  function buildWeeks() {
    const end = parseYMD(C.seasonEnd);
    const merges = C.mergedWeeks || [];
    const weeks = [];
    let cur = parseYMD(C.seasonStart);
    let n = 1;
    while (cur <= end) {
      const s = ymd(cur);
      const m = merges.find((x) => x.start === s);
      let e = m ? parseYMD(m.end) : addDays(cur, (7 - cur.getUTCDay()) % 7);
      if (e > end) e = end;
      weeks.push({ n, start: s, end: ymd(e), note: m ? m.note : "" });
      n++;
      cur = addDays(e, 1);
    }
    return weeks;
  }

  // ---------- data ----------
  function side(c) {
    if (!c) return null;
    const t = c.team || {};
    const match = lookupTeam(t);
    if (match && t.logo) logos[match.label] = t.logo;
    const raw = c.score && typeof c.score === "object" ? c.score.value : c.score;
    return {
      abbr: t.abbreviation || "",
      name: t.shortDisplayName || t.name || t.displayName || "",
      logo: t.logo || "",
      score: raw === undefined || raw === null || raw === "" ? null : Number(raw),
      winner: c.winner === true,
      owner: match ? match.owner : null,
      label: match ? match.label : null
    };
  }

  function normalize(e) {
    const comp = (e.competitions && e.competitions[0]) || {};
    const cs = comp.competitors || [];
    const home = side(cs.find((c) => c.homeAway === "home") || cs[0]);
    const away = side(cs.find((c) => c.homeAway === "away") || cs[1]);
    const st = (e.status && e.status.type) || (comp.status && comp.status.type) || {};
    const completed = !!st.completed;
    if (completed && home && away && !home.winner && !away.winner && home.score != null && away.score != null) {
      if (home.score > away.score) home.winner = true;
      else if (away.score > home.score) away.winner = true;
    }
    return {
      id: String(e.id),
      date: e.date,
      day: etYMD(new Date(e.date)),
      seasonType: e.season ? e.season.type : null,
      state: st.state || "pre",
      completed,
      detail: st.shortDetail || st.detail || "",
      notes: (comp.notes || []).map((n) => n.headline || "").join(" "),
      home,
      away
    };
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function fetchWeekGames(w) {
    const key = `${CACHE}${w.start}_${w.end}`;
    try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) { /* storage unavailable */ }

    let games = null;
    const span = dayList(w.start, w.end);
    try {
      const j = await getJSON(`${API}?dates=${compact(w.start)}-${compact(w.end)}&limit=1000`);
      const g = (j.events || []).map(normalize);
      const days = new Set(g.map((x) => x.day));
      if (g.length && (span.length <= 2 || days.size > 1)) games = g;
    } catch (e) { /* fall back to one request per day */ }

    if (!games) {
      const res = await Promise.allSettled(span.map((d) => getJSON(`${API}?dates=${compact(d)}&limit=100`)));
      if (res.every((r) => r.status === "rejected")) throw new Error("ESPN scores could not be reached");
      games = res.filter((r) => r.status === "fulfilled").flatMap((r) => (r.value.events || []).map(normalize));
    }

    const seen = new Set();
    games = games
      .filter((g) => !seen.has(g.id) && seen.add(g.id))
      .filter((g) => g.day >= w.start && g.day <= w.end)
      .sort((a, b) => a.date.localeCompare(b.date));

    const settled = w.end < today() && games.every((g) => g.completed || g.state === "post");
    if (settled) { try { localStorage.setItem(key, JSON.stringify(games)); } catch (e) { /* ignore */ } }
    return games;
  }

  // ---------- scoring ----------
  const isCupFinal = (g) => /cup/i.test(g.notes) && /(championship|final)/i.test(g.notes) && !/(semi|quarter)/i.test(g.notes);
  const counts = (g) =>
    (g.seasonType == null || g.seasonType === 2) &&
    !(C.excludeCupFinal && isCupFinal(g)) &&
    !(C.excludeGameIds || []).map(String).includes(g.id);
  const decided = (g) => g.completed && g.home && g.away && (g.home.winner || g.away.winner);

  function computeWeek(w, games) {
    const t = today();
    const rec = Object.fromEntries(owners.map((o) => [o.name, { name: o.name, w: 0, l: 0, left: 0 }]));
    const teams = {};
    for (const g of games) {
      if (!counts(g)) continue;
      for (const s of [g.home, g.away]) {
        if (!s || !s.owner) continue;
        const tr = teams[s.label] || (teams[s.label] = { w: 0, l: 0 });
        if (decided(g)) {
          if (s.winner) { rec[s.owner].w++; tr.w++; } else { rec[s.owner].l++; tr.l++; }
        } else if (g.state !== "post") {
          rec[s.owner].left++;
        }
      }
    }
    const rows = Object.values(rec).map((r) => ({ ...r, pct: r.w + r.l ? r.w / (r.w + r.l) : null }));
    const best = Math.max(-1, ...rows.map((r) => (r.pct == null ? -1 : r.pct)));
    const leaders = best < 0 ? [] : rows.filter((r) => r.pct != null && Math.abs(r.pct - best) < 1e-9).map((r) => r.name);
    return { week: w, games, rows, teams, leaders, complete: t > w.end, started: t >= w.start, live: games.some((g) => g.state === "in") };
  }

  function computeSeason(results) {
    const tot = Object.fromEntries(owners.map((o) => [o.name, { name: o.name, w: 0, l: 0, weeksWon: 0, earned: 0 }]));
    const teams = {};
    for (const r of results) {
      r.rows.forEach((x) => { tot[x.name].w += x.w; tot[x.name].l += x.l; });
      Object.entries(r.teams).forEach(([k, v]) => { const tr = teams[k] || (teams[k] = { w: 0, l: 0 }); tr.w += v.w; tr.l += v.l; });
      if (r.complete && r.leaders.length) {
        const share = C.weeklyPot / r.leaders.length;
        r.leaders.forEach((n) => { tot[n].weeksWon++; tot[n].earned += share; });
      }
    }
    const rows = Object.values(tot).map((r) => ({ ...r, pct: r.w + r.l ? r.w / (r.w + r.l) : null }));
    const over = today() > C.seasonEnd;
    const best = Math.max(-1, ...rows.map((r) => (r.pct == null ? -1 : r.pct)));
    const leaders = best < 0 ? [] : rows.filter((r) => r.pct != null && Math.abs(r.pct - best) < 1e-9).map((r) => r.name);
    if (over && leaders.length && C.seasonPrize) leaders.forEach((n) => { tot[n].earned += C.seasonPrize / leaders.length; });
    if (C.cupChampion && C.cupPrize && tot[C.cupChampion]) tot[C.cupChampion].earned += C.cupPrize;
    rows.forEach((r) => { r.earned = tot[r.name].earned; });
    rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.earned - a.earned);
    return { rows, teams, leaders, over };
  }

  // ---------- state ----------
  const weeks = buildWeeks();
  const state = { games: {}, sel: null, tab: "games", error: null, updated: null, loading: false };

  function currentIndex() {
    const t = today();
    if (t < weeks[0].start) return 0;
    const i = weeks.findIndex((w) => t >= w.start && t <= w.end);
    return i < 0 ? weeks.length - 1 : i;
  }

  // ---------- rendering ----------
  const chip = (name) => {
    if (!name) return "";
    const o = ownerByName[name];
    return `<span class="chip" style="--c:${esc(o.color)}">${esc(name)}</span>`;
  };

  function weekStatus(r) {
    const w = r.week;
    const t = today();
    if (t < C.seasonStart) {
      const days = Math.round((parseYMD(C.seasonStart) - parseYMD(t)) / 864e5);
      return `Tips off ${longDay(C.seasonStart)}, ${days} day${days === 1 ? "" : "s"} away`;
    }
    if (!r.started) return `Starts ${longDay(w.start)}`;
    const left = r.games.filter((g) => counts(g) && !g.completed && g.state !== "post").length;
    if (r.complete) return "Final";
    if (r.live) return `Games live now, ${left} left this week`;
    return `${left} game${left === 1 ? "" : "s"} left this week`;
  }

  function renderRace(r) {
    const w = r.week;
    const i = weeks.indexOf(w);
    const maxIdx = Math.max(0, ...Object.keys(state.games).map((n) => weeks.findIndex((x) => x.n === Number(n))));
    const rows = [...r.rows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.w - a.w || a.name.localeCompare(b.name));
    const pot = r.leaders.length ? C.weeklyPot / r.leaders.length : 0;

    const bars = rows.map((x) => {
      const o = ownerByName[x.name];
      const lead = r.leaders.includes(x.name) && x.pct != null;
      const tag = lead ? (r.complete ? `<span class="tag won">Won ${money(pot)}</span>` : `<span class="tag">Leading</span>`) : "";
      const width = x.pct == null ? 0 : Math.max(x.pct * 100, 1.5);
      return `
        <li class="lane${lead ? " lead" : ""}" style="--c:${esc(o.color)}">
          <span class="who">${esc(x.name)}${tag}</span>
          <span class="track"><span class="bar" style="width:${width}%"></span></span>
          <span class="rec">${x.w}-${x.l}</span>
          <span class="pct">${pctStr(x.pct)}</span>
        </li>`;
    }).join("");

    $("#race").innerHTML = `
      <div class="race-head">
        <button class="nav" id="prevWeek" aria-label="Previous week" ${i <= 0 ? "disabled" : ""}>‹</button>
        <div class="race-title">
          <h2>Week ${w.n}</h2>
          <p>${shortDate(w.start)} to ${shortDate(w.end)}${w.note ? `<span class="note">${esc(w.note)}</span>` : ""}</p>
        </div>
        <button class="nav" id="nextWeek" aria-label="Next week" ${i >= maxIdx ? "disabled" : ""}>›</button>
      </div>
      <p class="status${r.live ? " live" : ""}">${esc(weekStatus(r))}</p>
      <ol class="lanes">${bars}</ol>
      <p class="axis"><span>0%</span><span>50%</span><span>100%</span></p>`;

    $("#prevWeek").onclick = () => { state.sel = weeks[i - 1].n; render(); };
    $("#nextWeek").onclick = () => { state.sel = weeks[i + 1].n; render(); };
  }

  function gameTime(g) {
    if (g.state === "pre") {
      const t = new Date(g.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
      return /TBD/i.test(g.detail) ? "TBD" : `${t} ET`;
    }
    return g.detail || (g.completed ? "Final" : "");
  }

  function teamLine(s, g) {
    const won = decided(g) && s.winner;
    return `
      <div class="team${won ? " win" : ""}${decided(g) && !s.winner ? " loss" : ""}">
        ${s.logo ? `<img src="${esc(s.logo)}" alt="" width="28" height="28" loading="lazy">` : `<span class="nologo"></span>`}
        <span class="tname">${esc(s.name)}</span>
        ${chip(s.owner)}
        <span class="score">${g.state === "pre" || s.score == null ? "" : s.score}</span>
      </div>`;
  }

  function renderGames(r) {
    if (!r.games.length) {
      return `<p class="empty">${r.started ? "No games found for this week yet. Try Refresh." : "The schedule for this week shows up once it starts."}</p>`;
    }
    const byDay = {};
    r.games.forEach((g) => (byDay[g.day] = byDay[g.day] || []).push(g));
    return Object.entries(byDay).map(([day, gs]) => `
      <section class="day">
        <h3>${longDay(day)}${day === today() ? " (today)" : ""}</h3>
        <ul class="games">
          ${gs.map((g) => `
            <li class="game ${g.state}${counts(g) ? "" : " skip"}">
              <div class="teams">${teamLine(g.away, g)}${teamLine(g.home, g)}</div>
              <div class="when">${esc(gameTime(g))}${counts(g) ? "" : "<br><small>Not counted</small>"}</div>
            </li>`).join("")}
        </ul>
      </section>`).join("");
  }

  function renderSeason(s) {
    const rows = s.rows.map((x, idx) => `
      <tr style="--c:${esc(ownerByName[x.name].color)}">
        <td class="rank">${idx + 1}</td>
        <td class="name"><span class="dot"></span>${esc(x.name)}</td>
        <td>${x.w}-${x.l}</td>
        <td class="num strong">${pctStr(x.pct)}</td>
        <td class="num">${x.weeksWon}</td>
        <td class="num">${money(x.earned)}</td>
      </tr>`).join("");
    const lead = s.leaders.length ? s.leaders.join(" and ") : "Nobody yet";
    return `
      <div class="scroll"><table class="tbl">
        <thead><tr><th></th><th>Owner</th><th>Record</th><th class="num">Win %</th><th class="num">Weeks won</th><th class="num">Winnings</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="prizes">
        <p><strong>${s.over ? "Season champion" : "Season race"}:</strong> ${esc(lead)}${s.over ? ` takes ${money(C.seasonPrize)}` : `, playing for ${money(C.seasonPrize)}`}.</p>
        <p><strong>Weekly pot:</strong> ${money(C.weeklyPot)} to the best win % each week, split on ties.</p>
        ${C.cupChampion ? `<p><strong>NBA Cup:</strong> ${esc(C.cupChampion)} owns the champion${C.cupPrize ? ` (${money(C.cupPrize)})` : ""}.</p>` : ""}
      </div>`;
  }

  function renderWeeks(results) {
    const head = owners.map((o) => `<th class="num" style="--c:${esc(o.color)}"><span class="dot"></span>${esc(o.name)}</th>`).join("");
    const body = results.filter((r) => r.started).map((r) => {
      const n = r.week.n;
      const cells = owners.map((o) => {
        const x = r.rows.find((y) => y.name === o.name);
        const top = r.leaders.includes(o.name) && x.pct != null;
        return `<td class="num${top ? " top" : ""}" style="--c:${esc(o.color)}">${pctStr(x.pct)}</td>`;
      }).join("");
      const winner = r.complete ? (r.leaders.join(", ") || "None") : "In progress";
      const paid = C.paid && C.paid[n] ? `<span class="paid">Paid</span>` : r.complete && r.leaders.length ? `<span class="owed">Owed</span>` : "";
      return `<tr class="clickable" data-week="${n}"><td class="wk">Week ${n}</td>${cells}<td>${esc(winner)}</td><td class="num">${r.complete && r.leaders.length ? money(C.weeklyPot) : ""}</td><td>${paid}</td></tr>`;
    }).join("");
    return `
      <div class="scroll"><table class="tbl weeks">
        <thead><tr><th>Week</th>${head}<th>Winner</th><th class="num">Pot</th><th>Paid</th></tr></thead>
        <tbody>${body || `<tr><td colspan="${owners.length + 4}" class="empty">Weekly results start after week 1.</td></tr>`}</tbody>
      </table></div>
      <p class="hint">Tap a week to see its games.</p>`;
  }

  function renderTeams(s, r) {
    return `<div class="rosters">${owners.map((o) => {
      const tot = s.rows.find((x) => x.name === o.name);
      return `
        <section class="roster" style="--c:${esc(o.color)}">
          <h3><span class="dot"></span>${esc(o.name)}<span class="rrec">${tot.w}-${tot.l}</span></h3>
          <ul>${o.teams.map((t) => {
            const sr = s.teams[t] || { w: 0, l: 0 };
            const wr = r.teams[t] || { w: 0, l: 0 };
            return `<li>
              ${logos[t] ? `<img src="${esc(logos[t])}" alt="" width="26" height="26" loading="lazy">` : `<span class="nologo"></span>`}
              <span class="tname">${esc(t)}</span>
              <span class="wk" title="Week ${r.week.n}">${wr.w}-${wr.l} wk</span>
              <span class="season">${sr.w}-${sr.l}</span>
            </li>`;
          }).join("")}</ul>
        </section>`;
    }).join("")}</div>
    <p class="hint">Season record on the right, selected week in the middle.</p>`;
  }

  function render() {
    const loaded = weeks.filter((w) => state.games[w.n]);
    const results = loaded.map((w) => computeWeek(w, state.games[w.n]));
    const season = computeSeason(results);

    if (state.sel == null) state.sel = weeks[currentIndex()].n;
    const selWeek = weeks.find((w) => w.n === state.sel) || weeks[0];
    const r = results.find((x) => x.week === selWeek) || computeWeek(selWeek, []);

    renderRace(r);

    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    const panel = $("#panel");
    if (state.error && !loaded.length) {
      panel.innerHTML = `<p class="error">${esc(state.error)}. Check your connection and tap Refresh.</p>`;
    } else if (state.tab === "games") panel.innerHTML = renderGames(r);
    else if (state.tab === "season") panel.innerHTML = renderSeason(season);
    else if (state.tab === "weeks") panel.innerHTML = renderWeeks(results);
    else panel.innerHTML = renderTeams(season, r);

    panel.querySelectorAll("tr[data-week]").forEach((tr) => {
      tr.onclick = () => { state.sel = Number(tr.dataset.week); state.tab = "games"; render(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    });

    $("#updated").textContent = state.updated
      ? state.updated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "never";
    $("#refreshBtn").disabled = state.loading;
    $("#refreshBtn").textContent = state.loading ? "Loading…" : "Refresh";
    if (state.error && loaded.length) $("#banner").textContent = `Some scores didn't load (${state.error}). Showing what's available.`;
    else $("#banner").textContent = "";
  }

  // ---------- loading ----------
  let timer = null;
  async function load() {
    state.loading = true;
    render();
    const t = today();
    let list = weeks.filter((w) => w.start <= t);
    if (!list.length) list = [weeks[0]];
    const res = await Promise.allSettled(list.map((w) => fetchWeekGames(w).then((g) => [w.n, g])));
    const ok = res.filter((x) => x.status === "fulfilled");
    ok.forEach((x) => { state.games[x.value[0]] = x.value[1]; });
    const bad = res.find((x) => x.status === "rejected");
    state.error = bad ? bad.reason.message : null;
    state.updated = new Date();
    state.loading = false;
    render();

    clearTimeout(timer);
    const cur = weeks[currentIndex()];
    const live = (state.games[cur.n] || []).some((g) => g.state === "in");
    timer = setTimeout(() => { if (!document.hidden) load(); }, live ? 60e3 : 10 * 60e3);
  }

  // ---------- init ----------
  document.title = C.name;
  $("#leagueName").textContent = C.name;
  $("#seasonLine").textContent = `${C.season} season, ${owners.length} owners, ${teamIndex.length} teams`;
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); };
  });
  $("#refreshBtn").onclick = load;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.updated && Date.now() - state.updated > 60e3) load();
  });

  // expose for testing
  window.__lpg = { buildWeeks, computeWeek, computeSeason, normalize, state };
  load();
})();
