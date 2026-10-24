import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import { Confirm } from './Confirm.js';
import type { PRInfo, Tour } from '../types.js';
import { deleteBranch, fetchMergeStatus, fetchPR, markReadyForReview, mergePR, updateBranch, type BranchUpdateMethod, type MergeMethod, type MergeStatus } from '../github/gh.js';
import { defaultMergeMessage, defaultMethod, mergeReadiness, METHOD_LABEL, type Readiness } from '../review/merge.js';
import { draftMergeMessage } from '../agent/feedback.js';
import type { AgentContext } from '../agent/types.js';
import { TextInput } from './TextInput.js';
import { Spinner } from './Spinner.js';
import { Hints, KeyBar } from './KeyBar.js';
import { Help } from './Help.js';
import { helpOf } from './keys.js';
import { MERGE_KEYS, mergeBar } from './screenKeys.js';
import { truncate, wrap } from './nav.js';
import { plural } from './plural.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

const LEVEL_COLOR: Record<Readiness['level'], string> = { ready: 'green', warn: 'yellow', blocked: 'red', merged: 'magenta', closed: 'gray' };

// The readiness line other screens show: a mark and the summary.
export function ReadinessLine(props: { readiness?: Readiness; width: number; hint?: boolean }) {
  const r = props.readiness;
  if (!r) return null;
  const mark = r.level === 'ready' ? '✓' : r.level === 'warn' ? '◐' : r.level === 'blocked' ? '✗' : '●';
  const hint = !props.hint ? '' : r.canMerge ? ' · M to merge' : r.canMarkReady ? ' · M to mark it ready for review' : r.canUpdateBranch ? ' · M to update the branch' : '';
  return (
    <Text color={LEVEL_COLOR[r.level]} wrap="truncate">
      {truncate(`${mark} ${safe(r.summary)}`, Math.max(10, props.width - hint.length))}
      <Text dimColor>{hint}</Text>
    </Text>
  );
}

const DRAFTING = 'Drafting the commit message…';

type Mode = 'loading' | 'review' | 'title' | 'body' | 'confirm' | 'merging' | 'ready-confirm' | 'readying' | 'update-confirm' | 'updating' | 'done' | 'error';

// Merge a PR from gr: readiness first, then the method and its commit message. With a model,
// squash and merge-commit messages are drafted from the PR; rebase takes no message. Nothing
// is sent before the confirmation, and the merge names the head it was shown, so a push in the
// meantime makes GitHub refuse it.
export function MergeScreen(props: {
  repo: string;
  number: number;
  tour?: Tour; // the tour, when one is open: its summary helps the message
  agent?: AgentContext;
  width: number;
  height: number;
  onDone: (notice: string) => void;
  onCancel: () => void;
  onQuit?: () => void; // Q
}) {
  const { width } = props;
  const [mode, setMode] = useState<Mode>('loading');
  const [status, setStatus] = useState<MergeStatus>();
  const [pr, setPr] = useState<PRInfo>();
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [drafting, setDrafting] = useState<string>();
  const [drafted, setDrafted] = useState<Partial<Record<MergeMethod, { title: string; message: string }>>>({});
  const [delBranch, setDelBranch] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([fetchMergeStatus(props.repo, props.number), fetchPR(props.repo, props.number)]).then(
      ([s, info]) => {
        if (!live) return;
        setStatus(s);
        setPr(info);
        const m = defaultMethod(s.methods) ?? 'squash';
        setMethod(m);
        const d = defaultMergeMessage(m, { number: s.number, title: s.title, headRef: s.headRef, headOwner: s.headRepo?.split('/')[0], commits: info.commits });
        setTitle(d.title);
        setBody(d.message);
        setMode('review');
      },
      (e: unknown) => {
        if (!live) return;
        setError((e as Error).message);
        setMode('error');
      },
    );
    return () => {
      live = false;
    };
  }, [props.repo, props.number, reload]);

  const markReady = async () => {
    if (!status?.id) return;
    setMode('readying');
    try {
      await markReadyForReview(status.id);
      setNotice('Marked ready for review. Its requested reviewers are notified.');
      setError('');
      setMode('loading');
      setReload((n) => n + 1);
    } catch (e) {
      setError(`Could not mark it ready: ${(e as Error).message}`);
      setMode('review');
    }
  };

  // Updates the branch from its base, then reads the PR again: the head moved, and its checks
  // start over.
  const update = async (how: BranchUpdateMethod) => {
    if (!status?.id) return;
    setMode('updating');
    try {
      await updateBranch(status.id, status.headSha, how);
      setNotice(`${how === 'REBASE' ? 'Rebased' : 'Updated'} ${status.headRef} ${how === 'REBASE' ? 'onto' : 'from'} ${status.baseRef}. Its checks run again on the new head.`);
      setError('');
      setMode('loading');
      setReload((n) => n + 1);
    } catch (e) {
      setError(`Could not update the branch: ${(e as Error).message}`);
      setMode('review');
    }
  };

  const readiness = status && mergeReadiness(status);
  const takesMessage = method !== 'rebase';
  const sameRepoBranch = !!status && status.headRepo?.toLowerCase() === status.repo.toLowerCase();

  const fallback = (m: MergeMethod) =>
    status && pr
      ? defaultMergeMessage(m, { number: status.number, title: status.title, headRef: status.headRef, headOwner: status.headRepo?.split('/')[0], commits: pr.commits })
      : { title: '', message: '' };

  const draft = async (m: MergeMethod) => {
    if (!props.agent || !status || !pr || m === 'rebase') return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setDrafting(DRAFTING);
    try {
      const t = props.tour;
      const r = await draftMergeMessage(
        {
          method: m,
          repo: status.repo,
          number: status.number,
          title: status.title,
          body: pr.body,
          commits: pr.commits,
          intent: t?.mode === 'agent' ? t.intent : undefined,
          chapters: t?.chapters.filter((c) => !c.optional).map((c) => (c.summary ? `${c.title}: ${c.summary}` : c.title)),
          files: t?.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
        },
        props.agent,
        ac.signal,
      );
      if (ac.signal.aborted) return;
      setDrafted((d) => ({ ...d, [m]: r }));
      setTitle(r.title);
      setBody(r.message);
      setEdited(false);
      setDrafting(undefined);
    } catch (e) {
      if (ac.signal.aborted) return;
      setDrafting(`Could not draft a message: ${(e as Error).message}`);
    }
  };

  // The model drafts once the dialog opens on a method that takes a message.
  const started = useRef(false);
  useEffect(() => {
    if (mode !== 'review' || started.current || !readiness?.canMerge) return;
    started.current = true;
    void draft(method);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // The model's draft is on its way: show nothing until it lands, rather than GitHub's default
  // message the draft is about to replace. x stops it and keeps the default.
  const waitingDraft = takesMessage && !edited && !drafted[method] && (drafting === DRAFTING || (!!props.agent && !!readiness?.canMerge && mode === 'review' && !started.current));
  const skipDraft = () => {
    abort.current?.abort();
    setDrafting('the model’s draft was skipped: GitHub’s default');
  };

  const switchMethod = () => {
    if (!status || status.methods.length < 2) return;
    const next = status.methods[(status.methods.indexOf(method) + 1) % status.methods.length];
    setMethod(next);
    if (edited) return;
    const d = drafted[next] ?? fallback(next);
    setTitle(d.title);
    setBody(d.message);
    if (!drafted[next] && next !== 'rebase' && props.agent) void draft(next);
  };

  const merge = async () => {
    if (!status) return;
    setMode('merging');
    try {
      const r = await mergePR(status.repo, status.number, { method, headSha: status.headSha, ...(takesMessage ? { title: title.trim(), message: body } : {}) });
      let branch = '';
      if (delBranch && status.headRepo) {
        branch = await deleteBranch(status.headRepo, status.headRef).then(
          () => ` · deleted ${status.headRef}`,
          (e: unknown) => ` · could not delete ${status.headRef}: ${(e as Error).message}`,
        );
      }
      props.onDone(`Merged ${status.repo}#${status.number} (${METHOD_LABEL[method].toLowerCase()}) as ${r.sha.slice(0, 8)}${branch}`);
    } catch (e) {
      setError(`Merge failed: ${(e as Error).message}`);
      setMode('review');
    }
  };

  useInput(
    (input, key) => {
      if (mode === 'confirm') {
        if (input === 'y' || key.return) return void merge();
        return setMode('review');
      }
      if (mode === 'ready-confirm') {
        if (input === 'y' || key.return) return void markReady();
        return setMode('review');
      }
      if (mode === 'update-confirm') {
        if (input === 'y' || key.return) return void update('MERGE');
        if (input === 'r') return void update('REBASE');
        return setMode('review');
      }
      if (mode === 'error' || mode === 'loading') {
        if (input === 'Q') return props.onQuit?.();
        if (key.escape || input === 'q') props.onCancel();
        return;
      }
      if (key.escape || input === 'q') {
        abort.current?.abort();
        return props.onCancel();
      }
      if (input === 'Q') return props.onQuit?.();
      if (input === '?' || input === 'h') return setHelp(true);
      if (input === 'r' && readiness?.canMarkReady) return setMode('ready-confirm');
      if (input === 'u' && readiness?.canUpdateBranch) return setMode('update-confirm');
      if (!readiness?.canMerge) return;
      if (input === 'm') return switchMethod();
      if (input === 'e' && takesMessage) return setMode('title');
      if (input === 'b' && takesMessage) return setMode('body');
      if (input === 'g' && takesMessage && props.agent) return void draft(method);
      if (input === 'd' && sameRepoBranch && !status.deleteBranchOnMerge) return setDelBranch((d) => !d);
      if (waitingDraft) {
        if (input === 'x') skipDraft();
        return;
      }
      if (input === 'P' || key.return) {
        if (takesMessage && !title.trim()) return setError('The commit title is empty.');
        setError('');
        return setMode('confirm');
      }
    },
    { isActive: !help && mode !== 'title' && mode !== 'body' && mode !== 'merging' && mode !== 'readying' },
  );
  useInput((_i, key) => key.escape && setMode('review'), { isActive: mode === 'title' || mode === 'body' });

  const head = (
    <Text bold wrap="truncate">
      Merge · <Text color="cyan">{safe(props.repo)}</Text> #{props.number} {status ? truncate(safe(status.title), width - 24) : ''}
    </Text>
  );
  if (help) return <Help title="merge" sections={helpOf(MERGE_KEYS)} width={width} height={props.height} onClose={() => setHelp(false)} />;
  if (mode === 'loading') {
    return (
      <Box flexDirection="column" paddingX={1}>
        {head}
        <Text dimColor>
          <Spinner /> Checking whether it can merge…
        </Text>
      </Box>
    );
  }
  if (mode === 'error' || !status || !readiness) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {head}
        <Text color="red">{safe(error || 'Could not read the PR.')}</Text>
        <Hints keys={[['esc', 'back']]} />
      </Box>
    );
  }
  const bodyRows = Math.max(3, props.height - 14 - readiness.blockers.length - readiness.warnings.length);
  const bodyLines = wrap(safe(body), width - 4);
  return (
    <Box flexDirection="column" paddingX={1} width={width} height={props.height}>
      {head}
      <Text dimColor wrap="truncate">
        {safe(`${status.headRef} → ${status.baseRef} · ${plural(status.commitCount, 'commit')} · head ${status.headSha.slice(0, 8)}`)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <ReadinessLine
          readiness={{ ...readiness, summary: readiness.level === 'blocked' ? 'Not ready to merge' : readiness.level === 'warn' ? 'Can merge, with warnings' : readiness.summary }}
          width={width - 2}
        />
        {readiness.blockers.map((b, i) => (
          <Text key={`b${i}`} color="red" wrap="truncate">
            {'  '}✗ {safe(b)}
            {readiness.canMarkReady && b.startsWith('draft') ? <Text color="cyan"> · r marks it ready</Text> : null}
            {readiness.canUpdateBranch && b.startsWith('behind') ? <Text color="cyan"> · u updates it</Text> : null}
          </Text>
        ))}
        {readiness.warnings.map((w, i) => (
          <Text key={`w${i}`} color="yellow" wrap="truncate">
            {'  '}◐ {safe(w)}
          </Text>
        ))}
        {!status.viewerCanMerge && readiness.level !== 'merged' && readiness.level !== 'closed' ? (
          <Text dimColor>You don’t have write access to {safe(status.repo)}, so you can’t merge it.</Text>
        ) : null}
      </Box>
      {readiness.canMerge ? (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Method:{' '}
              {status.methods.map((m) => (
                <Text key={m} inverse={m === method} color="cyan">
                  {` ${METHOD_LABEL[m]} `}
                </Text>
              ))}
              {status.methods.length > 1 ? <Text dimColor> (m)</Text> : null}
            </Text>
            {sameRepoBranch && !status.deleteBranchOnMerge ? (
              <Text>
                {delBranch ? '[x]' : '[ ]'} Delete {safe(status.headRef)} after merging <Text dimColor>(d)</Text>
              </Text>
            ) : null}
          </Box>
          {takesMessage ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>
                Commit message{' '}
                <Text dimColor>
                  {drafting && drafting !== DRAFTING
                    ? `· ${safe(drafting)}`
                    : drafting
                      ? ''
                      : drafted[method]
                        ? '· drafted by the model, not verified'
                        : props.agent
                          ? ''
                          : '· GitHub’s default (no model configured)'}
                </Text>
              </Text>
              {/* On its own line, where the message will appear, like the app's other spinners. */}
              {drafting === DRAFTING ? (
                <Text>
                  <Spinner color="magenta" />
                  <Text color="magenta"> {DRAFTING}</Text>
                </Text>
              ) : null}
              {waitingDraft ? null : mode === 'title' ? (
                <TextInput
                  value={title}
                  onChange={(v) => {
                    setTitle(v);
                    setEdited(true);
                  }}
                  onSubmit={() => setMode('review')}
                  width={width - 4}
                  maxRows={1}
                />
              ) : (
                <Text wrap="truncate">{safe(title) || <Text dimColor>(no title)</Text>}</Text>
              )}
              {waitingDraft ? null : mode === 'body' ? (
                <TextInput
                  value={body}
                  onChange={(v) => {
                    setBody(v);
                    setEdited(true);
                  }}
                  onSubmit={() => setMode('review')}
                  width={width - 4}
                  maxRows={bodyRows}
                />
              ) : (
                <Box flexDirection="column" height={Math.min(bodyRows, Math.max(1, bodyLines.length))} overflow="hidden">
                  {bodyLines.slice(0, bodyRows).map((l, i) => (
                    <Text key={i} dimColor>
                      {l || ' '}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>
                Rebase and merge replays the {plural(status.commitCount, 'commit')} onto {safe(status.baseRef)} as they are; GitHub takes no commit message for it.
              </Text>
            </Box>
          )}
        </>
      ) : null}
      <Box flexGrow={1} />
      {error ? <Text color="red">{safe(error)}</Text> : notice ? <Text color="green">{safe(notice)}</Text> : null}
      {mode === 'ready-confirm' ? (
        <Confirm yes="mark ready">
          Mark {safe(props.repo)}#{props.number} ready for review? This notifies its requested reviewers.
        </Confirm>
      ) : mode === 'update-confirm' ? (
        // A question, then a choice a line, wrapping rather than cut off: branch names run long.
        <Box flexDirection="column">
          <Text color="yellow" bold>
            Update {safe(status.headRef)} from {safe(status.baseRef)}?
          </Text>
          {(
            [
              ['Enter', `merge ${status.baseRef} into it`, ''],
              ['r', `rebase it onto ${status.baseRef}`, 'Rewrites the branch: anyone with it checked out, you included, has to reset to the new head before pushing again.'],
              ['n', 'cancel', ''],
            ] as const
          ).map(([k, what, note]) => (
            <Box key={k}>
              <Box width={8} flexShrink={0}>
                <Text color="yellow" bold>{`  ${k}`}</Text>
              </Box>
              <Text>
                {safe(what)}
                {note ? <Text dimColor>{`. ${note}`}</Text> : null}
              </Text>
            </Box>
          ))}
        </Box>
      ) : mode === 'updating' ? (
        <Text color="yellow">
          <Spinner color="yellow" /> Updating the branch…
        </Text>
      ) : mode === 'readying' ? (
        <Text color="yellow">
          <Spinner color="yellow" /> Marking it ready for review…
        </Text>
      ) : mode === 'confirm' ? (
        <Confirm yes="merge">
          {METHOD_LABEL[method]} {safe(props.repo)}#{props.number} into {safe(status.baseRef)}
          {delBranch && status.headRepo ? `, then delete ${safe(status.headRef)}` : ''}?
        </Confirm>
      ) : mode === 'merging' ? (
        <Text color="yellow">
          <Spinner color="yellow" /> Merging…
        </Text>
      ) : mode === 'title' || mode === 'body' ? (
        <Text dimColor>Enter: done · Shift+Enter: newline · Esc: done</Text>
      ) : (
        <KeyBar
          width={width - 2}
          keys={mergeBar({
            canMerge: readiness.canMerge,
            waitingDraft: !!waitingDraft,
            methods: status.methods.length > 1,
            message: takesMessage,
            agent: !!props.agent,
            canMarkReady: !!readiness.canMarkReady,
            canUpdate: !!readiness.canUpdateBranch,
            base: status.baseRef,
          })}
          end={[
            ['esc', 'back'],
            ['?', 'keys'],
          ]}
        />
      )}
    </Box>
  );
}
