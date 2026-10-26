// The crm module's manifest (plan §5.2, #1588): the tables it owns. A migration that adds or drops a table of these
// schemas changes this list in the same PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog.
import { defineModule } from '@crove/kernel-contract';

export const crmManifest = defineModule({
  id: 'crm',
  tables: {
    crove_crm: [
      'booking',
      'booking_feed',
      'event_type',
    ],
  },
});
