// The tables of every module manifest, as the server gives them to its runtime (RuntimeOptions.manifests, #1710,
// #1772): every runtime the kernel's tests build gets them, so declared writes are checked as in production.
import { kernelManifest } from '@crove/kernel';
import type { ManifestTables } from '@crove/kernel-runtime';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { notesManifest } from '@crove/mod-notes';
import { socialManifest } from '@crove/mod-social';

export const TEST_MANIFESTS: readonly ManifestTables[] = [kernelManifest, financeManifest, socialManifest, crmManifest, notesManifest].map((m) => m.tables);
