import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');

export default function setup() {
  // node-pty's prebuilt spawn-helper can be installed without its execute bit,
  // which makes every spawn fail with "posix_spawnp failed".
  const prebuilds = path.join(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const dir of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, dir, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  }
  // The tests run bin/gr.js, which loads dist/, so they exercise what ships.
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', '.'], { cwd: root, stdio: 'inherit' });
}
