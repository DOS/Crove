// Archiving posts and bringing them back (#1299): the rules the post page and the bulk bar show before asking the
// server, which decides with the same ones (social.post.archive). An archived post leaves every list and comes back
// unchanged.

// Who may archive or restore a post: owners and admins any, members the posts they wrote.
export function mayArchive(role: { canDecide: boolean; canWrite: boolean; userId: string | null }, post: { authorUserId: string | null }): boolean {
  return role.canDecide || (role.canWrite && post.authorUserId !== null && post.authorUserId === role.userId);
}

// Going out, or waiting for a person: the post stays until that is settled.
const IN_FLIGHT = ['publishing', 'processing', 'ambiguous', 'needs_attention'];
// Waiting for its time: unscheduled first.
const WAITING = ['scheduled', 'paused'];

export type ArchiveBlock = 'in_flight' | 'scheduled' | 'editing' | 'removing';

interface ArchiveVariant {
  status: string;
  // A raised approval count took it off its schedule, keeping its time to go back on it (#408).
  error?: { code: string | null; action: string | null } | null;
  liveEdit?: { state: string } | null;
  removal?: { state: string } | null;
}

// Why the post cannot be archived now, as the server refuses it; null when it can. A takedown on its way (#860) is the
// one the post page knows of (a person's ask not answered yet); a planned one, and an open copy of an evergreen or
// recurring post, are left for the server to say.
export function archiveBlock(variants: readonly ArchiveVariant[]): ArchiveBlock | null {
  if (variants.some((v) => IN_FLIGHT.includes(v.status))) return 'in_flight';
  if (variants.some((v) => WAITING.includes(v.status) || (v.error?.code === 'POLICY_RAISED' && v.error.action === 'reschedule'))) return 'scheduled';
  if (variants.some((v) => v.status === 'published' && v.liveEdit?.state === 'pending')) return 'editing';
  if (variants.some((v) => v.status === 'published' && v.removal?.state === 'pending')) return 'removing';
  return null;
}
