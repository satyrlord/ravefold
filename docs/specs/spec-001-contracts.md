# Spec-001 file contracts

## Project format

A `.ravefold.json` file contains one JSON object. Recovery files use the same
object and extension. Schema version 1 accepts only the fields below. Unknown
fields cause validation to fail. Project files contain no audio data.

A schema gives the rules for fields and values in a data format.

| Field                         | Value                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `schemaVersion`               | `1`                                                      |
| `id`, `name`                  | Stable project identifier and name shown.                |
| `revision`                    | Nonnegative integer revision.                            |
| `bpm`, `key`                  | `180` and `"C minor"`.                                   |
| `beatsPerBar`, `ticksPerBeat` | `4` and `960`.                                           |
| `masterGain`                  | Linear gain from 0 to 4.                                 |
| `loop`                        | `null`, or `startTick` and `endTick`. End follows start. |
| `tracks`                      | Track objects. Each object has a unique ID and order.    |
| `clips`                       | Clip objects. Each object has a unique ID.               |

A track contains `id`, `order`, `name`, `gain`, `pan`, `mute` and `solo`. Gain
is a linear value from 0 to 4. Pan ranges from -1 to 1. Mute and solo are
Boolean values. Order is a nonnegative integer.

Linear gain multiplies an audio signal's amplitude. A Boolean value is true or
false.

A clip contains `id`, `trackId`, `samplePath`, `startTick`, `durationTicks`,
`sourceOffsetFrames`, `repeat`, `fadeInTicks` and `fadeOutTicks`. Its track must
exist. Repeat is a Boolean value. Other position and duration fields are
nonnegative safe integers. Clip duration is positive. The two fades must fit in
the clip duration.

A safe integer is in the range that JavaScript stores without loss of integer
precision.

Sample paths use forward slashes and are relative to the selected sample folder.
Only `.wav` paths are valid. Absolute paths, parent segments and empty segments
are invalid. Path resolution does not decode URL escapes. Missing files keep
their paths and clip positions.

Identifiers contain ASCII letters, numbers, underscores or hyphens. They start
with a letter or number and contain a maximum of 64 characters. Names contain a
maximum of 200 characters. Control characters are invalid. Sample paths contain
a maximum of 4,096 characters, with a maximum of 255 characters in each segment.

ASCII is a character encoding for basic Latin letters, digits, and symbols. A
path segment is the text between two path separators. A URL escape encodes a
character as a percent sign and hexadecimal digits.

Read limits are 16 MiB, 1,024 tracks and 100,000 clips. These limits protect the
reader. They do not specify supported playback capacity. New projects contain
eight empty tracks. Project opening does not start playback.

## Settings format

The `ravefold-settings.json` file contains this JSON structure:

```json
{
  "schemaVersion": 1,
  "appearance": {
    "skin": "reference-2",
    "mode": "system",
    "effects": "full"
  }
}
```

Skin values range from `reference-1` through `reference-6`. The `mode` field
accepts `system`, `light` or `dark`. The `effects` field accepts `full`,
`reduced` or `static`. Unknown fields are invalid. The read limit is 16 KiB.

The default uses Reference 2 and system mode. Effects default to Full, or Static
when the system requests reduced motion. User selections in the current session
replace saved values for the changed fields only.

## Entry result

The entry result contains the mode, project, two folder references, appearance
and missing sample references. Mode is `new`, `open` or `recover`. Each missing
reference keeps its clip ID, track ID, sample path, start and duration. The
result stays in memory. It contains no audio. The menu validates permissions for
the two folders before it transfers this result.
