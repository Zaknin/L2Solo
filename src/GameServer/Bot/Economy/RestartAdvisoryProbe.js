'use strict';

// Size evidence only. Process-local fence tokens are not restart-safe proof.
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const { isDeepStrictEqual } = require('node:util');
const Diagnostics = require('./EconomyDiagnostics');
const ATTEMPTS = 32, SAVED_BYTES = 1024;
let attempted = 0;

function selected(owner) {
    return attempted < ATTEMPTS && Diagnostics.active() && Diagnostics.enabled(owner);
}

// The caller supplies the fence owner's public decoder after selecting an
// already validated advisory. No graph is built to collect this observation.
function observe(accepted, decodeFence) {
    if (attempted >= ATTEMPTS || !Diagnostics.active()) return;
    attempted++;
    try {
        const { card, fence, ...metadata } = accepted;
        const fields = decodeFence(fence);
        if (!fields || !(card?.data instanceof ArrayBuffer)) throw new TypeError('invalid_advisory_probe');
        const bytes = Buffer.from(card.data);
        // The card's complete binary data also holds its time, flags and
        // valuation; its key and the accepted metadata remain exact too.
        const tuple = [card.key, bytes.toString('base64'), metadata, fields];
        const plain = Buffer.from(JSON.stringify(tuple));
        const encoded = deflateRawSync(plain, { level: 6 });
        const decoded = JSON.parse(inflateRawSync(encoded, { maxOutputLength: plain.byteLength }).toString());
        if (decoded[0] !== card.key || !Buffer.from(decoded[1], 'base64').equals(bytes)
            || !isDeepStrictEqual(decoded[2], metadata) || !isDeepStrictEqual(decoded[3], fields)) {
            Diagnostics.count('card', 'restart_probe', 'roundtrip_error');
            return;
        }
        // Count the whole versioned persisted field, including JSON/base64.
        // The bytes are then discarded; this path never restores a decision.
        const size = Buffer.byteLength(JSON.stringify({ wishAdvisory: [1, encoded.toString('base64')] }));
        Diagnostics.count('card', 'restart_probe', size <= SAVED_BYTES ? 'fits' : 'oversize');
    } catch (_) {
        Diagnostics.count('card', 'restart_probe', 'error');
    }
}

module.exports = { selected, observe };
