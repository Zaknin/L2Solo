'use strict';

// Process-local labels for declared array sources; never serialize the source
// array as its revision. Same-length in-place edits are not a declared revision.
const revisions = new WeakMap();
let next = 1;
function revisionOf(rows) {
    if (!Array.isArray(rows)) return null;
    let entry = revisions.get(rows);
    if (!entry || entry.length !== rows.length) {
        entry = { length: rows.length, revision: next++ };
        revisions.set(rows, entry);
    }
    return entry.revision;
}
module.exports = { revisionOf };
