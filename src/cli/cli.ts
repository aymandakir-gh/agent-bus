#!/usr/bin/env node
/**
 * agent-bus CLI. Full command surface (init/post/tasks/claim/complete/watch/
 * serve) lands in milestone M3; this entry establishes the binary.
 */
import { PROTOCOL_ID, SPEC_VERSION } from '../index';

function main(argv: string[]): void {
  const [cmd] = argv;
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`agent-bus ${SPEC_VERSION} (${PROTOCOL_ID})\n`);
    return;
  }
  process.stdout.write(
    [
      `agent-bus ${SPEC_VERSION} — multi-agent coordination over a shared folder`,
      '',
      'Usage: agent-bus <command> [options]',
      '',
      'Commands (coming in M3): init, post, tasks, claim, complete, watch, serve',
      '',
      'See PROTOCOL.md for the wire contract.',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2));
