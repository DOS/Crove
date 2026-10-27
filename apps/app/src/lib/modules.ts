// Which modules this deployment runs (CROVE_MODULES, plan Decision 12, ADR-0031), from /api/config. A screen or
// menu item of another module asks for its slot and gets a typed not_installed answer instead of failing.
import { MODULE_SCREENS, type ModuleScreens } from '@crove/kernel-contract';

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

// Every screen under /o/$slug with its module, from the manifests (#1652). A path segment `$name` matches any one
// segment; a screen with fewer of them comes first, so 'social/new' wins over 'social/$id'.
const SCREENS = (Object.entries(MODULE_SCREENS) as Array<[string, ModuleScreens]>)
  .flatMap(([module, screens]) => screens.routes.map((route) => ({ module, segments: route.path.split('/') })))
  .sort((a, b) => a.segments.filter((s) => s.startsWith('$')).length - b.segments.filter((s) => s.startsWith('$')).length);

// A path segment as the router compares it: decoded, and in lower case, since its routes match without regard to
// case (/o/acme/JOURNAL opens the journal). Declared paths are lower case (manifest-screens.test.ts).
function segmentOf(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

// The module of the screen at a path (/o/<slug>/<screen>...), or null for a path no manifest declares (the org's
// index, a path outside an org).
export function moduleOfPath(pathname: string): string | null {
  const [, o, slug, ...rest] = pathname.replace(/\/+$/, '').split('/');
  if (segmentOf(o ?? '') !== 'o' || !slug || rest.length === 0) return null;
  const segments = rest.map(segmentOf);
  const found = SCREENS.find((s) => s.segments.length === segments.length && s.segments.every((seg, i) => seg.startsWith('$') || seg === segments[i]));
  return found?.module ?? null;
}

// Whether the screen at a path may open: its module is installed, or it belongs to the kernel or to no module. A
// screen of a module the deployment leaves out redirects to the inbox (ADR-0031 §3), whichever module it is.
export function screenInstalled(installed: readonly string[], pathname: string): boolean {
  const module = moduleOfPath(pathname);
  return module === null || module === 'kernel' || installed.includes(module);
}
