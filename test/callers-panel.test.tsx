import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { CallersPanel } from '../src/tui/chapter/CallersPanel.js';
import { waitFor } from './helpers/waitFor.js';

describe('CallersPanel', () => {
  it('lists the uses and shows the source around the chosen one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-callers-'));
    fs.writeFileSync(path.join(root, 'a.ts'), 'const one = 1;\nparse(one);\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'const two = 2;\nconst three = 3;\nparse(two, three);\n');
    const onClose = vi.fn();
    const ui = render(
      <CallersPanel
        items={[
          {
            symbol: 'parse',
            hunkId: 'h1',
            change: 'signature',
            callers: [
              { file: 'a.ts', line: 2, text: 'parse(one);' },
              { file: 'b.ts', line: 3, text: 'parse(two, three);' },
            ],
          },
        ]}
        root={root}
        width={90}
        height={20}
        onClose={onClose}
      />,
    );
    expect(ui.lastFrame()).toContain('Uses of parse (signature changed)');
    expect(ui.lastFrame()).toMatch(/parse\s+a\.ts:2\s+parse\(one\);/);
    expect(ui.lastFrame()).toContain('const one = 1;');
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('const three = 3;'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    ui.unmount();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
