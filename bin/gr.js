#!/usr/bin/env node
// Checked before loading dist/: node:sqlite needs no flag only from Node 22.13,
// and older versions fail with a confusing module error instead.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`gr requires Node 22.13 or newer (you have ${process.versions.node})\n`);
  process.exit(1);
}
await import('../dist/cli.js');
