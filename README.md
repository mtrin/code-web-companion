# code-web-companion

A local web companion for Claude Code in tmux. It shows every Claude Code session on your machine as a live, readable page, lets you put notes on any sentence of Claude's last reply, and sends your messages straight into the tmux pane where Claude runs.

Everything stays on your machine. The server reads the transcripts Claude Code already writes under `~/.claude/projects`, listens on `localhost` only, and never talks to any outside service.

This is an early personal project. It runs on Linux, on Windows through WSL and on macOS. It reads Claude Code's own files, which are not a public interface, so a Claude Code update can change what it sees. It was last tested with Claude Code 2.1.331 on Linux and 2.1.332 on macOS.

## What it does

### Read your sessions

The sidebar lists recent sessions with their titles and working folders. A session opens as a live page: Claude's replies and your prompts are rendered as Markdown, with every line break in a prompt kept, and new entries appear as they land in the transcript. Slash command and shell output show as muted "Output" entries with terminal colour codes removed.

The page also shows what a terminal session adds around the prompts:

- messages typed while Claude works ("You, mid-turn")
- slash commands run in the terminal ("You, command") with their output
- Claude's multiple-choice questions ("Claude, question") with your answers and notes ("You, answer")
- plans from plan mode ("Claude, plan") with the approval or feedback ("You, plan")
- a dashed divider where the conversation was compacted, with the token counts before and after

Tool calls, thinking and subagent work are not shown. Every code block has a copy button, and hovering an entry shows a button that copies the whole entry as Markdown. Links to local files open in VS Code, through the WSL remote when the server runs in WSL.

### See how full the context window is

A thin bar along the bottom of each sidebar row fills in proportion to the session's context use, turns amber at 80%, and gives the exact figure on hover. The session header shows the same figure as text, such as `279k / 1M, 28%`. The figure is the input of the latest Claude reply: `input_tokens` plus `cache_creation_input_tokens` plus `cache_read_input_tokens` from the transcript's `usage` record, which matches what `/context` reports to within a thousand tokens. It changes when a reply arrives, not while Claude writes, and drops after `/compact` with the next reply. The transcript does not record the window size, so it comes from the `CONTEXT_WINDOW` setting.

### Put notes on any sentence of a reply

Ctrl+G, or the expand button beside Send, turns Claude's last reply into a notes view where it stands, so you can answer it point by point instead of as a whole. Ctrl+G again, Esc or the collapse button puts the normal reply back. The reply shows rendered by default, with aligned tables and coloured code blocks; the Rendered and Markdown buttons, or Ctrl+M, switch to the Markdown source and back, and notes stay in place across the switch.

A click selects the sentence under the pointer, a second click the word, a third the paragraph, and a fourth starts again at the sentence; dragging selects by character. In a table the steps are cell, word and row; in a code block, line, word and whole block. A selection opens a note box beside it, a small Markdown editor: Enter adds a line, Ctrl+Enter saves, Esc closes. Saved notes are numbered, colour the text they quote, and appear in a list under the reply.

Notes go out with your message. Send posts the notes first, each with its quote, then a `---` line, then the text of the message box:

```text
Notes on your last reply. Each one quotes the part it is about.

> It renders replies as Markdown, and it keeps prompts as typed. [1]

Too vague:
- say which parser
- say which records

> renders [2]

Say how.

---

Looks good overall.
```

Notes are kept in the browser per session until they are sent or dropped.

### Chat from the page

Every session that is not archived has a Markdown message box at the bottom of the page. A click on it, or the chat icon on a sidebar row, joins the session. Ctrl+Enter sends. Drafts are kept in the browser per session, so switching sessions or reloading loses nothing.

Joining picks one of these routes:

1. **A session open in a terminal inside tmux stays owned by that terminal.** The page pastes each message into its tmux pane and presses Enter. It finds the pane through the `tmux` field Claude Code writes to `~/.claude/sessions/<pid>.json`, and checks that the pane still runs that Claude process before typing. That field does not say which tmux server the pane is on, so the page looks for the Claude process among the companion's own tmux panes first and otherwise uses your default tmux server. Approvals, questions and pickers stay in the terminal, and sending is refused while the terminal waits for an answer.
2. **A session that is not open anywhere is resumed in the companion's own tmux server,** described below. The page runs `claude --resume <id>` there as the only process of a tmux session named `cc-` plus the first 8 characters of the session ID, waits until Claude Code lists it as open, and then sends messages through the same paste route. Under the message box the page shows the command that attaches a terminal to it, such as `tmux -L code-web attach -t cc-1234abcd`; a click copies it.
3. **With `HEADLESS_CHAT=1`, a session that is not open anywhere is resumed headless** instead, through the Claude Agent SDK. Replies stream into a draft area while Claude writes them. Requests that need a person show as cards with Allow and Deny, and questions show their options as a form. Going back to reading ends the process once any running turn finishes, so `claude --resume <id>` in a terminal continues cleanly.

A session open in a terminal outside tmux cannot be joined. Exit it there and join again, and it reopens in the companion's tmux server.

Each session has one Claude Code process at a time, because two processes on one session do not see each other's turns and fork the transcript. The page never starts a second process next to a terminal, and a headless chat leaves by itself when the session is opened in a terminal.

The Claude processes the page starts, in its tmux server or headless, get the environment of your login shell, started from your home folder the way tmux starts one, so `PATH` and tool versions match a terminal. `CLAUDE_WRAPPER` can put a command in front of Claude Code, such as a sandbox.

### The companion's tmux server

The page keeps the sessions it starts in a tmux server of its own, on the socket `code-web` (`tmux -L code-web`), with its own configuration in `src/tmux-web/tmux.conf`; your `~/.tmux.conf` is not read. That configuration turns on focus events, which Claude Code asks for, keeps window names, and keeps the last screen of a Claude that fails to start so the page can show the error. This part of the code, `src/tmux-web/`, knows nothing about Claude: it starts sessions, lists panes and streams a pane to the page.

It behaves like tmux you run yourself. Leaving a chat only disconnects the page; Claude keeps running until it exits, through `/exit` from the message box, the terminal panel or an attached terminal. The sidebar marks those sessions as open, as it does for any terminal. The server keeps running when the companion restarts, and the page links to its sessions again on the next join.

On macOS, privacy permissions follow the app a process traces back to. For Claude sessions in this server, and every tool they run, that is the service's `node`, not your terminal app, so the permissions you gave your terminal do not apply there. Requests for Files and Folders, Automation, Accessibility, Screen Recording or App Management are made in the name of "node", and macOS names "node" when it blocks one. A permission granted to `node` applies to every node script on the Mac.

For sessions in this server, a Terminal button in the session header opens Claude's real screen in a panel beside the page, fed by tmux control mode (`tmux -C`). Keys typed there go to Claude, Escape included, and the page's own shortcuts do not fire, so the notes view and the terminal stay apart. Approvals, questions and pickers are answered there. The panel opens by itself, with the keyboard in it, when Claude starts waiting for an answer, and the page never moves the keyboard out of it.

The panel and any terminal attached to the same session share one tmux window. As in tmux, the viewer used last sets its size: opening the panel or typing in it gives the window the panel's size, and typing in an attached terminal gives it that terminal's size. tmux does not count keys sent through control mode, so the panel claims the size itself with `switch-client` when you type in it. The panel always draws at the window's real size, which tmux reports to it, because the stream it gets is raw terminal output that only lines up at that size. While a smaller terminal holds the size, the panel shows empty space below.

### Archive and delete

Hovering a session in the sidebar shows archive and delete buttons. Archiving moves the transcript and its sidecar folder into `~/.claude/archive`, one folder per session named `<archive time in ms>-<session id>`, with a `restore.json` that records where each file came from. It refuses sessions that are open. The toast offers Undo for a few seconds, and the Archived tab lists archived sessions, which can still be read and can be unarchived. Unarchiving never overwrites a transcript that already exists.

Delete removes a session for good, with no undo. The first click turns the button into a red warning, and a second click at least half a second later deletes. It refuses sessions that are open or joined. When `CITE_ROOTS` is set, it also refuses sessions whose 8-character ID prefix appears in those files, so links to a session from your notes keep working.

Claude Code itself deletes transcripts that have been inactive for longer than `cleanupPeriodDays` in `~/.claude/settings.json`, 30 days by default. Raise it, or archive what you want to keep, before that happens.

## Install

You need:

- Linux, Windows with WSL, or macOS
- Node.js 26 or newer
- Claude Code
- tmux, which runs every chat the page starts and carries messages into terminal sessions; tested with tmux 3.8
- VS Code, optional, to open local file links

```sh
git clone https://github.com/mtrin/code-web-companion.git
cd code-web-companion
npm ci
npm start
```

Then open <http://localhost:7878>. Under WSL, the Windows browser reaches it at the same address.

### macOS

Install Node.js and tmux with Homebrew, then follow the same steps:

```sh
brew install node tmux
```

On Linux the server finds running Claude Code processes through `/proc`; macOS has no `/proc`, so there it reads the same facts from `ps`. On macOS 15 with Claude Code 2.1.332, sessions open in a terminal show as open in the sidebar, and every chat route and archive work. If a session open in a terminal ever shows as closed, do not join it: joining would start a second Claude process on it and fork its transcript.

### Run it as a service

On Linux and WSL a systemd user service keeps it running. Copy `code-web-companion.service` into `~/.config/systemd/user/`, set `WorkingDirectory` to your clone and `ExecStart` to the output of `command -v node` followed by `src/server.ts`, and add an `Environment=` line for each setting you change. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now code-web-companion
loginctl enable-linger "$USER"
```

The last line starts the service at boot without a login. Logs come from `journalctl --user -u code-web-companion`. The unit sets `KillMode=process`, so a restart stops only the server and the companion's tmux server keeps its Claude sessions; without it systemd stops every process the service started. This has not been tested on Linux yet.

On macOS a launchd agent keeps it running. Copy `com.mtrin.code-web-companion.plist` into `~/Library/LaunchAgents/`, and in it set the first `ProgramArguments` entry to the output of `command -v node`, `WorkingDirectory` to your clone, and both log paths to your home folder, because launchd does not expand `~` or `$HOME`. Add an `EnvironmentVariables` dictionary for the settings you change. Then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mtrin.code-web-companion.plist
```

The agent starts at once and at every login, runs while you are logged in, and launchd starts it again if it stops. After pulling an update, `launchctl kickstart -k gui/$(id -u)/com.mtrin.code-web-companion` restarts it. After editing the plist, `launchctl bootout gui/$(id -u)/com.mtrin.code-web-companion` and then the `bootstrap` line above load the new version. Logs go to `~/Library/Logs/code-web-companion.log`, which the Console app also shows. `ProcessType` is `Interactive` because launchd puts light CPU and disk limits on agents without it, and the chats the page starts run as children of the server. The companion's tmux server outlives the agent: in a test on macOS 15, a tmux server started by a launchd job kept running through both `kickstart -k` and `bootout`, and the restarted job reached it again.

Besides crashes, the log records each chat error and each refused or failed send, Stop, archive, unarchive and delete, one line each with the session ID.

## Settings

All settings are environment variables.

| Variable           | Default                                                             | Meaning                                                                                              |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`             | `7878`                                                              | Listen port                                                                                          |
| `HOST`             | `127.0.0.1`                                                         | Listen address; the server only answers requests for `localhost`                                     |
| `PROJECTS_DIR`     | `~/.claude/projects`                                                | Transcript root                                                                                      |
| `ARCHIVE_DIR`      | `~/.claude/archive`                                                 | Where archived sessions go                                                                           |
| `SESSION_REGISTRY` | `~/.claude/sessions`                                                | Claude Code's list of running sessions                                                               |
| `CLAUDE_BIN`       | `~/.local/bin/claude` if present, else `claude` on `PATH`           | Claude Code executable for the chats the page starts                                                 |
| `CLAUDE_WRAPPER`   | none                                                                | Command and arguments put in front of Claude Code for the chats the page starts, such as a sandbox   |
| `TMUX_BIN`         | `tmux` from Homebrew or `/usr/local/bin` if present, else on `PATH` | tmux for terminal chats and the companion's tmux server                                              |
| `TMUX_SOCKET`      | `code-web`                                                          | Socket name of the companion's tmux server, as in `tmux -L code-web`                                 |
| `HEADLESS_CHAT`    | off                                                                 | `1` resumes closed sessions headless through the Agent SDK instead of in the companion's tmux server |
| `CITE_ROOTS`       | none                                                                | Colon-separated files and folders searched before a delete                                           |
| `WSL_DISTRO`       | `WSL_DISTRO_NAME`                                                   | Distro name in VS Code links; empty outside WSL                                                      |
| `HOST_HOME`        | `$HOME`                                                             | Shown as `~` in folder names                                                                         |
| `SESSION_LIMIT`    | `80`                                                                | Most recent sessions listed                                                                          |
| `POLL_MS`          | `750`                                                               | How often an open session checks for new lines                                                       |
| `CHAT_IDLE_MS`     | `600000`                                                            | Idle time before an unwatched joined session is left                                                 |
| `CONTEXT_WINDOW`   | `1000000`                                                           | Context window size the bars are measured against                                                    |

## Safety

Every request must name `localhost`, `127.0.0.1` or `[::1]` as its host, which blocks DNS rebinding. Requests that change anything also need an `Origin` header for the same host and the `x-viewer-token` header, a random token the page fetches at load. Other web pages cannot read that token or pass the origin check.

The terminal panel can send any key to Claude, including its `!` shell commands, so the page carries the same trust as your terminal. Its input and size routes need the same origin and token checks as every other change. The companion's tmux socket lives in `/tmp/tmux-<uid>/`, which only your user can open. Keep `HOST` at `127.0.0.1`: the page is meant for this machine only.

## Development

`npm run dev` restarts on file changes, and `npm run check` runs the TypeScript check. Use another port, such as `PORT=7880`, next to a running service. `npm ci` also bundles CodeMirror and xterm.js into `public/vendor` through the `prepare` script; after changing a file in `web/`, run `npm run build`. Code block languages load from `public/vendor/chunks` only when a reply uses them.

The sidebar footer shows the version that is running: the `version` from `package.json`, the git commit and its date, and "local changes" when the clone has uncommitted edits to tracked files. The server reads them once at startup, so after pulling an update the footer changes only when the service restarts. Hovering it gives the full details, and `/api/version` returns them as JSON.

The server is Node running TypeScript directly through type stripping, so the code avoids syntax that needs compiling, such as enums and constructor parameter properties. The live channel is Server-Sent Events at `/api/sessions/:id/events`, carrying transcript entries and chat status. Changes go through POST routes under `/api/sessions/:id/`. The terminal panel has its own Server-Sent Events stream at `/api/tmux/:name/stream`, carrying the screen and then the pane's output as base64 bytes, and POST routes at `/api/tmux/:name/input` and `/api/tmux/:name/size`; they accept only sessions on the companion's tmux server. The Agent SDK is pinned to a release that matches a recent Claude Code.

| Path                                 | Role                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/transcript/parse.ts`            | Turns transcript records into entries                                                                                      |
| `src/transcript/reader.ts`           | Reads complete JSON lines from a byte offset                                                                               |
| `src/transcript/follower.ts`         | Follows one transcript and pushes new entries to subscribers                                                               |
| `src/transcript/branches.ts`         | Hides cancelled and rewound messages by following the active parent chain                                                  |
| `src/transcript/sessions.ts`         | Lists live and archived sessions with titles and working folders                                                           |
| `src/transcript/open.ts`             | Reads `~/.claude/sessions` to mark sessions open in a terminal                                                             |
| `src/render/markdown.ts`             | Markdown to HTML, code blocks, link rewriting                                                                              |
| `src/render/plain.ts`                | "Output" entries and compaction dividers shown as plain text                                                               |
| `src/chat/launch.ts`                 | Login shell environment, the server's own environment without Claude variables, and the wrapped process launch             |
| `src/chat/host.ts`                   | Headless chat (`HEADLESS_CHAT=1`): messages, streamed draft, permission requests, leave                                    |
| `src/chat/terminal.ts`               | Terminal chat: pastes messages into the session's tmux pane, on your tmux server or the companion's, and mirrors its state |
| `src/chat/registry.ts`               | Picks the route on join, starts closed sessions in the companion's tmux server, page subscribers and the idle sweep        |
| `src/tmux-web/server.ts`             | The companion's tmux server: starts sessions, lists panes, hands out control clients                                       |
| `src/tmux-web/control.ts`            | tmux control mode client: a pane's output as bytes, typed input, size and the current screen                               |
| `src/tmux-web/routes.ts`             | Terminal routes under `/api/tmux/:name/`: the output stream, input and size                                                |
| `src/tmux-web/run.ts`                | Runs one tmux command on a chosen server                                                                                   |
| `src/tmux-web/tmux.conf`             | Configuration of the companion's tmux server                                                                               |
| `src/processes.ts`                   | Process names and parents, from `/proc` on Linux and `ps` elsewhere                                                        |
| `src/archive.ts`                     | Archive and unarchive                                                                                                      |
| `src/delete.ts`                      | Permanent delete with the citation and location checks                                                                     |
| `src/security.ts`                    | Host, origin and token checks                                                                                              |
| `src/version.ts`                     | The running version: package version, git commit and date, uncommitted changes                                            |
| `src/app.ts`                         | HTTP routes                                                                                                                |
| `public/`                            | Browser page, plain JavaScript and CSS with no build step                                                                  |
| `public/prompt.js`                   | Markdown editors: the message box and the note box                                                                         |
| `public/annotate.js`                 | The notes view: click rules, notes, the Rendered and Markdown switch                                                       |
| `public/preview.js`                  | Rendered view of the reply over the same Markdown text                                                                     |
| `public/terminal.js`                 | The terminal panel: xterm.js fed by the output stream, typing sent back                                                    |
| `web/codemirror.js`                  | CodeMirror modules both editors use, bundled by `npm run build`                                                            |
| `web/xterm.js`, `web/xterm.css`      | xterm.js and its stylesheet, bundled by `npm run build`                                                                    |
| `code-web-companion.service`         | Example systemd user unit                                                                                                  |
| `com.mtrin.code-web-companion.plist` | Example launchd agent for macOS                                                                                            |

## Roadmap

Not built yet, roughly in the order wanted. The direction is a tmux companion for Claude Code: the page reads transcripts and types into the session's tmux pane, and relies less on the Agent SDK over time; the SDK route already runs only with `HEADLESS_CHAT=1`.

A test with a throwaway session in a detached tmux session checked the paste route: bracketed paste, then Enter 200 ms later. Slash commands such as `/rename` and `/context` ran even with Claude Code's own command menu open, because the exact name is the top match. A message ending in `@file` made Claude Code read that file before answering, even with its file picker open. Command runs and their output land in the transcript as `system` records with subtype `local_command`, which the page already shows.

1. **Notes on any reply, not only the last.** Let any reply open the notes view in place, store notes per reply, and group them in the sent message under a short header per reply. Older and Newer buttons in the notes view and a notes icon on every reply move between them.
2. **Slash command menu in the message box.** The menu takes the session's skills from the transcript's `skill_listing` attachment, plus a short list of built-in commands that run without a picker: `/compact`, `/context`, `/clear`, `/rename <name>`, `/model <name>`. Commands that open a picker would open it in the terminal, so the menu leaves them out. `/clear` starts a new session ID, so the page would follow it to the new transcript.
3. **Tool activity.** Show each tool call as one collapsed line with its result behind a click, without letting hundreds of calls bury the conversation.
4. **Weekly usage beside the context bar.** Transcripts never record plan limits, but Claude Code passes them to the status line command: `rate_limits.seven_day.used_percentage` and `resets_at`, with `five_hour` beside them. A small status line script would save that JSON for the page. The figure updates only while a terminal session is active, so the page shows its age.
5. **`@` file search in the message box.** A server route lists the files in the session's folder, and the box offers them after `@` with fuzzy matching. The tmux paste carries `@path` unchanged.
6. **Edits to a reply.** An edit mode where typing changes the reply. Notes follow the edits, and each edit goes out as a small `diff` block with Claude's original wording on the minus side. Typing directly in the rendered view comes last.
7. **Search across all chats with Ctrl+K.** A fuzzy search over every session, live and archived, matching prompts and replies as well as titles and folders. Moving through the results previews the matching part of each chat, and Enter opens the session at that spot. Transcripts grow to gigabytes, mostly tool output, so the server keeps an index of prompt and reply text only.
8. **Start a new chat in tmux from the page.** Resuming a closed session in the companion's tmux server is done, and it replaced the headless SDK route as the default. Still to come: a New session button that starts a brand new Claude session in a chosen working folder the same way, and joins it through the paste route.
9. **Headless and tmux chats look different.** The sidebar chat icon, the status beside the message box and the session header each show the mode. The planned choice before going headless became the `HEADLESS_CHAT` setting, off by default.
10. **The page drives tmux.** The page lists tmux sessions and windows with the Claude session running in each, and can bring a window to the front, open, close or rename one. Answering approvals and questions is done through the terminal panel, which shows Claude's real screen, so the page does not need to read Claude Code's screen layout with `tmux capture-pane`.
11. **Rename sessions.** For a session open in a tmux pane, the page pastes `/rename <name>`. Otherwise the server appends the record Claude Code writes for a rename, `{"type":"custom-title","customTitle":"<name>","sessionId":"<id>"}`.
12. **Resize or hide the sidebar.** A drag handle sets its width, and a button and a key hide it. Both are kept in the browser.
13. **Resize the message box.** A drag handle on its top edge sets its height, kept in the browser; a double click restores the default.
14. **Refine the context bar colour.** The bar uses a light blue, `--context` in `public/style.css`, so it stands apart from the darker blue border of the selected row. The exact shade is not settled.
15. **Never lose a chat to Claude Code's cleanup.** By default the server archives a session one day before Claude Code's `cleanupPeriodDays` limit would delete it, skipping open sessions. It checks when the service starts and then every hour, so a computer that was off for a while is covered before the first new session runs the cleanup. A full backup that copies each transcript as it grows is an optional extra.
16. **Compress archived chats, and show them as usual.** Archived transcripts never change, so archiving can compress them with zstd and unarchiving puts back the plain file that `claude --resume` needs. Node's built-in `zlib` reads it, so the page opens a compressed chat like any other.
17. **An install command.** One command that writes the systemd or launchd service with the right paths filled in.
18. **A faster terminal panel.** Typing in the panel feels a little slower than in a terminal app, most visibly at the caret. First measure where the time goes: sending the key, tmux and Claude, and drawing. If drawing dominates, switch xterm.js to its GPU renderer, `@xterm/addon-webgl`, which draws on the GPU the way Ghostty does instead of with page elements.
19. **macOS permissions of its own.** Sessions in the companion's tmux server get their macOS privacy permissions through the service's `node`, so granting one there grants it to every node script. A small app bundle that launchd starts in place of `node` would give the companion its own identity, so its permissions cover only its own sessions.
- claude project management
- Fancy tmux commands or workflows started from web like
    a. Temporarily add another project (memories etc) to this project or session
    b. memory management linking, unlinking with a toggle

## License

MIT
