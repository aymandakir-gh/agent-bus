# Demo recording

[`agent-bus.tape`](./agent-bus.tape) is a [VHS](https://github.com/charmbracelet/vhs)
script that records the headline flow: a folder becomes a bus, the lead posts
tasks, two workers race to claim them (each task goes to exactly one — the loser
exits non-zero), and the append-only log shows the total order.

## Render it

```bash
# install VHS: https://github.com/charmbracelet/vhs#installation
pnpm build           # the tape drives the built CLI (node dist/cli.js)
vhs demo/agent-bus.tape
# → demo/agent-bus.gif
```

The tape aliases `agent-bus` to the local build, so it renders without a global
install. To record against the published package instead, change the hidden
setup line to `alias agent-bus='npx agent-bus'`.

## Live two-terminal version

For the interactive, two-terminals-one-folder walkthrough (the version worth
doing live), see [`examples/shared-folder`](../examples/shared-folder/README.md).
