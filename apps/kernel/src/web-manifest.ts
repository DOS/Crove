// The PWA install manifest under the deployment's brand (BRAND_NAME, #1691): the installed app is named after the
// product the deployment configured, not the default. The app's own manifest (apps/app/public/assets/) stays the
// source of every other field; only name and short_name are replaced.
export const WEB_MANIFEST_PATH = '/assets/manifest.webmanifest';

export function brandedManifest(source: string, brand: string): string {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  return `${JSON.stringify({ ...manifest, name: brand, short_name: brand }, null, 2)}\n`;
}
