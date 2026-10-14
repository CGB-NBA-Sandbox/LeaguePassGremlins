/*
  League settings. This is the only file you should need to edit during the season.
  Edit it right on GitHub (open the file, click the pencil icon, commit), and the site
  updates within a minute or two.
*/
window.LEAGUE = {
  name: "League Pass Gremlins",
  season: "2026-27",

  // Regular season window (ET dates). Weeks run Monday to Sunday; week 1 starts opening night.
  seasonStart: "2026-10-20",
  seasonEnd: "2027-04-11",

  // Weeks that get combined into one scoring week (few games in each half).
  // Each start must be a Monday and each end a Sunday. Delete an entry to score normally.
  mergedWeeks: [
    { start: "2026-11-30", end: "2026-12-13", note: "NBA Cup knockout rounds, two weeks" },
    { start: "2027-02-15", end: "2027-02-28", note: "All-Star break, two weeks" }
  ],

  // Money
  weeklyPot: 25,     // best win % each week takes this; ties split it
  seasonPrize: 50,   // best cumulative win % at season end
  cupPrize: 0,       // optional prize for owning the NBA Cup champion
  cupChampion: "",   // owner name once the Cup final is played, e.g. "Ben"

  // The NBA Cup final does not count in NBA standings, so it is skipped by default.
  excludeCupFinal: true,
  // ESPN game ids to ignore for any other reason, e.g. ["401810123"]
  excludeGameIds: [],

  // Mark a week true once its money has changed hands.
  paid: {
    // 1: true,
  },

  // Owners and their teams (2026-27 draft). Use team nicknames exactly as shown.
  owners: [
    { name: "Cole",   color: "#5AB0F0", teams: ["Nuggets", "Rockets", "Nets", "Grizzlies", "Spurs"] },
    { name: "Joe",    color: "#F59E4C", teams: ["Kings", "Pacers", "Pelicans", "Trail Blazers", "Warriors"] },
    { name: "Blaine", color: "#A594FF", teams: ["Bulls", "Pistons", "Timberwolves", "Suns", "Jazz"] },
    { name: "Grant",  color: "#4CC98F", teams: ["Hornets", "Mavericks", "Thunder", "Magic", "Raptors"] },
    { name: "Ben",    color: "#F2708F", teams: ["Cavaliers", "Hawks", "Knicks", "76ers", "Clippers"] },
    { name: "Devin",  color: "#EAD85A", teams: ["Celtics", "Wizards", "Bucks", "Lakers", "Heat"] }
  ],

  // Preseason win-total over/unders (O/U tab). LOCKED at the start of the season: these are a
  // fixed snapshot and do not follow the sportsbooks. Don't change them after opening night.
  winTotalsSource: "BetMGM preseason lines (draft - confirm before Oct 20)",
  winTotals: {
    "76ers": 50.5, "Bucks": 26.5, "Bulls": 27.5, "Cavaliers": 47.5, "Celtics": 51.5,
    "Clippers": 30.5, "Grizzlies": 28.5, "Hawks": 43.5, "Heat": 46.5, "Hornets": 37.5,
    "Jazz": 35.5, "Kings": 21.5, "Knicks": 52.5, "Lakers": 46.5, "Magic": 43.5,
    "Mavericks": 34.5, "Nets": 24.5, "Nuggets": 49.5, "Pacers": 44.5, "Pelicans": 27.5,
    "Pistons": 50.5, "Raptors": 45.5, "Rockets": 47.5, "Spurs": 59.5, "Suns": 40.5,
    "Thunder": 60.5, "Timberwolves": 48.5, "Trail Blazers": 43.5, "Warriors": 40.5, "Wizards": 35.5
  },

  // Group chat (Chat tab). Paste the firebaseConfig values from your Firebase project here.
  // These keys are meant to be public; the Firestore rules decide what people can do.
  chat: {
    room: "2026-27",
    // Each owner's chat login is <name>@loginDomain, created in Firebase > Authentication.
    loginDomain: "lpg.example.com",
    firebase: {
      apiKey: "AIzaSyDsWy0O6xMFUzGuXWQ7nkOTtX3M2fx1we4",
      authDomain: "league-pass-gremlins.firebaseapp.com",
      projectId: "league-pass-gremlins",
      storageBucket: "league-pass-gremlins.firebasestorage.app",
      messagingSenderId: "160603430811",
      appId: "1:160603430811:web:352f928fa3f56b86e40b3e"
    }
  }
};
