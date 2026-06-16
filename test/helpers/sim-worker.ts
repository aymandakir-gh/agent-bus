/**
 * A simulated agent, run as its own OS process by the concurrency simulation
 * (`test/concurrency.sim.test.ts`). It races every other worker to claim and
 * complete tasks over one shared file bus, talking to nothing but the folder.
 *
 * Invoked as: node --import tsx test/helpers/sim-worker.ts <dir> <agentId>
 * Env: AGENT_BUS_CHAOS=<ms> widens the in-critical-section race window.
 */
import { FileBus } from '../../src/core/file-bus';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (n: number) => Math.floor(Math.random() * n);

async function run(dir: string, agent: string): Promise<void> {
  const bus = new FileBus({ dir, lock: { timeoutMs: 30_000 } });
  let idleRounds = 0;
  let claimed = 0;

  for (;;) {
    const open = await bus.getTasks({ state: 'open' });
    if (open.length === 0) {
      idleRounds += 1;
      if (idleRounds >= 3) break; // no work left; everything is claimed/done
      await sleep(5 + jitter(10));
      continue;
    }
    idleRounds = 0;

    // Pick a random open task so workers actively collide.
    const task = open[jitter(open.length)]!;
    const res = await bus.claim(task.id, agent);
    if (res.ok) {
      claimed += 1;
      await sleep(jitter(5)); // pretend to work
      await bus.complete(task.id, agent, { by: agent });
      await bus.post({ type: 'status.update', agent, text: `completed ${task.id}`, taskId: task.id });
    }
    // On a lost race (not_open), just loop and try another task.
  }

  // Final heartbeat so the orchestrator can see each worker's tally.
  await bus.post({ type: 'status.update', agent, text: `exiting; claimed=${claimed}` });
}

const [dir, agent] = process.argv.slice(2);
if (!dir || !agent) {
  console.error('usage: sim-worker <dir> <agentId>');
  process.exit(2);
}

run(dir, agent)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
