// What the reviewers popup's "ask" field holds: people as `alice` or `@alice`, and teams as
// `@org/team` in the repository owner's organization, apart by spaces or commas.
export interface ParsedReviewers {
  users: string[];
  teams: string[]; // slugs
  error?: string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const SLUG = /^[A-Za-z0-9_.-]+$/;

export function parseReviewers(text: string, repo: string, author: string): ParsedReviewers {
  const owner = repo.split('/')[0].toLowerCase();
  const users: string[] = [];
  const teams: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const name = raw.replace(/^@/, '');
    const slash = name.indexOf('/');
    if (slash >= 0) {
      const org = name.slice(0, slash);
      const slug = name.slice(slash + 1);
      if (!SLUG.test(slug)) return { users, teams, error: `${raw} is not a team name.` };
      if (org.toLowerCase() !== owner) return { users, teams, error: `${raw} is not a team in ${owner}: only its teams can be asked to review.` };
      if (!teams.some((t) => t.toLowerCase() === slug.toLowerCase())) teams.push(slug);
      continue;
    }
    if (!LOGIN.test(name)) return { users, teams, error: `${raw} is not a GitHub username.` };
    if (name.toLowerCase() === author.toLowerCase()) return { users, teams, error: `@${name} wrote the PR, and GitHub doesn't let an author review their own PR.` };
    if (!users.some((u) => u.toLowerCase() === name.toLowerCase())) users.push(name);
  }
  return { users, teams };
}
