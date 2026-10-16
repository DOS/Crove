// Which modules this deployment runs (CROVE_MODULES, plan Decision 12, ADR-0031), from /api/config. A screen or
// menu item of another module asks for its slot and gets a typed not_installed answer instead of failing.

export type Slot<T> = { status: 'ok'; value: T } | { status: 'not_installed'; module: string };

export function slot<T>(installed: readonly string[], module: string, value: T): Slot<T> {
  return installed.includes(module) ? { status: 'ok', value } : { status: 'not_installed', module };
}

// The items whose module is installed, in order.
export function installedItems<T extends { module: string }>(installed: readonly string[], items: readonly T[]): T[] {
  return items.flatMap((item) => {
    const answer = slot(installed, item.module, item);
    return answer.status === 'ok' ? [answer.value] : [];
  });
}
