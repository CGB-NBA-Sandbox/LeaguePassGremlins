/*
  Group chat for the Chat tab. Messages live in Firebase (Firestore) so everyone sees
  the same thread; the connection settings go in `chat.firebase` in config.js.
*/
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const C = window.LEAGUE;
const cfg = C.chat || {};
const room = cfg.room || C.season;
const MAX = 500;
const NAME_KEY = "lpg:chat:name";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ownerByName = Object.fromEntries(C.owners.map((o) => [o.name, o]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
};

let started = false;
let backend = null;
let messages = [];

// ---------- backend ----------
async function firebaseBackend() {
  const [{ initializeApp }, fs] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-firestore.js")
  ]);
  const db = fs.getFirestore(initializeApp(cfg.firebase));
  const col = fs.collection(db, "rooms", room, "messages");
  return {
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
  const me = $("#chatName").value;
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
  const saved = store.get(NAME_KEY);
  const opts = C.owners.map((o) => `<option${o.name === saved ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  $("#chat").innerHTML = `
    <ul class="chat-list" id="chatList" aria-live="polite"><li class="empty">Loading messages…</li></ul>
    <form class="chat-form" id="chatForm" autocomplete="off">
      <select id="chatName" aria-label="Posting as">
        <option value="" disabled${saved && ownerByName[saved] ? "" : " selected"}>Who are you?</option>${opts}
      </select>
      <textarea id="chatText" rows="1" maxlength="${MAX}" placeholder="Message the group" aria-label="Message"></textarea>
      <button type="submit" id="chatSend">Send</button>
    </form>
    <p class="chat-note" id="chatNote" role="status"></p>`;

  const form = $("#chatForm"), text = $("#chatText"), name = $("#chatName"), note = $("#chatNote");
  const grow = () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 140) + "px"; };
  text.addEventListener("input", grow);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  name.addEventListener("change", () => { store.set(NAME_KEY, name.value); renderMessages(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!name.value) { note.textContent = "Pick your name first."; name.focus(); return; }
    if (!msg || !backend) return;
    $("#chatSend").disabled = true;
    note.textContent = "";
    try {
      await backend.send(name.value, msg.slice(0, MAX));
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

// ---------- start on first open ----------
async function start() {
  if (started) { renderMessages(); return; }
  started = true;
  if (!window.__lpgChatBackend && !(cfg.firebase && cfg.firebase.apiKey)) {
    $("#chat").innerHTML = `<p class="empty">Chat isn't connected yet. Add the Firebase settings to <code>chat.firebase</code> in config.js.</p>`;
    return;
  }
  shell();
  try {
    backend = window.__lpgChatBackend || await firebaseBackend();
    backend.listen((m) => { messages = m; renderMessages(); }, () => {
      $("#chatNote").textContent = "Chat couldn't load. Check your connection and reopen the tab.";
    });
  } catch (err) {
    $("#chatList").innerHTML = `<li class="error">Chat couldn't load. Check your connection and reopen the tab.</li>`;
  }
}

window.addEventListener("lpg:chat-open", start);
if (!$("#chat").hidden) start();
