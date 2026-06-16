# agent-bus — a message bus + task board over nothing but a shared folder.
#
# A VHS tape (https://github.com/charmbracelet/vhs). Render with:
#   pnpm build && vhs demo/agent-bus.tape
# produces demo/agent-bus.gif.

Output demo/agent-bus.gif

Set Shell "bash"
Set FontSize 18
Set Width 1280
Set Height 860
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

# --- setup (hidden): use the local build, start from a clean folder ----------
Hide
Type "alias agent-bus='node dist/cli.js'"
Enter
Type "rm -rf ./shared && clear"
Enter
Show

Type "# A bus is just a folder. No server, no database."
Enter
Type "agent-bus --dir ./shared init"
Enter
Sleep 1.2s

Type "# The lead posts three tasks to the board:"
Enter
Type 'agent-bus --dir ./shared create-task --title "Write the tests" --agent lead --task t1'
Enter
Sleep 400ms
Type 'agent-bus --dir ./shared create-task --title "Write the docs" --agent lead --task t2'
Enter
Sleep 400ms
Type 'agent-bus --dir ./shared create-task --title "Cut the release" --agent lead --task t3'
Enter
Sleep 800ms

Type "agent-bus --dir ./shared tasks"
Enter
Sleep 2s

Type "# Two workers race to claim. Each task goes to exactly one — atomically:"
Enter
Type "agent-bus --dir ./shared claim t1 --agent worker-1 && agent-bus --dir ./shared complete t1 --agent worker-1"
Enter
Sleep 1s
Type "agent-bus --dir ./shared claim t2 --agent worker-2 && agent-bus --dir ./shared complete t2 --agent worker-2"
Enter
Sleep 1s

Type "# worker-2 tries a task worker-1 already owns — and loses the race (exit 1):"
Enter
Type "agent-bus --dir ./shared claim t1 --agent worker-2"
Enter
Sleep 1.5s

Type "agent-bus --dir ./shared tasks"
Enter
Sleep 2.5s

Type "# The log is the source of truth — append-only, totally ordered:"
Enter
Type "agent-bus --dir ./shared messages --limit 5"
Enter
Sleep 3s

Type "# Same protocol over HTTP, a Python client, and a shared folder. That's it."
Enter
Sleep 2.5s
