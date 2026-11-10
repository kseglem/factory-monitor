# Factory monitor

A live dashboard to keep open while you do the [software factory workshop](https://chrhein.github.io/software-factory-ws/workshop.html). It shows the stations you have built, which agent is running right now and what it is doing (each file it reads, each edit as a diff, each command), the verdict from every stage, the lessons the factory has learned, and what has happened on GitHub.

It is spoiler-free: stations appear only after you have created their file in `factory/`. A **Show upcoming** button reveals the rest.

It is read-only and lives outside the workshop repo, so it doesn't change any step of the workshop.

## Setup (2 minutes, at any point in the workshop)

You need Node 22 or later. There is nothing to install.

1. Clone this repo **next to** your workshop repo. Do not clone it inside the workshop repo.

   ```sh
   cd ..          # the folder that contains woltora-factory/
   git clone https://github.com/kseglem/factory-monitor.git
   ```

2. Start it in a separate terminal, from inside your workshop repo, and leave it running:

   ```sh
   cd woltora-factory
   node ../factory-monitor/server.mjs
   ```

3. Open **http://localhost:4777**.

That's it. Do the workshop as usual. The page updates every second or two.

If your workshop repo is somewhere else, give its path: `node factory-monitor/server.mjs ~/code/woltora-factory`.

## What you see

| Section | What it shows |
|---|---|
| **Production line** | The stations you've built so far, in pipeline order. Agents and plain-code gates are labelled differently. A station lights up while it runs. Click one to see its prompt or script and the tools that agent is allowed to use. |
| **Now** | The running `factory/*.sh` scripts as a tree (`watch.sh → run.sh → stage.sh → claude -p`), with timers and each agent's allowed and denied tools. Below that is a live trace of the agent's tool calls. When nothing is running, it shows the most recent agent session. |
| **Lessons** | The `LESSON:` lines the stages have added to `factory/context.md`. |
| **Working tree** | What the agents changed in `src/`, with a diff, plus stashes, `factory/*` branches and recent commits. |
| **GitHub** | Issues, PRs and CI runs, fetched with `gh` every 30 seconds. |
| **Runs** | One row per `runs/` folder, with a verdict and duration for each stage. Click a verdict to see the output and the full agent trace. |
| **Measurements** | Time and spend per stage, how many tool calls were blocked, and `runs/log.jsonl`. |

## How it stays out of the way

- It is outside the workshop repo, so it never ends up in `git add factory`. It doesn't trip the "commit factory/ first" checks or affect `node --test` or the Vite build, and the agents never see it when they search the repo.
- It never writes a file. It reads `factory/`, `runs/` and Claude Code's session logs in `~/.claude/projects/<repo>/`. Only the headless `claude -p` sessions that `stage.sh` starts are parsed. Your interactive sessions are ignored.
- It runs `git` with `GIT_OPTIONAL_LOCKS=0`, so it never takes `index.lock` while `verify.sh` or `ship.sh` use git.
- It finds running scripts with `ps` and never signals them.
- It listens on `127.0.0.1` only.

## Notes

- **Using Copilot instead of Claude?** Everything works except the live agent trace, which needs Claude Code's session logs.
- Options: `PORT=4800` for another port, `NO_GH=1` to skip GitHub calls.
- Works on macOS and Linux. Windows is not supported (it uses `ps`).
