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

Nothing opens without it. Every connection keeps its row, but no job can use its token: owners reconnect each channel (Social > Channels > Reconnect), which seals a new token on the same connection. Posts and history keep pointing at the same connections.

## Rotating the key

Rotate when someone who could read the key loses that access, when the key may have leaked, or on your schedule.

1. Generate a new key: `openssl rand -base64 32`.
2. Set `CREDENTIAL_KEY` to the new key and `CREDENTIAL_KEY_PREVIOUS` to the old one, on the API and the worker, and restart both. New tokens are sealed with the new key; tokens sealed before still open with the previous key.
3. Reseal the old envelopes. Today a token is resealed when its channel is reconnected; the provider adapters reseal on every token refresh once they land (Social plan S4, S6). A reseal command for all envelopes is a follow-up; until it exists, keep `CREDENTIAL_KEY_PREVIOUS` set until every connection has been refreshed or reconnected:

   ```sql
   SELECT key_id, count(*) FROM crove_kernel.credential GROUP BY key_id;
   ```

   (run as the database owner; no Crove role can read the table).
4. When no envelope uses the old key id any more, remove `CREDENTIAL_KEY_PREVIOUS` and restart.

A leaked key and a leaked database together expose every token sealed with that key: rotate, then reconnect the channels so the platforms issue new tokens, and revoke the old ones on each platform where it offers that.
