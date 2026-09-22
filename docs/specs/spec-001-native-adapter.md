# Spec-001 native folder adapter

Status: Implemented with user approval. Automated checks and local packaging
pass. The native dialog flow still needs manual verification.

## Scope

The extension opens the existing application in its own editor tab. Its Open
command supplies the complete menu and six skins. It does not change another
extension's browser tab or its permissions. The standard browser mode stays
available without the extension.

The extension requires a trusted desktop window. It uses local folders only. The
native picker runs after the user selects a folder control. Cancellation keeps
the previous selection. Both folder requirements still apply before entry.

## Access and storage

The native host gives the application opaque handles. An opaque handle is an
identifier without a machine path. Every operation must refer to a granted
handle. The host rejects path escape, alternate data streams and linked child
folders. It also rejects overlapping sample and settings roots.

The extension saves only folder access references. Each reference contains the
canonical path and file-system identity. Canonical paths identify the actual
folder location. Restoration must match both values. A replaced folder needs new
user selection. The Forget folders command removes these references and ends
active grants. It does not change user files.

Audio stays in the sample folder. Settings stay in the selected settings folder.
The adapter does not store audio, project data or settings values in browser or
extension storage. File reads use versioned ranges of at most 256 KiB. A changed
file invalidates the earlier read snapshot.

This slice permits only two forms of native write: new access manifests and
validated application settings. The host checks the operation and content. It
must reject audio writes, arbitrary file writes and arbitrary deletion. Only
this session's unchanged access manifests can be removed. Failed settings writes
keep the previous valid file.

The host stages metadata in the selected folder and commits it atomically. An
atomic commit changes the complete file in one operation. Identity and version
checks detect ordinary external changes. These checks are not an
operating-system lock against a hostile local process that changes files at the
same time.

## Message contract

Messages use `ravefold-native`, protocol version `1` and a request identifier.
The shared typed contract is in `shared/native-protocol.ts`. The host validates
each operation. The application loads the adapter only in the owned extension
view. Requests cannot choose absolute paths. Only the native picker or a valid
saved reference can create a root grant.

Replies contain opaque handles, file metadata, requested bytes or sanitized
errors. They do not contain machine paths. Malformed replies, timeout and
revocation cause controlled errors. A page reload obtains new live handles from
the saved folder references.

## Verification

Native file tests use real temporary folders and generated data. They compare
audio hashes and test path escape, junctions, replaced roots, stale reads, write
conflicts, cancellation and denied writes. Browser tests use the built
application and compiled extension host with test picker choices. The production
build and extension use the same bundled font. The browser test applies the
editor's default text size and padding. It checks that application rules take
precedence.

The full quality gate runs all browser tests without visible windows. The test
host supplies the editor API boundary. Those tests do not operate the installed
editor's native dialogs. Package checks must exclude private files, source
samples and development assets. Installation must use the checked package.

On 2026-09-22, the full gate passed 107 unit tests and 38 browser tests. One
POSIX-only unit test was skipped on Windows. These checks include the compiled
extension host with real temporary folders. The local package contains 16 files.
Its file list and private-path checks pass. This review did not install the
package in a desktop editor.

A local Node.js 24.19.0 test on Windows listed 1,024 generated files in 333 ms
on the first pass. It did not measure browser or audio workload.
