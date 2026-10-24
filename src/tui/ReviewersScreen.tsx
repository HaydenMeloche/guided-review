import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected } from './themed.js';
import { fetchOrgTeams, fetchPendingReviewers, fetchReviews, getMentionUsers, removeReviewRequests, requestReviewers, type PendingReviewers } from '../github/gh.js';
import { reviewerStatus, type ReviewerStatus } from '../review/feedback.js';
import { parseReviewers } from '../review/reviewers.js';
import type { Completer } from './completion.js';
import { TextInput } from './TextInput.js';
import { Spinner } from './Spinner.js';
import { Hints, KeyBar } from './KeyBar.js';
import { VERDICT } from './author/FeedbackBriefing.js';
import { age } from './PickerScreen.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

type Row = { kind: 'user'; login: string } | { kind: 'team'; slug: string } | { kind: 'reviewed'; status: ReviewerStatus };

interface Loaded {
  pending: PendingReviewers;
  reviewed: ReviewerStatus[];
}

// Who is asked to review a PR and who has: a asks more people or teams (with @ completion
// from the repository's collaborators), x withdraws a request nobody has answered, r asks a
// reviewer again. Each change goes to GitHub at once, and GitHub notifies whoever is asked.
export function ReviewersScreen(props: { repo: string; number: number; width: number; height: number; onClose: (changed: boolean) => void; onQuit?: () => void }) {
  const { repo, number, width, height } = props;
  const selectedRow = useSelected();
  const [loaded, setLoaded] = useState<Loaded>();
  const [loadError, setLoadError] = useState('');
  const [sel, setSel] = useState(0);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [changed, setChanged] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [orgTeams, setOrgTeams] = useState<string[]>([]);

  const read = useCallback(() => {
    Promise.all([fetchPendingReviewers(repo, number), fetchReviews(repo, number)]).then(
      ([pending, reviews]) => {
        setLoaded({ pending, reviewed: reviewerStatus(reviews, pending.author) });
        setLoadError('');
      },
      (e: unknown) => setLoadError((e as Error).message),
    );
  }, [repo, number]);
  useEffect(read, [read]);
  // Collaborators for completion. Listing them needs push access, so a fork's author may get
  // none and types names instead.
  useEffect(() => {
    let live = true;
    getMentionUsers(repo).then(
      (users) => void (live && setPeople(users)),
      () => undefined,
    );
    fetchOrgTeams(repo).then(
      (teams) => void (live && setOrgTeams(teams)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [repo]);

  const rows = useMemo<Row[]>(() => {
    if (!loaded) return [];
    const asked = new Set(loaded.pending.users.map((u) => u.toLowerCase()));
    return [
      ...loaded.pending.users.map((login): Row => ({ kind: 'user', login })),
      ...loaded.pending.teams.map((slug): Row => ({ kind: 'team', slug })),
      ...loaded.reviewed.filter((r) => !asked.has(r.login.toLowerCase())).map((status): Row => ({ kind: 'reviewed', status })),
    ];
  }, [loaded]);
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, rows.length - 1))), [rows.length]);
  const current = rows[sel] as Row | undefined;

  const owner = repo.split('/')[0];
  // Names after an @, or bare once a letter is typed: a list that opened after every space
  // would take the Enter meant to send. Teams list with the people (`@co` finds @org/core), and
  // alone once `org/` is typed.
  const completers = useMemo<Completer[]>(() => {
    const author = loaded?.pending.author.toLowerCase();
    const asked = new Set(loaded?.pending.users.map((u) => u.toLowerCase()));
    const askedTeams = new Set(loaded?.pending.teams.map((t) => t.toLowerCase()));
    const names = [...new Set([...(loaded?.reviewed.map((r) => r.login) ?? []), ...people])].filter((n) => n.toLowerCase() !== author && !asked.has(n.toLowerCase()) && n !== 'ghost');
    const teams = orgTeams.filter((t) => !askedTeams.has(t.toLowerCase()));
    const teamItems = (query: string) =>
      teams
        .filter((t) => t.toLowerCase().startsWith(query.toLowerCase()) || (query.length > 1 && `${owner}/${t}`.toLowerCase().startsWith(query.toLowerCase())))
        .map((t) => ({ key: `team:${t}`, label: `@${owner}/${t}`, detail: 'team', insert: `@${owner}/${t} ` }));
    const items = (query: string) => [
      ...names
        .filter((n) => n.toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, 50)
        .map((n) => ({ key: n, label: `@${n}`, insert: `@${n} ` })),
      ...teamItems(query).slice(0, 20),
    ];
    const hint = `tab insert · ↑↓ choose · esc close${teams.length ? '' : ` · @${owner}/team asks a team`}`;
    const org = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      { trigger: new RegExp(`(^|[\\s,])@?${org}/([\\w.-]*)$`, 'i'), items: (q: string) => teamItems(q).slice(0, 50), hint },
      { trigger: /(^|[\s,])@([\w-]*)$/, items, hint },
      { trigger: /(^|[\s,])([\w-]+)$/, items, hint },
    ];
  }, [loaded, people, orgTeams, owner]);

  const change = (what: string, run: () => Promise<void>, done: string, onDone?: () => void) => {
    setBusy(what);
    setError('');
    setNotice('');
    run()
      .then(
        () => {
          setChanged(true);
          setNotice(done);
          onDone?.();
          read();
        },
        (e: unknown) => setError((e as Error).message),
      )
      .finally(() => setBusy(undefined));
  };
  const named = (users: string[], teams: string[]) => [...users.map((u) => `@${u}`), ...teams.map((t) => `@${owner}/${t}`)].join(', ');

  const ask = () => {
    if (!loaded) return;
    const parsed = parseReviewers(text, repo, loaded.pending.author);
    if (parsed.error) return setError(parsed.error);
    if (!parsed.users.length && !parsed.teams.length) return setAdding(false);
    // The names stay in the field until GitHub takes them, so a refusal can be corrected.
    change(
      'Asking for reviews…',
      () => requestReviewers(repo, number, parsed.users, parsed.teams),
      `Asked ${named(parsed.users, parsed.teams)} to review.`,
      () => {
        setAdding(false);
        setText('');
      },
    );
  };

  useInput(
    (input, key) => {
      // A request in flight finishes first: closing now would lose its answer, and the picker
      // would not know to read the list again.
      if (key.escape || input === 'q') return busy ? undefined : props.onClose(changed);
      if (input === 'Q') return busy ? undefined : props.onQuit?.();
      if (busy || !loaded) return;
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(rows.length - 1, s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (input === 'a' || key.return) {
        setError('');
        return setAdding(true);
      }
      if (input === 'x' && current?.kind === 'user')
        return change('Withdrawing the request…', () => removeReviewRequests(repo, number, [current.login]), `@${current.login} is no longer asked to review.`);
      if (input === 'x' && current?.kind === 'team')
        return change('Withdrawing the request…', () => removeReviewRequests(repo, number, [], [current.slug]), `@${owner}/${current.slug} is no longer asked to review.`);
      if (input === 'r' && current?.kind === 'reviewed') {
        const { login } = current.status;
        return change('Asking for a review…', () => requestReviewers(repo, number, [login]), `Asked @${login} to review again.`);
      }
    },
    { isActive: !adding },
  );
  useInput(
    (_input, key) => {
      if (key.escape && !completing && !busy) {
        setError('');
        setAdding(false);
      }
    },
    { isActive: adding },
  );

  const title = <Text bold>{`Reviewers of ${safe(repo)}#${number}`}</Text>;
  if (!loaded)
    return (
      <Box flexDirection="column" paddingX={1}>
        {title}
        {loadError ? (
          <Text color="red">Couldn't read the PR's reviewers: {safe(loadError)}</Text>
        ) : (
          <Text>
            <Spinner /> Reading the reviewers…
          </Text>
        )}
        <Hints keys={[['esc', 'close']]} />
      </Box>
    );

  const line = (r: Row, i: number) => {
    const on = !adding && i === sel;
    if (r.kind === 'reviewed') {
      const v = VERDICT[r.status.verdict] ?? VERDICT.COMMENTED;
      return (
        <Text key={`r:${r.status.login}`} wrap="truncate" {...selectedRow(on)}>
          <Text color={v.color}>{`${v.mark} `}</Text>
          {safe(`@${r.status.login}`)} <Text color={v.color}>{v.text}</Text>
          <Text dimColor>{` · ${age(r.status.at)}`}</Text>
        </Text>
      );
    }
    const name = r.kind === 'user' ? `@${r.login}` : `@${owner}/${r.slug}`;
    return (
      <Text key={`${r.kind}:${name}`} wrap="truncate" {...selectedRow(on)}>
        <Text color="yellow">● </Text>
        {safe(name)} <Text color="yellow">waiting</Text>
      </Text>
    );
  };
  const pendingCount = loaded.pending.users.length + loaded.pending.teams.length;
  const listH = Math.max(1, height - (adding ? 9 : 6));
  const top = Math.max(0, Math.min(sel - listH + 1, rows.length - listH));

  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height}>
      {title}
      <Text dimColor>{pendingCount ? `${pendingCount} asked and not answered yet` : 'Nobody is waiting to review'}</Text>
      <Box flexDirection="column" marginTop={1} height={listH} overflow="hidden">
        {rows.length ? rows.slice(top, top + listH).map((r, i) => line(r, top + i)) : <Text dimColor>Nobody has been asked to review, and nobody has. a asks someone.</Text>}
      </Box>
      <Box flexGrow={1} />
      {adding ? (
        <Box flexDirection="column">
          <Text>Ask to review:</Text>
          <TextInput value={text} onChange={setText} onSubmit={ask} width={width - 4} maxRows={2} completers={completers} onCompleting={setCompleting} placeholder={`@alice @${owner}/team`} />
        </Box>
      ) : null}
      {busy ? (
        <Text color="yellow">
          <Spinner color="yellow" /> {busy}
        </Text>
      ) : error ? (
        <Text color="red">{safe(error)}</Text>
      ) : notice ? (
        <Text color="green">{safe(notice)}</Text>
      ) : null}
      <KeyBar
        width={width - 2}
        keys={
          adding
            ? [
                ['enter', 'ask'],
                ['esc', 'back'],
              ]
            : [
                ['a', 'ask someone'],
                ...((current?.kind === 'user' || current?.kind === 'team' ? [['x', 'withdraw']] : []) as [string, string][]),
                ...((current?.kind === 'reviewed' ? [['r', 'ask again']] : []) as [string, string][]),
                ['j/k', 'select'],
                ['esc', 'close'],
              ]
        }
      />
    </Box>
  );
}
