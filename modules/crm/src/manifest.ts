// The crm module's manifest (plan §5.2, #1588, #1599): the tables it owns and the class of every column. A migration
// that adds or drops a table or column of these schemas changes this list in the same PR; apps/kernel/test/manifest.db.test.ts
// checks it against the catalog. A column is internal unless the second argument of columns() classifies it.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const crmManifest = defineModule({
  id: 'crm',
  dependsOn: ['kernel'],
  tables: {
    crove_crm: {
      booking: columns(['org_id', 'id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'refusal', 'calendar_event_id', 'party_id', 'time_zone', 'request_token_sha256', 'created_at', 'decided_at', 'revision', 'manage_request_id', 'manage_action', 'manage_starts_at', 'manage_requested_at', 'manage_outcome', 'cancelled_at', 'hold_event_ids'], { visitor_name: 'pii', email: 'contact', phone: 'contact', note: 'pii' }),
      booking_feed: columns(['org_id', 'id', 'user_id', 'token_sha256', 'created_at', 'revoked_at']),
      event_type: columns(['org_id', 'id', 'slug', 'title', 'description', 'duration_min', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'horizon_days', 'daily_limit', 'location_kind', 'location_value', 'host_user_id', 'active', 'created_by', 'created_at', 'updated_by', 'updated_at', 'assignment', 'co_host_user_ids']),
    },
  },
  // It owns no permission: no command of the module declares one and no role grants one.
  permissions: [],
  // Its entities (#1656), each with its table: every type its commands name as their audit target, the records the
  // kernel numbers, and the records other code names by type; apps/kernel/test/manifest.db.test.ts checks them.
  entities: [
    { type: 'crm.booking', table: 'booking', legalEntityScoped: false, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.crm,
});
