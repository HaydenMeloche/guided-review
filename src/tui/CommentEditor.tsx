import { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommentLabel, Draft, Hunk } from '../types.js';
import { TextInput } from './TextInput.js';
import { openInEditor } from '../util/editor.js';
import { sanitizeTerminal } from '../util/sanitize.js';

const LABELS: CommentLabel[] = ['blocking', 'question', 'suggestion', 'nit'];
export const LABEL_COLOR: Record<CommentLabel, string> = { blocking: 'red', question: 'magenta', suggestion: 'cyan', nit: 'gray' };

// Draft editor: Tab cycles the label; Ctrl+G edits a code suggestion in $EDITOR.
export function CommentEditor(props: {
  draft: Draft;
  target: string; // human description of the anchor
  hunk?: Hunk;
  selectedText?: string; // the anchored lines, prefilled into a suggestion
  width: number;
  mentions?: string[];
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const { suspendTerminal } = useApp();
  const [label, setLabel] = useState<CommentLabel>(props.draft.label);
  const [body, setBody] = useState(props.draft.body);
  const [suggestion, setSuggestion] = useState(props.draft.suggestion);
  const [msg, setMsg] = useState('');
  const canSuggest = props.draft.anchor.type === 'line' || props.draft.anchor.type === 'range';

  const editSuggestion = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
    try {
      const file = path.join(dir, 'suggestion' + path.extname(props.hunk?.file ?? '.txt'));
      fs.writeFileSync(file, suggestion ?? props.selectedText ?? '');
      await suspendTerminal(() => openInEditor(file));
      const text = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
      setSuggestion(text);
      setMsg('Suggestion updated.');
    } catch (e) {
      setMsg(`Suggestion not changed: ${(e as Error).message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.ctrl && input === 'g' && canSuggest) return void editSuggestion();
    if (key.ctrl && input === 'd' && suggestion !== undefined) {
      setSuggestion(undefined);
      setMsg('Suggestion removed.');
    }
  });

  const save = () => {
    if (!body.trim() && !suggestion) return setMsg('Empty comment: Esc to cancel.');
    props.onSave({ ...props.draft, label, body: body.trim(), suggestion });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width}>
      <Text>
        <Text bold>Comment</Text> <Text dimColor>on {props.target}</Text>
      </Text>
      <Text>
        {LABELS.map((l) => (
          <Text key={l} color={LABEL_COLOR[l]} inverse={l === label}>
            {` ${l} `}
          </Text>
        ))}
        <Text dimColor> (tab)</Text>
      </Text>
      <Box marginTop={1}>
        <TextInput
          value={body}
          onChange={setBody}
          onSubmit={save}
          width={props.width - 4}
          placeholder="Type a review note…"
          maxRows={8}
          mentions={props.mentions}
          onTab={(reverse) => setLabel((l) => LABELS[(LABELS.indexOf(l) + (reverse ? LABELS.length - 1 : 1)) % LABELS.length])}
        />
      </Box>
      {suggestion !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>suggestion (posted as a GitHub suggestion block):</Text>
          {suggestion
            .split('\n')
            .slice(0, 8)
            .map((l, i) => (
              <Text key={i} color="green">
                {'+ ' + sanitizeTerminal(l)}
              </Text>
            ))}
        </Box>
      ) : null}
      <Text dimColor>
        {msg || `enter: save draft · shift+enter: newline${canSuggest ? ' · ctrl+g: code suggestion in $EDITOR' : ''}${suggestion !== undefined ? ' · ctrl+d: drop suggestion' : ''} · esc: cancel`}
      </Text>
    </Box>
  );
}
