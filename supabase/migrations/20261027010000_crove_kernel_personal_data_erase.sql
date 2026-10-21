-- Crove kernel (issue #923, PDPL): erasing a person's data on request. kernel.personal_data.erase clears the
-- recipient address of the mails Crove sent them (packages/kernel/src/personal-data.ts). mail_message_guard already
-- allows to_address to be dropped and never changed; this lets the tenant role run that one update. The keyed hash
-- (to_hash) stays, so a bounce or unsubscribe still suppresses the address.
GRANT UPDATE (to_address) ON crove_kernel.mail_message TO crove_tenant;
