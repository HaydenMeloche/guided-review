import { useEffect, useMemo, useState } from 'react';
import type { Tour } from '../../types.js';

// The people a comment or reply can @mention: the author, reviewers, commenters, and collaborators.
// The pipeline fills tour.mentionUsers only if the collaborator list arrived in time; fetch it
// (memoized in gh.ts) the first time an editor that offers @mentions opens (`wanted`).
export function useMentions(tour: Tour, wanted: boolean, load: (() => Promise<string[]>) | undefined): string[] {
  const [lateMentions, setLateMentions] = useState<string[]>();
  useEffect(() => {
    if (!wanted || !load || tour.mentionUsers !== undefined || lateMentions !== undefined) return;
    let live = true;
    load().then(
      (users) => void (live && setLateMentions(users)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted, load, tour.mentionUsers, lateMentions]);
  const mentionUsers = tour.mentionUsers ?? lateMentions;
  return useMemo(
    () =>
      [...new Set([tour.author, ...(tour.existingReviews ?? []).map((r) => r.author), ...tour.existingThreads.flatMap((t) => t.comments.map((c) => c.author)), ...(mentionUsers ?? [])])].filter(
        (name) => name !== 'ghost',
      ),
    [tour.author, tour.existingReviews, tour.existingThreads, mentionUsers],
  );
}
