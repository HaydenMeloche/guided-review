// In-memory conversations for the API providers, kept so a Q&A thread can be resumed. Only
// resumable sessions are stored, and the least recently used are dropped past the cap, since a
// conversation carries every tool output it has seen.

const MAX_SESSIONS = 20;

export class SessionStore<T> {
  private readonly entries = new Map<string, T[]>();

  constructor(private readonly limit = MAX_SESSIONS) {}

  has(id: string | undefined): id is string {
    return id !== undefined && this.entries.has(id);
  }

  // A copy, so a failed turn leaves the stored conversation unchanged.
  get(id: string): T[] | undefined {
    const value = this.entries.get(id);
    if (!value) return undefined;
    this.entries.delete(id);
    this.entries.set(id, value);
    return [...value];
  }

  set(id: string, messages: T[]): void {
    this.entries.delete(id);
    this.entries.set(id, messages);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}
