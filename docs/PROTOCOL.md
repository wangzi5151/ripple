# Sync Protocol v1

The server is a blind relay. It stores opaque operation envelopes keyed by `i`, maintains a per-node high-water mark, and forwards accepted operations. It does not apply CRDT operations or resolve conflicts.

## Envelope

Plain operation envelopes contain `i` (id), `n` (node), `q` (per-node sequence), `h` (HLC tuple), `t` (operation type), and operation payload fields. The sequence field is `q`; `s` is reserved for the OR-Set collection name.

Encrypted envelopes keep `i`, `n`, `q`, and `h` visible so the relay can deduplicate and synchronize. They add `z: 1`, a random 96-bit `iv`, and base64url AES-GCM ciphertext `d`. The plaintext payload excludes the four visible fields. AES-GCM authentication covers the ciphertext, not the visible envelope; clients must validate the operation id and reject sequence/id mismatches.

## Messages

- `hello`: protocol version, opaque room id, client id, capabilities, encryption flag, and the client's version vector.
- `welcome`: server id, peers, server version, limits, and an optional opaque snapshot if the client's version is below the room horizon.
- `sync`: the sender's version vector. The receiver returns operations missing from that vector. `reply: true` permits one follow-up request; the final request uses `reply: false`.
- `ops`: a bounded batch of operation envelopes. The relay deduplicates by id and broadcasts accepted operations to other peers in the room.
- `snapshot`: an opaque client-created snapshot. The relay stores it and prunes operations covered by its version vector.
- `presence`: online peer metadata.

## Limits and retention

Messages are limited to 512 KiB, batches to 500 operations, individual operations to 16 KiB, snapshots to 8 MiB, and rooms to 32 simultaneous peers by default. The op log is bounded. When it is pruned, the server advances a per-node horizon. A client behind the horizon needs an opaque snapshot; without one, the room reports that incremental recovery is unavailable.

The current UI does not automatically create or upload snapshots. The Doc snapshot API exists and is tested, but production compaction should be triggered only after at least one durable client snapshot is uploaded. This avoids pruning history before a recoverable state exists.
