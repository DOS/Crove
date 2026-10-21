# Runbook: the credential key

The credential key seals the tokens of connected channels (Facebook Page, Instagram, Zalo OA and the others; ADR-0025). Each token is encrypted with its own random data key, and the data key is wrapped with the credential key, in `crove_kernel.credential`. Both layers are bound to the org, the provider and the account, so an envelope moved to another row does not open.

## Where the key lives

- **Never in the database.** A dump, a backup, a replica or a point-in-time restore holds only ciphertext. This is the difference from the context key (`context-key-rotation.md`), which is table data.
- `CREDENTIAL_KEY`: 32 bytes as base64 (`openssl rand -base64 32`) or 64 hex characters. Crove Cloud keeps it in its secret manager (later: wrapped with KMS).
- Else `CREDENTIAL_KEY_FILE`: a file holding the key. When the file is missing, the process creates it with a fresh key (mode 0600). `docker compose` uses `/data/keys/credential.key` on the `keys` volume.
- The API seals with it and the worker opens with it, so **both must have the same key**. With api and worker in separate containers, set `CREDENTIAL_KEY` (or share the file) in both; a key file created by each container on its own gives two different keys.
- Each envelope records the id of the key that sealed it (`k1-` and 16 hex characters, derived from the key). The id reveals nothing about the key.

## Back it up

Back up the key apart from database backups: a thief with both has every token. The key file on the `keys` volume is a secret; `docker compose down -v` deletes it.

## Losing the key

When the key file is missing at start, a new key is created and the process logs a warning: if channels were connected before, the file was lost (for example a deleted `keys` volume) and their tokens no longer open.

Nothing opens without it. Every connection keeps its row, but no job can use its token: owners or admins reconnect each channel, which seals a new token on the same connection. Posts and history keep pointing at the same connections.

## Rotating the key

Rotate when someone who could read the key loses that access, when the key may have leaked, or on your schedule.

1. Generate a new key: `openssl rand -base64 32`.
2. Set `CREDENTIAL_KEY` to the new key and `CREDENTIAL_KEY_PREVIOUS` to the old one, on the API and the worker, and restart both. New tokens are sealed with the new key; tokens sealed before still open with the previous key.
3. Wait for the worker to reseal the old envelopes. Every 10 minutes it opens each credential of an active connection still sealed with the previous key and seals it again with the new one (a batch of up to 200 per pass, #776), and does the same for the sealed targets of team chat alerts (the Telegram bot token or Discord webhook an org's Social alerts go to, #863, `crove_social.chat_alert_target`) when the Social module is on. It logs:

   ```text
   [credential-reseal] resealed 12, failed 0; left under an older key: 0 active, 3 to reconnect
   ```

   The counts include team chat alert targets. "Active" counts what the next passes will reseal. "To reconnect" counts credentials of connections that are expired, in error or revoked, or whose connecting member left, and chat alert targets whose saver is no longer an owner or admin: their tokens are not used anyway, and they are sealed with the new key when an owner or admin reconnects the channel or saves the team chat again. A token refresh and a reconnect also seal with the new key. To check by hand (as the database owner; no Crove role can read the tables):

   ```sql
   SELECT key_id, count(*) FROM crove_kernel.credential GROUP BY key_id;
   SELECT key_id, count(*) FROM crove_social.chat_alert_target GROUP BY key_id;
   ```
4. When the log shows 0 active left (and the channels and team chats left to reconnect are ones you are ready to reconnect or save again), remove `CREDENTIAL_KEY_PREVIOUS` and restart. A credential still under the old key after that no longer opens: its channel shows as needing a reconnect. A team chat alert target still under the old key no longer opens either: its alerts stop, and a test line from the Channels page says the chat must be saved again.

Only one previous key is kept: finish one rotation (step 4) before starting the next, or envelopes sealed with the oldest key stop opening.

A leaked key and a leaked database together expose every token sealed with that key: rotate, then reconnect the channels so the platforms issue new tokens, and revoke the old ones on each platform where it offers that.
