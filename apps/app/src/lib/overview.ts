// What waits for the user in one org (issue #1249), in the order the overview lists it: what blocks the books first
// (proposals to approve, files that could not be read), then what is addressed to the user, then statement lines to
// match. A count of 0 is not listed; a figure not read yet (undefined) is not listed either, so the list never
// claims "nothing waits" for something it has not counted.

export type WaitingKey = 'proposals' | 'socialReviews' | 'failedFiles' | 'notifications' | 'tasks' | 'bankLines';

export interface WaitingCounts {
  proposals?: number | undefined;
  socialReviews?: number | undefined;
  failedFiles?: number | undefined;
  notifications?: number | undefined;
  tasks?: number | undefined;
  bankLines?: number | undefined;
}

const ORDER: readonly WaitingKey[] = ['proposals', 'socialReviews', 'failedFiles', 'notifications', 'tasks', 'bankLines'];

export function waitingItems(counts: WaitingCounts): { key: WaitingKey; count: number }[] {
  return ORDER.flatMap((key) => {
    const count = counts[key];
    return count !== undefined && count > 0 ? [{ key, count }] : [];
  });
}

// Whether every figure the screen asks for has been read: only then may it say that nothing waits.
export function allCounted(counts: WaitingCounts, asked: readonly WaitingKey[]): boolean {
  return asked.every((key) => counts[key] !== undefined);
}
