# Local development folder adapter

The user approved this adapter for human tracker tests on 2026-09-23.
[README.md](../README.md) gives the setup procedure. This adapter does not add
product behavior to later specifications.

## Access contract

The explicit `local-folders` development mode loads `SAMPLES_DIR` and
`SETTINGS_DIR` from `.env.local` on the server. Both folders must exist. Their
canonical locations must be separate. The server uses opaque handle identifiers.
An opaque identifier refers to an entry without a machine path.

The application validates both roots before tracker entry. Folder selection
controls return the configured root for their role. Page reload restores those
roots from the server. The adapter does not persist browser folder references,
audio, or settings values. Restart the server after a configuration change.

The server listens on the loopback interface only. Requests require a session
token, an accepted host, and a matching origin when an origin is supplied. The
server accepts JSON POST requests only. It does not permit cross-origin reads.
Errors omit machine paths. Production pages and the normal development mode have
no local endpoint or session token.

## File contract

Reads use versioned ranges of at most 256 KiB. A stale snapshot fails. Child
names cannot select absolute paths or parent folders. Symbolic links and
directory junctions are rejected. Root identity checks detect replaced
configured folders.

Metadata writes use the existing settings, tags, access probe, and reservation
schemas. The host stages writes and checks the prior file before commit. New WAV
writes validate audio before publication. A conflicting name prevents
publication. New WAV writes are limited to 64 MiB. The host cannot replace or
delete existing audio.

Cancellation discards staged data. Server shutdown releases active writers.
Writers expire after 60 seconds without a successful data write. Expiry removes
staged data and releases the write lock. Abandoned tag reservations use the
recovery procedure in [the tag contract](tag-write-protocol.md). Identity checks
detect ordinary external changes. They do not supply an operating-system lock
against a hostile local process that changes paths at the same time.

## Verification boundary

Host tests use generated temporary folders. HTTP tests check request isolation
and path privacy. Headless Chromium tests run the actual development adapter
with browser folder permissions denied. They check tracker entry, audio decode,
waveforms, persisted tags, and unchanged source audio.

The ordinary browser tests still use the production build. The development test
does not prove the installed editor's audio output, permissions, or performance.
Manual editor use remains the check for those host-specific results.
