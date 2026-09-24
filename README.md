# League Pass Gremlins

Live standings for the League Pass Gremlins NBA pool. Scores come straight from ESPN, so nothing needs to be entered by hand except team assignments and who has paid.

## Put it online (GitHub Pages, about 5 minutes)

1. Sign in at github.com and click **New repository**. Name it something like `league-pass-gremlins`, set it to **Public**, and create it.
2. On the new repo page, click **uploading an existing file**, drag in `index.html`, `style.css`, `app.js`, `config.js`, and this README, then click **Commit changes**.
3. Go to **Settings > Pages**. Under "Build and deployment," set Source to **Deploy from a branch**, Branch to **main** and folder **/(root)**, then **Save**.
4. Wait a minute or two. The site will be live at `https://YOUR-USERNAME.github.io/league-pass-gremlins/`. Share that link with the group.

## During the season

Everything you change lives in `config.js`. Open it on GitHub, click the pencil icon, edit, and commit. The site updates within a couple of minutes.

- **After the draft:** replace each owner's `teams` list (use nicknames like "Trail Blazers", "76ers").
- **Mark a week paid:** add a line inside `paid`, e.g. `3: true,`
- **NBA Cup champion:** set `cupChampion` to the owner's name, and `cupPrize` if there's money on it.
- **Combined weeks:** `mergedWeeks` currently merges Nov 30 to Dec 13 (Cup knockouts) and Feb 15 to 28 (All-Star break). Adjust or delete to match what the group agrees on.

## How scoring works

- Weeks run Monday to Sunday (week 1 is opening night Tuesday through Sunday).
- Each owner's weekly win % counts every game their five teams play. When two of your own teams play each other, you get one win and one loss.
- Best weekly win % takes the weekly pot; ties split it.
- Best cumulative win % (total wins over total games) takes the season prize after the last day of the regular season.
- Only regular-season games count. The NBA Cup final is skipped by default because it doesn't count in NBA standings.
