  _____   _       ___   _   _    ____  	  _          _      _   _   _   _    ____   _   _   _____   ____  
 |  ___| | |     |_ _| | \ | |  / ___ 	 | |        / \    | | | | | \ | |  / ___| | | | | | ____| |  _ \ 
 | |_    | |      | |  |  \| | | |  _ 	 | |       / _ \   | | | | |  \| | | |     | |_| | |  _|   | |_) |
 |  _|   | |___   | |  | |\  | | |_| |	 | |___   / ___ \  | |_| | | |\  | | |___  |  _  | | |___  |  _ < 
 |_|     |_____| |___| |_| \_|  \____|	 |_____| /_/   \_\  \___/  |_| \_|  \____| |_| |_| |_____| |_| \_\

			Thanks for downloading Fling Launcher!

Fling Launcher is a Hello Neighbor launcher primarily targeted towards speedrunners, it includes mods and tools.
Fling Launcher also includes a leaderboard, showing you the top 50 of all categories, pulled from speedrun.com

## New in this build

- **Discord Rich Presence** — shows "Playing [alpha]" on your Discord
  profile while a game is running, via Discord's own RPC API (not Steam's).
  Register a free Discord Application at
  discord.com/developers/applications and paste its client ID into
  `DISCORD_CLIENT_ID` near the top of `main.js` — presence silently does
  nothing until you do.
- **Playtime tracking** — every entry now shows a cumulative playtime total
  under its mod status. Flushed to disk roughly once a minute while a game
  is running, not just when it closes.
- **Favorites** — right-click any entry → "Add to Favorites" to pin it to
  a new group at the top of the sidebar. It stays in its normal HN1/HN2
  group too; favoriting just adds a shortcut, it doesn't move anything.
- **Crash detection** — if a game closes and a fresh crash log/dump shows up
  under its `Saved/Crashes` or `Saved/Logs` folder, you'll get a "closed
  unexpectedly" notice with a button to open the log in Notepad. This is a
  heuristic (some builds structure `Saved/` differently or don't always
  write a dump), so it won't catch every crash, but it catches the common
  case.
- **One-click tool installer** — the Tools tab can now download and unpack
  LiveSplit and UModel for you (into the launcher's app-data folder), with
  a Launch button afterwards and an optional desktop shortcut you can tick
  before installing or toggle any time. Each tool also keeps an
  "or download the zip manually" link as a fallback.
- **speedrun.com account linking** — paste your username or profile link in
  Settings and the Leaderboard highlights your runs, shows your rank and
  time above the table (even if you're outside the top 50), and how far
  behind #1 you are. Only your public profile is read; there's no login.
