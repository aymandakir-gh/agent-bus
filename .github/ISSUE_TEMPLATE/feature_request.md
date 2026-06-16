---
name: Feature request / protocol proposal
about: Propose a change to the protocol or the reference implementation
title: ''
labels: enhancement
assignees: ''
---

**Is this a protocol change or an implementation change?**
- [ ] Protocol (`PROTOCOL.md` / `schemas/`) — affects the wire format
- [ ] Reference implementation only (TS lib, HTTP, CLI, clients)

**The problem**
What can't you do today?

**Proposal**
What you'd add or change. For protocol changes, remember the compatibility rules
(PROTOCOL.md §8): within `agent-bus/0`, changes must be **additive** (new optional
fields / message types). Breaking changes bump the protocol id.

**Alternatives considered**

**Does it stay zero-infra and local-first?**
The file transport must keep needing nothing but a directory, with no telemetry.
