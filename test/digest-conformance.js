'use strict';

// The menu bar app's Rust server only honours a decision whose request digest
// matches the hook's, which lib/permission.js computes. A mismatch would fail safe
// (no card; the prompt stays in the terminal) but would quietly break approvals, so
// check the two agree on awkward inputs. Needs the app built:
//   cargo build --release --manifest-path src-tauri/Cargo.toml

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requestDigest } = require('../lib/permission');

const BIN = path.resolve(__dirname, '..', process.env.ZOO_SERVE_BIN || 'src-tauri/target/release/zoo');

// Special characters are written as escapes so none of them hide in the source.
const CASES = [
  ['Bash', { command: 'ls -la', description: 'List files' }],
  ['Bash', { command: 'echo "quotes" \\ backslash\n\ttab\r\u0000\u001f\u007f\u0008\u000c', dangerouslyDisableSandbox: true }],
  ['Write', { file_path: '/tmp/\u00fcn\u00efc\u00f6d\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00.txt', content: 'zwj \ud83d\udc69\u200d\ud83d\udc67 and \u2028 \u2029 separators, bom \ufeff' }],
  ['Edit', { z: 1, a: 2, B: 3, _: 4, 10: 5, 9: 6, '\ufb01': 7, '\ud83d\ude00': 8, '': 9 }],
  ['MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, [], {}, [[1, [2, [3]]]]] }],
  ['Numbers', { n: [0, -0, 1, -1, 0.1, 1e21, 1e20, 1.5e-7, 1e-7, 0.000001, 123456789012345680000, 2 ** 53 + 2, 5e-324, 1.7976931348623157e308, 3.14159, -2.5e25, 0.1 + 0.2] }],
  ['Numbers', '{"big": 9007199254740993, "huge": 123456789012345678901234567890, "exp": 1E3, "neg": -0.0, "tiny": 1e-400}'],
  ['Mixed', { t: true, f: false, nul: null, nested: { deep: { deeper: { s: '' } } } }],
  [null, null],
  ['NoInput', undefined],
  ['mcp__server__tool', 'a bare string input'],
];

test('the Rust digest matches lib/permission.js on awkward inputs', { skip: !fs.existsSync(BIN) && `${BIN} not built` }, () => {
  for (const [toolName, raw] of CASES) {
    // A string case is raw JSON, for numbers JS can't write as literals.
    const toolInput = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw;
    // Through JSON first: the hook writes the request to disk and the app reads it back.
    const onDisk = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
    const back = JSON.parse(onDisk);
    const expected = requestDigest(back.tool_name, back.tool_input);
    const got = execFileSync(BIN, ['--digest'], { input: onDisk }).toString().trim();
    assert.equal(got, expected, onDisk);
  }
});
