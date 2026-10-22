/*
  Bets tab: friends post bets, everyone sees them, and each one is checked against live results.

  Honor system: no logins. Bets are saved in the same Firebase project as chat (Firestore,
  rooms/<room>/bets). Settings come from `chat.firebase` in config.js.

  Automatic tracking: team win totals, single games (win / spread / total), and futures
  (make the playoffs, division, NBA title, NBA Cup). "Something else" bets are set by hand.
*/
(() => {
  "use strict";
  const L = window.__lpg;
  const C = window.LEAGUE;
  if (!L || !C) return;

  const cfg = C.chat || {};
  const room = cfg.room || C.season;
  const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
  const TZ = "America/New_York";
  const WHO_KEY = "lpg:bets:who";
  const GAMES = 82;
  const MAX_LEGS = 10;
  const { esc, chip, owners } = L;
  const ownerByName = Object.fromEntries(owners.map((o) => [o.name, o]));
  const teams = [...L.teamIndex].sort((a, b) => a.label.localeCompare(b.label));
  const ownerOfTeam = (t) => (L.teamIndex.find((x) => x.label === t) || {}).owner || null;

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  };

  // ---------- small helpers ----------
  const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const fmtLine = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
  const money = (n) => (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2).replace(/\.00$/, "");
  const sgnMoney = (n) => (n > 0 ? "+" : "") + money(n);
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
  const dayRange = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const fetchJSON = async (u) => { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
  const allGames = () => Object.values(L.state.games).flat();
  const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });

  // American odds -> profit per $1 staked. Blank odds mean -110.
  function oddsMult(o) {
    const t = String(o == null ? "" : o).trim().toLowerCase().replace("−", "-");
    if (!t) return 100 / 110;
    if (t === "even" || t === "ev") return 1;
    const n = parseFloat(t);
    if (!isFinite(n) || n === 0) return null;
    return n < 0 ? 100 / -n : n / 100;
  }
  const toWin = (b) => (isNum(b.stake) && b.stake > 0 && oddsMult(b.odds) != null ? b.stake * oddsMult(b.odds) : null);

  // ---------- storage (Firebase) ----------
  let backend = null;
  let bets = [];
  let loaded = false;
  let storeError = "";
  let unsub = null;

  async function firebaseBackend() {
    const [app, fs] = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-firestore.js")]);
    const a = app.getApps().find((x) => x.name === "bets") || app.initializeApp(cfg.firebase, "bets");
    const col = fs.collection(fs.getFirestore(a), "rooms", room, "bets");
    return {
      listen(onChange, onError) {
        const q = fs.query(col, fs.orderBy("createdAt", "desc"), fs.limit(300));
        return fs.onSnapshot(q, (snap) => {
          onChange(snap.docs.map((d) => {
            const x = d.data({ serverTimestamps: "estimate" });
            return { ...x, id: d.id, createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : new Date() };
          }));
        }, onError);
      },
      add: (bet) => fs.addDoc(col, { ...bet, createdAt: fs.serverTimestamp() }),
      remove: (id) => fs.deleteDoc(fs.doc(col, id)),
      setStatus: (id, status) => fs.updateDoc(fs.doc(col, id), { status }),
      // Parlay legs are never edited; each "something else" leg's result is kept in legStatus.
      setLegStatus: (id, leg, status) => fs.updateDoc(fs.doc(col, id), { [`legStatus.${leg}`]: status })
    };
  }

  let starting = false;
  async function start() {
    if (backend || starting) return;
    starting = true;
    if (!window.__lpgBetsBackend && !(cfg.firebase && cfg.firebase.apiKey)) {
      storeError = "Bets aren't connected yet. Add the Firebase settings to chat.firebase in config.js.";
      loaded = true; starting = false; refresh();
      return;
    }
    try {
      backend = window.__lpgBetsBackend || await firebaseBackend();
      unsub = backend.listen((list) => { bets = list; loaded = true; storeError = ""; refresh(); }, (err) => {
        storeError = err && err.code === "permission-denied"
          ? "The bets database isn't open yet. Ask Cole to publish the new Firebase rules."
          : "Bets couldn't load. Check your connection and reopen the tab.";
        loaded = true; refresh();
      });
    } catch (e) {
      storeError = "Bets couldn't load. Check your connection and reopen the tab.";
      loaded = true;
    }
    starting = false;
    refresh();
  }

  // ---------- postseason data (standings + playoff games), loaded only when a futures bet exists ----------
  const POST = { std: null, games: [], loadedAt: 0, loading: false, error: "" };
  // Futures can sit inside a parlay too, so look at every leg.
  const allPicks = () => bets.flatMap((b) => (b.type === "parlay" ? b.legs || [] : [b]));
  const needsPost = () => L.today() >= C.seasonStart && allPicks().some((b) => b.type === "future" && b.kind !== "cup");

  function parseStandings(j) {
    const by = {};
    (j.children || []).forEach((conf) => (conf.children || []).forEach((div) => {
      const rows = (div.standings && div.standings.entries) || [];
      const list = rows.map((e) => {
        const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s.displayValue != null ? s.displayValue : s.value]));
        return { name: e.team.name, conf: (conf.name || "").replace(/ Conference/i, ""), div: div.name, seed: Number(st.playoffSeed) || null,
          clincher: st.clincher || "", w: Number(st.wins) || 0, l: Number(st.losses) || 0, gb: st.gamesBehind || "-" };
      }).sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
      list.forEach((r, i) => { by[r.name] = { ...r, divRank: i + 1, divTeams: list.map((x) => x.name) }; });
    }));
    return by;
  }

  const compactEvent = (e) => {
    const c = (e.competitions && e.competitions[0]) || {};
    return {
      t: e.season ? e.season.type : null, d: e.date, st: (e.status && e.status.type && e.status.type.state) || "pre",
      n: (c.notes || []).map((x) => x.headline || "").join(" "), sc: !!(c.series && c.series.completed),
      teams: (c.competitors || []).map((t) => ({ name: t.team.name || t.team.shortDisplayName, w: t.winner === true }))
    };
  };

  async function loadPost(force) {
    if (POST.loading || !needsPost()) return;
    if (!force && Date.now() - POST.loadedAt < 120e3) return;
    POST.loading = true;
    try {
      const year = Number(String(C.season).slice(0, 4)) + 1;
      POST.std = parseStandings(await fetchJSON(`https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=${year}&level=3`));
      const t = L.today();
      if (t > C.seasonEnd) {
        const days = dayRange(addDays(C.seasonEnd, 1), t < addDays(C.seasonEnd, 75) ? t : addDays(C.seasonEnd, 75));
        const out = await Promise.all(days.map(async (day) => {
          const key = `lpg:${C.season}:post:${day}`;
          try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) { /* ignore */ }
          try {
            const evs = ((await fetchJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replace(/-/g, "")}`)).events || []).map(compactEvent);
            if (day < t && evs.every((x) => x.st === "post")) { try { localStorage.setItem(key, JSON.stringify(evs)); } catch (e) { /* ignore */ } }
            return evs;
          } catch (e) { return []; }
        }));
        POST.games = out.flat().sort((a, b) => a.d.localeCompare(b.d));
      }
      POST.error = "";
    } catch (e) {
      POST.error = e.message;
    }
    POST.loadedAt = Date.now();
    POST.loading = false;
    refresh();
  }

  function postInfo() {
    const po = POST.games.filter((e) => e.t === 3);
    const playoffTeams = new Set(po.flatMap((e) => e.teams.map((t) => t.name)));
    const round = (n) => n.replace(/\s*-\s*Game\s*\d+.*$/i, "").trim();
    const out = new Map(), last = new Map();
    po.forEach((e) => {
      e.teams.forEach((t) => last.set(t.name, round(e.n)));
      if (e.sc && e.st === "post") { const lo = e.teams.find((t) => !t.w); if (lo) out.set(lo.name, round(e.n)); }
    });
    const fin = po.find((e) => /NBA Finals/i.test(e.n) && e.sc && e.st === "post");
    const champion = fin ? (fin.teams.find((t) => t.w) || {}).name || null : null;
    return { started: po.length > 0, playoffTeams, known: playoffTeams.size >= 16, out, last, champion };
  }

  // ---------- evaluating a bet ----------
  const R = (state, label, detail, lean, bar, live) => ({ state, label, detail: detail || "", lean: lean || "neutral", bar: bar || null, live: !!live });

  function evalWinTotal(b, ctx) {
    const rec = ctx.records[b.team] || { w: 0, l: 0 };
    const gp = rec.w + rec.l, rest = GAMES - gp, maxW = GAMES - rec.l, line = b.line, over = b.side === "over";
    let state = "open";
    if (over) {
      if (rec.w > line) state = "won"; else if (maxW < line) state = "lost"; else if (rest === 0) state = rec.w === line ? "push" : "lost";
    } else {
      if (rec.w > line) state = "lost"; else if (maxW < line) state = "won"; else if (rest === 0) state = rec.w === line ? "push" : "won";
    }
    const needMin = Math.floor(line) + 1, allowMax = Math.ceil(line) - 1;
    const proj = (ctx.proj.find((t) => t.label === b.team) || {}).proj;
    const bar = over
      ? { value: rec.w, max: needMin, label: `${rec.w} of ${needMin} wins needed` }
      : { value: rec.w, max: allowMax + 1, label: `${rec.w} wins · can allow ${allowMax}`, invert: true };
    const rec$ = `${rec.w}-${rec.l}`;
    if (state === "won") return R("won", "Won", `${rec$} · ${rest ? `clinched with ${rest} games left` : "final"}`, "good", bar);
    if (state === "lost") return R("lost", "Lost", `${rec$} · ${rest ? `out of reach with ${rest} games left` : "final"}`, "bad", bar);
    if (state === "push") return R("push", "Push", `${rec$} · final`, "neutral", bar);
    if (!gp) return R("open", "Not started", `Line ${line} wins · season hasn't begun`, "neutral", bar);
    const lean = isNum(proj) ? ((over ? proj > line : proj < line) ? "good" : "bad") : "neutral";
    const need = over ? Math.max(0, needMin - rec.w) : null;
    const detail = `${rec$} · proj ${isNum(proj) ? proj.toFixed(1) : "–"} vs ${line} · ${rest} left` +
      (over ? ` · needs ${need} more win${need === 1 ? "" : "s"}` : ` · can afford ${Math.max(0, allowMax - rec.w)} more win${allowMax - rec.w === 1 ? "" : "s"}`);
    return R("open", lean === "good" ? "On track" : lean === "bad" ? "Behind" : "Pending", detail, lean, bar);
  }

  function evalGame(b) {
    const g = allGames().find((x) => x.id === b.gameId);
    const title = b.gameLabel || "";
    if (!g) return R("open", "Pending", `Waiting for ${title || "the game"} to show up in the schedule`, "neutral");
    const mine = (s) => s && (s.label === b.team || s.name === b.team);
    const my = b.kind === "total" ? g.home : (mine(g.home) ? g.home : g.away);
    const opp = my === g.home ? g.away : g.home;
    const hs = isNum(g.home.score) ? g.home.score : 0, as = isNum(g.away.score) ? g.away.score : 0;
    const score = `${g.away.abbr} ${as} – ${g.home.abbr} ${hs}`;
    const when = `${shortDay(g.day)} · ${L.gameTime(g)}`;
    if (g.state === "pre") return R("open", "Pending", `${g.away.abbr} @ ${g.home.abbr} · ${when}`, "neutral");
    const live = g.state === "in";
    const final = decided(g);
    const sum = hs + as, ms = my && isNum(my.score) ? my.score : 0, os = opp && isNum(opp.score) ? opp.score : 0, diff = ms - os;
    const where = live ? `${score} · ${g.detail}` : `${score} · final`;
    const finish = (val) => (val > 0 ? R("won", "Won", where, "good") : val < 0 ? R("lost", "Lost", where, "bad") : R("push", "Push", where, "neutral"));
    if (b.kind === "ml") {
      if (final) return finish(my.winner ? 1 : -1);
      if (live) return R("open", diff > 0 ? "Winning" : diff < 0 ? "Trailing" : "Tied", where, diff > 0 ? "good" : diff < 0 ? "bad" : "neutral", null, true);
    } else if (b.kind === "spread") {
      const adj = diff + b.line;
      if (final) return finish(adj);
      if (live) return R("open", adj > 0 ? "Covering" : adj < 0 ? "Not covering" : "On the number", `${where} · ${adj > 0 ? "up" : "down"} ${Math.abs(adj)} vs the spread`, adj > 0 ? "good" : adj < 0 ? "bad" : "neutral", null, true);
    } else if (b.kind === "total") {
      const over = b.side === "over", bar = { value: sum, max: b.line, label: `${sum} points · line ${b.line}` };
      if (over && sum > b.line) return R("won", "Won", `${where} · total passed ${b.line}`, "good", bar);
      if (!over && sum > b.line) return R("lost", "Lost", `${where} · total passed ${b.line}`, "bad", bar);
      if (final) return finish(over ? sum - b.line : b.line - sum);
      if (live) return R("open", "Live", where, "neutral", bar, true);
    }
    return R("open", "Pending", where, "neutral");
  }
  const decided = (g) => L.decided(g);

  function evalFuture(b, ctx) {
    const team = b.team, kind = b.kind;
    if (kind === "cup") {
      const games = L.cupGames();
      const final = games.find((g) => L.cupRound(g) === "final");
      const fw = final && L.winnerOf(final);
      if (fw && fw.name === team) return R("won", "Won", "Won the NBA Cup", "good");
      const lostGame = games.find((g) => ["qf", "sf", "final"].includes(L.cupRound(g)) && L.winnerOf(g) && [g.home, g.away].some((s) => s.name === team) && L.winnerOf(g).name !== team);
      if (lostGame) return R("lost", "Lost", `Out in the ${({ qf: "quarterfinals", sf: "semifinals", final: "final" })[L.cupRound(lostGame)]}`, "bad");
      const qf = games.filter((g) => L.cupRound(g) === "qf");
      if (qf.length && !qf.some((g) => [g.home, g.away].some((s) => s.name === team))) return R("lost", "Lost", "Didn't advance from group play", "bad");
      if (fw) return R("lost", "Lost", `${fw.name} won the NBA Cup`, "bad");
      if (!games.length) return R("open", "Pending", "Group play starts in November", "neutral");
      const latest = [...games].reverse().find((g) => [g.home, g.away].some((s) => s.name === team) && L.cupRound(g) !== "group");
      return R("open", latest ? "Alive" : "Pending", latest ? "Still alive in the knockout rounds" : "In group play", latest ? "good" : "neutral");
    }
    // ESPN's standings show preseason records until opening night, so wait for the real season.
    if (L.today() < C.seasonStart) return R("open", "Pending", `Season starts ${new Date(`${C.seasonStart}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`, "neutral");
    if (!POST.std) return R("open", "Pending", POST.error ? "Couldn't load standings right now" : "Checking standings…", "neutral");
    const st = POST.std[team];
    if (!st) return R("open", "Pending", "Team not found in standings", "neutral");
    const info = ctx.post;
    const seedTxt = st.seed ? `No. ${st.seed} seed in the ${st.conf}` : st.conf;

    if (kind === "playoffs") {
      const yes = b.side !== "no";
      let inn = null, why = "";
      if (info.playoffTeams.has(team)) { inn = true; why = "In the playoffs"; }
      else if (info.known) { inn = false; why = "Missed the playoffs"; }
      else if (["x", "y", "z", "*"].includes(st.clincher)) { inn = true; why = "Clinched a playoff spot"; }
      else if (st.clincher === "e") { inn = false; why = "Eliminated from the playoffs"; }
      if (inn == null) {
        const pi = ["xp", "pb"].includes(st.clincher) || (st.seed >= 7 && st.seed <= 10);
        return R("open", "Pending", `${seedTxt}${pi ? " · in the play-in picture" : ""} · ${st.w}-${st.l}`, "neutral");
      }
      return (inn === yes) ? R("won", "Won", why, "good") : R("lost", "Lost", why, "bad");
    }

    if (kind === "division") {
      const win = ["y", "z", "*"].includes(st.clincher);
      const rival = st.divTeams.map((n) => POST.std[n]).find((o) => o && o.name !== team && ["y", "z", "*"].includes(o.clincher));
      if (win) return R("won", "Won", `Clinched the ${st.div}`, "good");
      if (rival) return R("lost", "Lost", `${rival.name} clinched the ${st.div}`, "bad");
      if (L.today() > C.seasonEnd) return st.divRank === 1 ? R("won", "Won", `Won the ${st.div}`, "good") : R("lost", "Lost", `Finished ${ordinal(st.divRank)} in the ${st.div}`, "bad");
      return R("open", st.divRank === 1 ? "Leading" : "Chasing", `${ordinal(st.divRank)} in the ${st.div}${st.gb && st.gb !== "-" ? ` · ${st.gb} GB` : ""}`, st.divRank === 1 ? "good" : "bad");
    }

    if (kind === "title") {
      if (info.champion === team) return R("won", "Won", "NBA champions", "good");
      if (info.out.has(team)) return R("lost", "Lost", `Eliminated in the ${info.out.get(team)}`, "bad");
      if (info.known && !info.playoffTeams.has(team)) return R("lost", "Lost", "Missed the playoffs", "bad");
      if (st.clincher === "e") return R("lost", "Lost", "Eliminated from the playoffs", "bad");
      if (info.champion) return R("lost", "Lost", `${info.champion} won the title`, "bad");
      if (info.started) return R("open", "Alive", `Still alive · ${info.last.get(team) || "in the playoffs"}`, "good");
      return R("open", "Pending", `Regular season · ${seedTxt}`, "neutral");
    }
    return R("open", "Pending", "", "neutral");
  }

  // A parlay wins only if every leg wins. One lost leg loses it right away, a pushed leg drops out,
  // and "something else" legs take their result from the buttons on the card (legStatus).
  function evalParlay(b, ctx) {
    const legs = (b.legs || []).map((leg, i) => {
      const lb = { ...leg, owner: b.owner, status: (b.legStatus || {})[i] };
      return { b: lb, ev: evaluate(lb, ctx), i };
    });
    const n = legs.length;
    const lost = legs.filter((l) => l.ev.state === "lost");
    const won = legs.filter((l) => l.ev.state === "won");
    const push = legs.filter((l) => l.ev.state === "push");
    const open = legs.filter((l) => l.ev.state === "open");
    const base = { legs };
    if (lost.length) return { ...R("lost", "Lost", `Leg ${lost[0].i + 1} lost · ${describe(lost[0].b).title}`, "bad"), ...base };
    if (!open.length) {
      if (!won.length) return { ...R("push", "Push", "Every leg pushed", "neutral"), ...base };
      const note = push.length ? `${push.length} leg${push.length === 1 ? "" : "s"} pushed, so your sportsbook may pay less than the original odds` : "";
      const text = push.length ? (won.length === 1 ? "The other leg won" : `All ${won.length} remaining legs won`) : `All ${won.length} legs won`;
      return { ...R("won", "Won", text, "good"), ...base, note };
    }
    const risk = open.filter((l) => l.ev.lean === "bad").length;
    const live = open.some((l) => l.ev.live);
    const lean = risk ? "bad" : open.every((l) => l.ev.lean === "good") ? "good" : "neutral";
    const label = risk ? "At risk" : lean === "good" ? "On track" : "Pending";
    const detail = `${won.length} of ${n} legs won${push.length ? ` · ${push.length} pushed` : ""} · ${open.length} to go${risk ? ` · ${risk} behind` : ""}`;
    return { ...R("open", label, detail, lean, null, live), ...base };
  }

  function evaluate(b, ctx) {
    try {
      if (b.type === "parlay") return evalParlay(b, ctx);
      if (b.type === "wintotal") return evalWinTotal(b, ctx);
      if (b.type === "game") return evalGame(b);
      if (b.type === "future") return evalFuture(b, ctx);
    } catch (e) { return R("open", "Pending", "Couldn't check this one yet", "neutral"); }
    const s = b.status;
    if (s === "won") return R("won", "Won", "", "good");
    if (s === "lost") return R("lost", "Lost", "", "bad");
    if (s === "push") return R("push", "Push", "", "neutral");
    return R("open", "Pending", "Set the result once it's settled", "neutral");
  }

  // ---------- describing a bet ----------
  const FUTURES = {
    playoffs: "to make the playoffs", division: "to win their division", title: "to win the NBA title", cup: "to win the NBA Cup"
  };
  function describe(b) {
    if (b.type === "parlay") { const n = (b.legs || []).length; return { title: `${n}-leg parlay`, sub: "Every leg has to win" }; }
    if (b.type === "wintotal") return { title: `${b.team} ${b.side} ${b.line} wins`, sub: "Regular-season win total" };
    if (b.type === "game") {
      const game = b.gameLabel || "Game";
      if (b.kind === "ml") return { title: `${b.team} to win`, sub: game };
      if (b.kind === "spread") return { title: `${b.team} ${fmtLine(b.line)}`, sub: `Spread · ${game}` };
      return { title: `${b.side === "under" ? "Under" : "Over"} ${b.line} points`, sub: `Game total · ${game}` };
    }
    if (b.type === "future") {
      if (b.kind === "playoffs" && b.side === "no") return { title: `${b.team} to miss the playoffs`, sub: "Future" };
      return { title: `${b.team} ${FUTURES[b.kind] || ""}`.trim(), sub: "Future" };
    }
    return { title: b.text || "Custom bet", sub: "Custom bet" };
  }

  // ---------- rendering ----------
  let panelEl = null;
  let filter = "all";
  let formOpen = false;
  const root = () => (panelEl ? panelEl.querySelector(".bets") : null);

  const RESULT_LABEL = { pending: "Pending", won: "Won", lost: "Lost", push: "Push" };
  const resultRow = (status, attrs) => `
      <div class="bet-result"><span class="muted">Result: <b class="rs ${status}">${RESULT_LABEL[status] || "Pending"}</b></span><button type="button" class="setres" ${attrs}>Set result</button></div>`;

  // ---------- confirm screen (used for removing a bet and for setting a result) ----------
  let dlg = null, dlgState = null;
  function ensureDlg() {
    if (dlg) return;
    dlg = document.createElement("div");
    dlg.className = "dlg";
    dlg.hidden = true;
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.innerHTML = `
      <div class="dlg-back"></div>
      <div class="dlg-panel">
        <h3 class="dlg-title" id="dlgTitle"></h3>
        <p class="dlg-sub" id="dlgSub"></p>
        <div class="dlg-opts" id="dlgOpts" role="radiogroup" hidden></div>
        <p class="dlg-note" id="dlgNote"></p>
        <p class="dlg-err" id="dlgErr" role="status"></p>
        <div class="dlg-actions"><button type="button" class="dlg-cancel" id="dlgCancel">Cancel</button><button type="button" class="dlg-ok" id="dlgOk">Confirm</button></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".dlg-back").onclick = closeDlg;
    dlg.querySelector("#dlgCancel").onclick = closeDlg;
    dlg.querySelector("#dlgOpts").addEventListener("click", (e) => {
      const o = e.target.closest("[data-v]");
      if (!o || !dlgState) return;
      dlgState.value = o.dataset.v;
      paintDlg();
    });
    dlg.querySelector("#dlgOk").onclick = async () => {
      if (!dlgState) return;
      const st = dlgState, ok = dlg.querySelector("#dlgOk");
      ok.disabled = true; dlg.querySelector("#dlgErr").textContent = "";
      try { await st.onConfirm(st.value); closeDlg(); }
      catch (ex) { dlg.querySelector("#dlgErr").textContent = "That didn't go through. Check your connection and try again."; ok.disabled = false; }
    };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg && !dlg.hidden) closeDlg(); });
  }
  function paintDlg() {
    const s = dlgState, ok = dlg.querySelector("#dlgOk");
    dlg.querySelectorAll("[data-v]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === s.value)));
    ok.textContent = s.okText;
    ok.classList.toggle("danger", !!s.danger);
    ok.disabled = !!s.options && s.value === s.current; // a result has to actually change before it can be confirmed
  }
  function openDlg(cfg) {
    ensureDlg();
    dlgState = { ...cfg, value: cfg.current, opener: document.activeElement };
    dlg.querySelector("#dlgTitle").textContent = cfg.title;
    dlg.querySelector("#dlgSub").textContent = cfg.sub || "";
    dlg.querySelector("#dlgNote").textContent = cfg.note || "";
    dlg.querySelector("#dlgErr").textContent = "";
    const opts = dlg.querySelector("#dlgOpts");
    opts.hidden = !cfg.options;
    opts.innerHTML = cfg.options ? cfg.options.map((o) => `<button type="button" role="radio" class="dlg-opt ${o.v}" data-v="${o.v}" aria-checked="false">${esc(o.t)}</button>`).join("") : "";
    dlg.hidden = false;
    document.body.classList.add("bx-open");
    paintDlg();
    dlg.querySelector("#dlgCancel").focus({ preventScroll: true }); // the safe choice is focused first
  }
  function closeDlg() {
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
    document.body.classList.remove("bx-open");
    const o = dlgState && dlgState.opener;
    dlgState = null;
    if (o && document.contains(o) && o.focus) o.focus({ preventScroll: true });
  }

  function askRemove(id) {
    const b = bets.find((x) => x.id === id);
    if (!b || !backend) return;
    openDlg({
      title: "Remove this bet?", sub: `${describe(b).title} · ${b.owner}`,
      note: "This takes it off the board for everyone, and it can't be undone.",
      okText: "Remove bet", danger: true, onConfirm: () => backend.remove(id)
    });
  }
  function askResult(id, leg) {
    const b = bets.find((x) => x.id === id);
    if (!b || !backend) return;
    const isLeg = leg != null;
    const target = isLeg ? (b.legs || [])[leg] : b;
    if (!target) return;
    const current = (isLeg ? (b.legStatus || {})[leg] : b.status) || "pending";
    openDlg({
      title: "Set the result", sub: `${isLeg ? `Leg ${leg + 1}: ` : ""}${describe(target).title} · ${b.owner}`,
      note: "Everyone on the site will see this. Pick the result, then confirm.",
      options: [{ v: "pending", t: "Pending" }, { v: "won", t: "Won" }, { v: "lost", t: "Lost" }, { v: "push", t: "Push" }],
      current, okText: "Confirm result",
      onConfirm: (v) => (isLeg ? backend.setLegStatus(id, leg, v) : backend.setStatus(id, v))
    });
  }

  function cardHTML(b, ev) {
    const d = describe(b), o = ownerByName[b.owner];
    const win = toWin(b);
    let money$ = "";
    if (isNum(b.stake) && b.stake > 0) {
      const base = `${money(b.stake)} stake${win != null ? ` · to win ${money(win)}` : ""}`;
      money$ = ev.state === "won" && win != null ? `${base} · <b class="pos">${sgnMoney(win)}</b>`
        : ev.state === "lost" ? `${base} · <b class="neg">${sgnMoney(-b.stake)}</b>`
        : ev.state === "push" ? `${base} · <b>$0</b>` : base;
    }
    const bar = ev.bar && ev.bar.max > 0
      ? `<div class="bet-bar${ev.bar.invert ? " inv" : ""}" role="img" aria-label="${esc(ev.bar.label)}"><span style="width:${Math.max(2, Math.min(100, (ev.bar.value / ev.bar.max) * 100))}%"></span></div><p class="bet-barlabel">${esc(ev.bar.label)}</p>` : "";
    const when = b.createdAt instanceof Date ? b.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }) : "";
    // Results on "something else" bets are set on a separate confirm screen, so scrolling can't change them by accident.
    const manual = b.type === "custom" ? resultRow(b.status || "pending", `data-setres="bet" data-id="${esc(b.id)}"`) : "";
    const teamOwner = b.team ? ownerOfTeam(b.team) : null;
    const legs = ev.legs ? `
        <ol class="legs">${ev.legs.map(({ b: lb, ev: le, i }) => {
          const ld = describe(lb);
          const pillCls = le.state === "open" ? le.lean : le.state;
          const setBtns = lb.type === "custom" ? resultRow(lb.status || "pending", `data-setres="leg" data-leg="${i}" data-id="${esc(b.id)}"`) : "";
          return `<li class="leg ${le.state}">
            <div class="leg-main">
              <span class="leg-n">${i + 1}</span>
              <div class="leg-text"><p class="leg-title">${esc(ld.title)}</p><p class="leg-detail">${esc(le.detail || ld.sub)}</p></div>
              <span class="pill sm ${pillCls}">${le.live ? `<i class="live-dot"></i>` : ""}${esc(le.label)}</span>
            </div>
            ${le.bar && le.bar.max > 0 ? `<div class="bet-bar${le.bar.invert ? " inv" : ""}"><span style="width:${Math.max(2, Math.min(100, (le.bar.value / le.bar.max) * 100))}%"></span></div>` : ""}
            ${setBtns}
          </li>`;
        }).join("")}</ol>` : "";
    return `
      <article class="bet ${ev.state}${ev.legs ? " parlay" : ""}" style="--c:${esc(o ? o.color : "#92A5C3")}">
        <div class="bet-top">
          <span class="bet-who">${chip(b.owner)}${teamOwner && teamOwner !== b.owner ? `<small>${esc(teamOwner)}'s team</small>` : ""}</span>
          <span class="pill ${ev.state === "open" ? ev.lean : ev.state}">${ev.live ? `<i class="live-dot"></i>` : ""}${esc(ev.label)}</span>
        </div>
        <h3 class="bet-title">${esc(d.title)}</h3>
        <p class="bet-sub">${esc(d.sub)}${b.type === "parlay" && b.odds ? ` · ${esc(b.odds)}` : ""}</p>
        ${bar}
        ${ev.detail ? `<p class="bet-detail">${esc(ev.detail)}</p>` : ""}
        ${legs}
        ${ev.note ? `<p class="bet-note">${esc(ev.note)}</p>` : ""}
        ${b.note ? `<p class="bet-note">“${esc(b.note)}”</p>` : ""}
        ${manual}
        <div class="bet-foot"><span>${money$ || `<span class="muted">No stake</span>`}</span><span class="muted">${esc(when)}${when ? " · " : ""}<button type="button" class="linkish" data-del="${esc(b.id)}">Remove</button></span></div>
      </article>`;
  }

  function update() {
    const el = root();
    if (!el) return;
    const board = el.querySelector("#betsBoard"), chips = el.querySelector("#betsFilter"), list = el.querySelector("#betsList");

    if (storeError) { board.innerHTML = ""; chips.innerHTML = ""; list.innerHTML = `<p class="error">${esc(storeError)}</p>`; return; }
    if (!loaded) { list.innerHTML = `<p class="empty">Loading bets…</p>`; return; }
    if (needsPost()) loadPost();

    const ctx = { records: L.teamRecords(), proj: L.projections().teams, post: postInfo() };
    const rows = bets.map((b) => ({ b, ev: evaluate(b, ctx) }));

    // scoreboard
    const by = Object.fromEntries(owners.map((o) => [o.name, { name: o.name, w: 0, l: 0, p: 0, open: 0, net: 0, staked: false }]));
    rows.forEach(({ b, ev }) => {
      const r = by[b.owner]; if (!r) return;
      const win = toWin(b), has = isNum(b.stake) && b.stake > 0;
      if (has) r.staked = true;
      if (ev.state === "won") { r.w++; if (has && win != null) r.net += win; }
      else if (ev.state === "lost") { r.l++; if (has) r.net -= b.stake; }
      else if (ev.state === "push") r.p++;
      else r.open++;
    });
    const anyMoney = Object.values(by).some((r) => r.staked);
    const table = Object.values(by).filter((r) => r.w + r.l + r.p + r.open > 0)
      .sort((a, b) => b.net - a.net || b.w - a.w || a.name.localeCompare(b.name));
    board.innerHTML = table.length ? `
      <div class="scroll"><table class="tbl bets-board">
        <thead><tr><th>Owner</th><th class="num">W-L-P</th>${anyMoney ? `<th class="num">Net</th>` : ""}<th class="num">Open</th></tr></thead>
        <tbody>${table.map((r) => `
          <tr style="--c:${esc(ownerByName[r.name].color)}">
            <td class="name"><span class="dot"></span>${esc(r.name)}</td>
            <td class="num">${r.w}-${r.l}-${r.p}</td>
            ${anyMoney ? `<td class="num strong ${r.net > 0 ? "pos" : r.net < 0 ? "neg" : ""}">${r.staked ? sgnMoney(Math.round(r.net * 100) / 100) : "–"}</td>` : ""}
            <td class="num">${r.open}</td>
          </tr>`).join("")}</tbody>
      </table></div>` : "";

    // filter chips
    const chipDefs = [{ k: "all", t: "Everyone" }, ...owners.map((o) => ({ k: o.name, t: o.name, c: o.color }))];
    chips.innerHTML = bets.length ? chipDefs.map((c) => `<button type="button" class="fchip" data-f="${esc(c.k)}" aria-pressed="${filter === c.k}"${c.c ? ` style="--c:${esc(c.c)}"` : ""}>${esc(c.t)}</button>`).join("") : "";

    // cards
    const shown = rows.filter(({ b }) => filter === "all" || b.owner === filter);
    const active = shown.filter(({ ev }) => ev.state === "open"), done = shown.filter(({ ev }) => ev.state !== "open");
    if (!bets.length) list.innerHTML = `<p class="empty">No bets yet. Tap Add a bet to put the first one on the board.</p>`;
    else if (!shown.length) list.innerHTML = `<p class="empty">No bets for ${esc(filter)} yet.</p>`;
    else list.innerHTML =
      (active.length ? `<h3 class="bets-h">Active · ${active.length}</h3>${active.map(({ b, ev }) => cardHTML(b, ev)).join("")}` : "") +
      (done.length ? `<h3 class="bets-h">Settled · ${done.length}</h3>${done.map(({ b, ev }) => cardHTML(b, ev)).join("")}` : "");
  }

  // ---------- the Add a bet form ----------
  function teamOptions(sel) {
    return `<option value="" disabled${sel ? "" : " selected"}>Pick a team</option>` +
      teams.map((t) => `<option value="${esc(t.label)}"${t.label === sel ? " selected" : ""}>${esc(t.label)} (${esc(t.owner)})</option>`).join("");
  }
  function gameOptions() {
    const g = allGames().filter((x) => x.state === "pre" && x.home && x.away).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 80);
    if (!g.length) return `<option value="" disabled selected>No upcoming games loaded</option>`;
    return `<option value="" disabled selected>Pick a game</option>` +
      g.map((x) => `<option value="${esc(x.id)}">${esc(shortDay(x.day))} · ${esc(x.away.abbr)} @ ${esc(x.home.abbr)} · ${esc(L.gameTime(x))}</option>`).join("");
  }

  function shell() {
    const who = store.get(WHO_KEY);
    return `
      <div class="bets">
        <div class="bets-head">
          <button type="button" class="primary" id="betAdd" aria-expanded="${formOpen}">${formOpen ? "Close" : "+ Add a bet"}</button>
          <span class="muted">Honor system. Everyone sees every bet.</span>
        </div>
        <form class="bet-form" id="betForm" autocomplete="off" ${formOpen ? "" : "hidden"} novalidate>
          <div class="bf-row">
            <label>Who<select id="bfWho"><option value="" disabled${who && ownerByName[who] ? "" : " selected"}>Pick your name</option>${owners.map((o) => `<option${o.name === who ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
            <label>Type<select id="bfType">
              <option value="wintotal">Team win total</option>
              <option value="game">Single game</option>
              <option value="future">Playoffs and futures</option>
              <option value="custom">Something else</option>
              <option value="parlay">Parlay (2 to ${MAX_LEGS} picks)</option>
            </select></label>
          </div>

          <div class="bf-sec" data-sec="parlay" hidden>
            <ol class="bf-legs" id="bfLegs"></ol>
            <label>Next leg<select id="bfLegType">
              <option value="wintotal">Team win total</option>
              <option value="game">Single game</option>
              <option value="future">Playoffs and futures</option>
              <option value="custom">Something else</option>
            </select></label>
          </div>

          <div class="bf-sec" data-sec="wintotal">
            <label>Team<select id="bfWTeam">${teamOptions("")}</select></label>
            <div class="bf-row">
              <label>Pick<select id="bfWSide"><option value="over">Over</option><option value="under">Under</option></select></label>
              <label>Your line (wins)<input id="bfWLine" type="number" inputmode="decimal" step="0.5" placeholder="Line you got"></label>
            </div>
            <p class="hint" id="bfWHint">Enter the line your sportsbook gave you. Lines move, so yours may differ.</p>
          </div>

          <div class="bf-sec" data-sec="game" hidden>
            <label>Game<select id="bfGGame">${gameOptions()}</select></label>
            <div class="bf-row">
              <label>Bet<select id="bfGKind"><option value="ml">Team to win</option><option value="spread">Spread</option><option value="total">Total points</option></select></label>
              <label data-g="team">Team<select id="bfGTeam"><option value="" disabled selected>Pick a game first</option></select></label>
              <label data-g="side" hidden>Pick<select id="bfGSide"><option value="over">Over</option><option value="under">Under</option></select></label>
            </div>
            <label data-g="line" hidden><span id="bfGLineLbl">Line</span>
              <span class="in-sgn"><input id="bfGLine" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" placeholder="-5.5"><button type="button" class="sgn" id="bfGSgn" data-flip="bfGLine" aria-label="Switch between plus and minus">+/−</button></span>
            </label>
          </div>

          <div class="bf-sec" data-sec="future" hidden>
            <div class="bf-row">
              <label>Bet<select id="bfFKind">
                <option value="playoffs">Make the playoffs</option>
                <option value="division">Win their division</option>
                <option value="title">Win the NBA title</option>
                <option value="cup">Win the NBA Cup</option>
              </select></label>
              <label data-f="side">Pick<select id="bfFSide"><option value="yes">Will make it</option><option value="no">Will miss</option></select></label>
            </div>
            <label>Team<select id="bfFTeam">${teamOptions("")}</select></label>
          </div>

          <div class="bf-sec" data-sec="custom" hidden>
            <label>What's the bet?<input id="bfText" type="text" maxlength="140" placeholder="Wembanyama over 25 points per game"></label>
          </div>

          <div class="bf-sec" data-sec="parlay-add" hidden>
            <button type="button" class="addleg" id="bfAddLeg">+ Add this leg</button>
          </div>

          <div class="bf-row">
            <label>Stake ($)<input id="bfStake" type="number" inputmode="decimal" min="0" step="1" placeholder="Optional"></label>
            <label><span id="bfOddsLbl">Odds</span>
              <span class="in-sgn"><input id="bfOdds" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" maxlength="8" placeholder="-110"><button type="button" class="sgn" data-flip="bfOdds" aria-label="Switch between plus and minus">+/−</button></span>
            </label>
          </div>
          <label>Note<input id="bfNote" type="text" maxlength="140" placeholder="Optional, like FanDuel or when you bet"></label>

          <p class="bf-preview" id="bfPreview" aria-live="polite"></p>
          <p class="chat-note" id="bfErr" role="status"></p>
          <div class="bf-actions"><button type="submit" class="primary" id="bfGo">Place bet</button><button type="button" id="bfCancel">Cancel</button></div>
          <p class="hint">Odds are American, like -110 or +250. Blank odds count as -110.</p>
        </form>
        <div id="betsBoard"></div>
        <div class="bets-filter" id="betsFilter"></div>
        <div id="betsList"></div>
      </div>`;
  }

  const val = (id) => { const e = root().querySelector("#" + id); return e ? e.value : ""; };

  // Parlay legs being built in the form (not saved until the whole parlay is placed).
  let legs = [];
  const effType = () => (val("bfType") === "parlay" ? val("bfLegType") : val("bfType"));

  function renderLegs() {
    const ol = root() && root().querySelector("#bfLegs");
    if (!ol) return;
    ol.innerHTML = legs.length
      ? legs.map((l, i) => { const d = describe(l); return `<li><span class="leg-n">${i + 1}</span><div class="leg-text"><p class="leg-title">${esc(d.title)}</p><p class="leg-detail">${esc(d.sub)}</p></div><button type="button" class="x" data-rmleg="${i}" aria-label="Remove leg ${i + 1}">×</button></li>`; }).join("")
      : `<li class="empty">No legs yet. Fill in a pick below, then tap Add this leg. You need 2 to ${MAX_LEGS}.</li>`;
    const full = legs.length >= MAX_LEGS;
    const add = root().querySelector("#bfAddLeg");
    if (add) { add.disabled = full; add.textContent = full ? `Maximum of ${MAX_LEGS} legs` : `+ Add this leg (${legs.length} of ${MAX_LEGS})`; }
  }

  function syncForm() {
    const el = root(); if (!el) return;
    const type = val("bfType"), eff = effType(), parlay = type === "parlay";
    el.querySelectorAll(".bf-sec").forEach((s) => {
      const sec = s.dataset.sec;
      s.hidden = !(sec === eff || (parlay && (sec === "parlay" || sec === "parlay-add")));
    });
    const oddsLbl = el.querySelector("#bfOddsLbl"); if (oddsLbl) oddsLbl.textContent = parlay ? "Parlay odds (from your slip)" : "Odds";
    const go = el.querySelector("#bfGo"); if (go) go.textContent = parlay ? "Place parlay" : "Place bet";
    renderLegs();
    const kind = val("bfGKind");
    const set = (sel, show) => { const n = el.querySelector(sel); if (n) n.hidden = !show; };
    set('[data-g="team"]', kind !== "total");
    set('[data-g="side"]', kind === "total");
    set('[data-g="line"]', kind !== "ml");
    set("#bfGSgn", kind === "spread"); // only spreads can be negative
    const lbl = el.querySelector("#bfGLineLbl");
    if (lbl) lbl.textContent = kind === "spread" ? "Your spread for this team (like -5.5 or +3)" : "Your total points line";
    set('[data-f="side"]', val("bfFKind") === "playoffs");
    const r = readForm(true);
    el.querySelector("#bfPreview").textContent = r.bet ? describe(r.bet).title : "";
  }

  // Numbers may carry a sign ("-3.5", "+3.5", or a typographic minus); anything else is invalid.
  const num = (id) => {
    const s = val(id).trim().replace("−", "-");
    if (s === "") return null;
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  };

  // Read one pick (a single bet, or one leg of a parlay) from the type-specific fields.
  function readLeg(type) {
    const bad = (m) => ({ leg: null, error: m });
    const b = { type };
    if (type === "wintotal") {
      b.team = val("bfWTeam"); b.side = val("bfWSide"); b.line = num("bfWLine");
      if (!b.team) return bad("Pick a team."); if (!isNum(b.line)) return bad("Enter the win total line, like 44.5.");
    } else if (type === "game") {
      const g = allGames().find((x) => x.id === val("bfGGame"));
      if (!g) return bad("Pick a game.");
      b.kind = val("bfGKind"); b.gameId = g.id; b.gameDay = g.day; b.gameLabel = `${g.away.abbr} @ ${g.home.abbr} · ${shortDay(g.day)}`;
      if (b.kind === "total") { b.side = val("bfGSide"); b.line = num("bfGLine"); if (!isNum(b.line)) return bad("Enter the total points line, like 221.5."); }
      else {
        b.team = val("bfGTeam"); if (!b.team) return bad("Pick a team.");
        if (b.kind === "spread") { b.line = num("bfGLine"); if (!isNum(b.line)) return bad("Enter the spread for your team, like -5.5."); }
      }
    } else if (type === "future") {
      b.kind = val("bfFKind"); b.team = val("bfFTeam");
      if (b.kind === "playoffs") b.side = val("bfFSide");
      if (!b.team) return bad("Pick a team.");
    } else {
      b.text = val("bfText").trim();
      if (!b.text) return bad("Describe the bet.");
    }
    return { leg: b, error: "" };
  }

  // Has anything been filled in for the pick currently on screen?
  function legTouched(type) {
    if (type === "wintotal") return !!(val("bfWTeam") || val("bfWLine"));
    if (type === "game") return !!val("bfGGame");
    if (type === "future") return !!val("bfFTeam");
    return !!val("bfText").trim();
  }

  function clearLegFields() {
    const el = root();
    ["bfWTeam", "bfWLine", "bfText", "bfFTeam"].forEach((id) => { const n = el.querySelector("#" + id); if (n) n.value = ""; });
    el.querySelector("#bfGGame").innerHTML = gameOptions(); fillGameTeams();
    const gl = el.querySelector("#bfGLine"); if (gl) gl.value = "";
    const hint = el.querySelector("#bfWHint"); if (hint) hint.textContent = "Enter the line your sportsbook gave you. Lines move, so yours may differ.";
  }

  // Build a bet from the form. `soft` skips error messages and just previews what's filled in.
  function readForm(soft) {
    const type = val("bfType"), who = val("bfWho");
    const bad = (m) => ({ error: soft ? "" : m, bet: null });
    if (!who && !soft) return bad("Pick your name.");
    let b;
    if (type === "parlay") {
      let list = legs.slice();
      const eff = val("bfLegType");
      // A pick that's filled in but not added yet gets added for them when they place the parlay.
      if (!soft && legTouched(eff)) {
        const r = readLeg(eff);
        if (r.error) return bad(`Finish the leg you're adding, or clear it. ${r.error}`);
        if (list.length >= MAX_LEGS) return bad(`A parlay can have at most ${MAX_LEGS} legs.`);
        list.push(r.leg);
      }
      if (!soft && list.length < 2) return bad(`A parlay needs at least 2 legs. You have ${list.length}.`);
      b = { owner: who, type: "parlay", legs: list };
    } else {
      const r = readLeg(type);
      if (r.error) return bad(r.error);
      b = { owner: who, ...r.leg };
      if (type === "custom") b.status = "pending";
    }
    const stake = num("bfStake");
    if (stake != null) {
      if (!isNum(stake) || stake <= 0) return bad("Stake should be more than $0, or leave it blank.");
      b.stake = Math.round(stake * 100) / 100;
    }
    let odds = val("bfOdds").trim().replace("−", "-");
    if (odds && !/^([+-]?\d{2,5}|even|ev)$/i.test(odds)) return bad("Odds look like -110 or +250.");
    if (odds && /^\d/.test(odds) && !/even|ev/i.test(odds)) odds = "+" + odds;
    if (odds) b.odds = odds;
    const note = val("bfNote").trim(); if (note) b.note = note;
    return { bet: b, error: "" };
  }

  function fillGameTeams() {
    const g = allGames().find((x) => x.id === val("bfGGame"));
    const sel = root().querySelector("#bfGTeam");
    sel.innerHTML = g
      ? `<option value="" disabled selected>Pick a team</option><option value="${esc(g.away.label || g.away.name)}">${esc(g.away.name)} (away)</option><option value="${esc(g.home.label || g.home.name)}">${esc(g.home.name)} (home)</option>`
      : `<option value="" disabled selected>Pick a game first</option>`;
  }

  function bind(el) {
    const q = (s) => el.querySelector(s);
    const toggle = (open) => {
      formOpen = open;
      q("#betForm").hidden = !open;
      q("#betAdd").textContent = open ? "Close" : "+ Add a bet";
      q("#betAdd").setAttribute("aria-expanded", String(open));
      if (open) { q("#bfGGame").innerHTML = gameOptions(); fillGameTeams(); syncForm(); }
    };
    q("#betAdd").onclick = () => toggle(!formOpen);
    q("#bfCancel").onclick = () => toggle(false);
    q("#bfAddLeg").onclick = () => {
      const err = q("#bfErr"); err.textContent = "";
      if (legs.length >= MAX_LEGS) { err.textContent = `A parlay can have at most ${MAX_LEGS} legs.`; return; }
      const r = readLeg(effType());
      if (r.error) { err.textContent = r.error; return; }
      legs.push(r.leg);
      clearLegFields();
      syncForm();
    };
    q("#betForm").addEventListener("input", syncForm);
    q("#betForm").addEventListener("change", (e) => {
      if (e.target.id === "bfGGame") fillGameTeams();
      if (e.target.id === "bfWTeam") {
        // The site's own line is only a reference. The bet uses whatever line the bettor types.
        const line = (C.winTotals || {})[val("bfWTeam")];
        q("#bfWHint").textContent = isNum(line)
          ? `The site's line for the ${val("bfWTeam")} is ${line}. Enter the line your sportsbook gave you. Lines move, so yours may differ.`
          : "Enter the line your sportsbook gave you. Lines move, so yours may differ.";
      }
      if (e.target.id === "bfWho") store.set(WHO_KEY, val("bfWho"));
      syncForm();
    });
    q("#betForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = q("#bfErr"); err.textContent = "";
      const r = readForm(false);
      if (r.error) { err.textContent = r.error; return; }
      if (!backend) { err.textContent = storeError || "Bets aren't ready yet. Try again in a moment."; return; }
      store.set(WHO_KEY, r.bet.owner);
      q("#bfGo").disabled = true;
      try {
        await backend.add(r.bet);
        ["bfStake", "bfOdds", "bfNote"].forEach((id) => { const n = q("#" + id); if (n) n.value = ""; });
        legs = [];
        clearLegFields();
        toggle(false);
      } catch (ex) {
        err.textContent = ex && ex.code === "permission-denied"
          ? "Couldn't save. The bets database isn't open yet. Ask Cole to publish the new Firebase rules."
          : "Couldn't save that bet. Check your connection and try again.";
      }
      q("#bfGo").disabled = false;
    });

    el.addEventListener("click", async (e) => {
      const f = e.target.closest("[data-f]");
      if (f && f.classList.contains("fchip")) { filter = f.dataset.f; update(); return; }
      const rm = e.target.closest("[data-rmleg]");
      if (rm) { legs.splice(Number(rm.dataset.rmleg), 1); syncForm(); return; }
      // +/- button next to a line or odds field: flips the sign so phones without a minus key can still enter -3.5
      const flip = e.target.closest("[data-flip]");
      if (flip) {
        const inp = q("#" + flip.dataset.flip);
        let s = inp.value.trim().replace("−", "-");
        s = s.startsWith("-") ? "+" + s.slice(1) : s.startsWith("+") ? "-" + s.slice(1) : "-" + s;
        inp.value = s;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      // Setting a result or removing a bet always goes through a confirm screen first.
      const res = e.target.closest("[data-setres]");
      if (res) { askResult(res.dataset.id, res.dataset.setres === "leg" ? Number(res.dataset.leg) : null); return; }
      const del = e.target.closest("[data-del]");
      if (del) askRemove(del.dataset.del);
    });
    syncForm();
  }

  // Called by app.js whenever the Bets tab is drawn (also on every score refresh).
  function render(panel) {
    panelEl = panel;
    start();
    if (!panel.querySelector(".bets")) { panel.innerHTML = shell(); bind(panel.querySelector(".bets")); }
    update();
  }
  function refresh() { if (panelEl && L.state.tab === "bets" && root()) update(); }

  window.LPGBets = { render, evaluate, describe, _bets: () => bets, _post: POST, _postInfo: postInfo };
})();
