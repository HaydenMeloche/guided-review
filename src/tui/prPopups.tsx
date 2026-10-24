import type { ReactNode } from 'react';
import type { CheckItem } from '../github/gh.js';
import type { Tour } from '../types.js';
import type { AgentContext } from '../agent/types.js';
import { ReviewPopup } from './ReviewPopup.js';
import { MergeScreen } from './MergeScreen.js';
import { ChecksLoader, ChecksScreen } from './ChecksScreen.js';
import { ReviewersScreen } from './ReviewersScreen.js';

// The merge, checks and reviewers popups, over whichever screen opened them: the picker, a review
// briefing, or the feedback screens. One place for their size and wiring.

export function MergePopup(props: {
  background: ReactNode;
  width: number;
  height: number;
  repo: string;
  number: number;
  tour?: Tour; // gives the model drafting the merge message the PR's text
  agent?: AgentContext;
  onCancel: () => void;
  onDone: (notice: string) => void;
  onQuit?: () => void;
}) {
  return (
    <ReviewPopup background={props.background} width={props.width} height={props.height} maxWidth={100} maxHeight={32}>
      {(w, h) => (
        <MergeScreen repo={props.repo} number={props.number} tour={props.tour} agent={props.agent} width={w} height={h} onCancel={props.onCancel} onDone={props.onDone} onQuit={props.onQuit} />
      )}
    </ReviewPopup>
  );
}

// With `checks`, the caller already holds them (and keeps them fresh); without, the popup reads
// the PR's checks itself.
export function ChecksPopup(props: {
  background: ReactNode;
  width: number;
  height: number;
  repo: string;
  number: number;
  loaded?: { headSha: string; checks: CheckItem[]; refreshing: boolean; onRefresh: () => void };
  onClose: () => void;
  onQuit?: () => void;
}) {
  const { loaded } = props;
  return (
    <ReviewPopup background={props.background} width={props.width} height={props.height} maxWidth={140} maxHeight={Math.max(20, props.height - 2)}>
      {(w, h) =>
        loaded ? (
          <ChecksScreen
            repo={props.repo}
            headSha={loaded.headSha}
            checks={loaded.checks}
            refreshing={loaded.refreshing}
            width={w}
            height={h}
            onRefresh={loaded.onRefresh}
            onClose={props.onClose}
            onQuit={props.onQuit}
          />
        ) : (
          <ChecksLoader repo={props.repo} number={props.number} width={w} height={h} onClose={props.onClose} onQuit={props.onQuit} />
        )
      }
    </ReviewPopup>
  );
}

export function ReviewersPopup(props: { background: ReactNode; width: number; height: number; repo: string; number: number; onClose: (changed: boolean) => void; onQuit?: () => void }) {
  return (
    <ReviewPopup background={props.background} width={props.width} height={props.height} maxWidth={90} maxHeight={26}>
      {(w, h) => <ReviewersScreen repo={props.repo} number={props.number} width={w} height={h} onClose={props.onClose} onQuit={props.onQuit} />}
    </ReviewPopup>
  );
}
