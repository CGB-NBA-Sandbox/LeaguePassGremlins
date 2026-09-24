/*
  Group chat for the Chat tab. Messages live in Firebase (Firestore) so everyone sees
  the same thread; the connection settings go in `chat.firebase` in config.js.

  Each owner signs in with their own password. Their login is <name>@<loginDomain>
  (e.g. ben@lpg.example.com), created by hand in Firebase Authentication. The Firestore
  rules only accept a message as "Ben" from Ben's login, and only signed-in owners can read.
*/
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const C = window.LEAGUE;
const cfg = C.chat || {};
const room = cfg.room || C.season;
const domain = cfg.loginDomain || "lpg.example.com";
const MAX = 500;
const NAME_KEY = "lpg:chat:name";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ownerByName = Object.fromEntries(C.owners.map((o) => [o.name, o]));
const emailFor = (name) => `${name.toLowerCase()}@${domain}`;
const nameFor = (email) => (C.owners.find((o) => emailFor(o.name) === String(email || "").toLowerCase()) || {}).name || null;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
};

let started = false;
let backend = null;
let me = null;
let messages = [];
let unsub = null;

// ---------- backend ----------
async function firebaseBackend() {
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-firestore.js"),
    import(FB + "firebase-auth.js")
  ]);
  const app = initializeApp(cfg.firebase);
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);
  const col = fs.collection(db, "rooms", room, "messages");
  return {
    onUser: (cb) => au.onAuthStateChanged(auth, (u) => cb(u ? nameFor(u.email) : null)),
    signIn: (name, password) => au.signInWithEmailAndPassword(auth, emailFor(name), password),
    signOut: () => au.signOut(auth),
    listen(onChange, onError) {
      const q = fs.query(col, fs.orderBy("ts", "desc"), fs.limit(200));
      return fs.onSnapshot(q, (snap) => {
        onChange(snap.docs.map((d) => {
          const x = d.data();
          return { id: d.id, name: x.name, text: x.text, ts: x.ts ? x.ts.toDate() : new Date() };
        }).reverse());
      }, onError);
    },
    send: (name, text) => fs.addDoc(col, { name, text, ts: fs.serverTimestamp() })
  };
}

// ---------- rendering ----------
function when(d) {
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`;
}

function renderMessages() {
  const list = $("#chatList");
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.innerHTML = messages.length ? messages.map((m, i) => {
    const o = ownerByName[m.name];
    const prev = messages[i - 1];
    const grouped = prev && prev.name === m.name && m.ts - prev.ts < 5 * 60e3;
    return `
      <li class="msg${m.name === me ? " mine" : ""}${grouped ? " grouped" : ""}" style="--c:${esc(o ? o.color : "#92A5C3")}">
        ${grouped ? "" : `<div class="meta"><span class="who">${esc(m.name)}</span><time>${esc(when(m.ts))}</time></div>`}
        <p class="bubble">${esc(m.text)}</p>
      </li>`;
  }).join("") : `<li class="empty">No messages yet. Say something.</li>`;
  if (nearBottom || !list.dataset.scrolled) { list.scrollTop = list.scrollHeight; list.dataset.scrolled = "1"; }
}

function shell() {
  const o = ownerByName[me];
  $("#chat").innerHTML = `
    <ul class="chat-list" id="chatList" aria-live="polite"><li class="empty">Loading messages…</li></ul>
    <form class="chat-form" id="chatForm" autocomplete="off">
      <textarea id="chatText" rows="1" maxlength="${MAX}" placeholder="Message the group" aria-label="Message"></textarea>
      <button type="submit" id="chatSend">Send</button>
    </form>
    <p class="chat-note" id="chatNote" role="status"></p>
    <p class="chat-me">Signed in as <span class="who" style="--c:${esc(o.color)}">${esc(me)}</span>
      <button type="button" class="linkish" id="chatOut">Sign out</button></p>`;

  const form = $("#chatForm"), text = $("#chatText"), note = $("#chatNote");
  const grow = () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 140) + "px"; };
  text.addEventListener("input", grow);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  $("#chatOut").addEventListener("click", () => backend.signOut());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) return;
    $("#chatSend").disabled = true;
    note.textContent = "";
    try {
      await backend.send(me, msg.slice(0, MAX));
      text.value = ""; grow();
      $("#chatList").dataset.scrolled = "";
    } catch (err) {
      note.textContent = "That message didn't send. Check your connection and try again.";
    } finally {
      $("#chatSend").disabled = false;
      text.focus();
    }
  });
}

function gate(msg) {
  const saved = store.get(NAME_KEY);
  const opts = C.owners.map((o) => `<option${o.name === saved ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  $("#chat").innerHTML = `
    <form class="chat-gate" id="chatGate">
      <p>Sign in to see and send messages.</p>
      <div class="gate-row">
        <select id="gateName" aria-label="Your name">
          <option value="" disabled${saved && ownerByName[saved] ? "" : " selected"}>Who are you?</option>${opts}
        </select>
        <input id="gatePass" type="password" placeholder="Your password" aria-label="Password" autocomplete="current-password">
        <button type="submit" id="gateBtn">Sign in</button>
      </div>
      <p class="chat-note" id="gateNote" role="status">${esc(msg || "")}</p>
    </form>`;
  $("#chatGate").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#gateName").value, pass = $("#gatePass").value, note = $("#gateNote");
    if (!name) { note.textContent = "Pick your name first."; return; }
    if (!pass) { note.textContent = "Enter your password."; return; }
    store.set(NAME_KEY, name);
    $("#gateBtn").disabled = true;
    note.textContent = "";
    try {
      await backend.signIn(name, pass);
    } catch (err) {
      const code = (err && err.code) || "";
      note.textContent = /invalid-credential|wrong-password|user-not-found|invalid-login/.test(code)
        ? "That password didn't match. Ask Cole if you need it reset."
        : /too-many-requests/.test(code) ? "Too many tries. Wait a few minutes and try again."
        : "Couldn't sign in. Check your connection and try again.";
      $("#gateBtn").disabled = false;
    }
  });
}

// ---------- signed-in state ----------
function onUser(name) {
  if (unsub) { unsub(); unsub = null; }
  messages = [];
  me = name;
  if (!me) { gate(); return; }
  shell();
  unsub = backend.listen((m) => { messages = m; renderMessages(); }, () => {
    if ($("#chatNote")) $("#chatNote").textContent = "Chat couldn't load. Try signing out and back in.";
  });
}

// ---------- start on first open ----------
async function start() {
  if (started) { renderMessages(); return; }
  started = true;
  if (!window.__lpgChatBackend && !(cfg.firebase && cfg.firebase.apiKey)) {
    $("#chat").innerHTML = `<p class="empty">Chat isn't connected yet. Add the Firebase settings to <code>chat.firebase</code> in config.js.</p>`;
    return;
  }
  $("#chat").innerHTML = `<p class="empty">Loading chat…</p>`;
  try {
    backend = window.__lpgChatBackend || await firebaseBackend();
  } catch (err) {
    $("#chat").innerHTML = `<p class="error">Chat couldn't load. Check your connection and reopen the tab.</p>`;
    return;
  }
  backend.onUser(onUser);
}

window.addEventListener("lpg:chat-open", start);
if (!$("#chat").hidden) start();
