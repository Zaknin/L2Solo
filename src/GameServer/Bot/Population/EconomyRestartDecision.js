'use strict';

// The existing stats update carries one bounded decision, never its graph.
// The economy owner validates the saved proof.
const { deflateRawSync, inflateRawSync } = require('node:zlib');
const Bytes = require('../Economy/CompactBytes');
// The saved field's JSON bytes: room for ~97% of the offline plans packed
// (2026-10-21 costgate states: p50 955, p90 1487, p95 1835); a larger plan
// saves null and rebuilds after a restart.
const MAX_BYTES = 2048, MAX_PLAIN_BYTES = 16384;
// 6: the packed metadata row (no JSON, no character id: the bot's own row
// holds it, the restoring state names it) and an 8-byte baseline key; the
// restart prefix inside is format 9. An older card is refused before
// inflate: one rebuild per bot.
const VERSION = 6;
// The saved baseline key: the first 8 bytes of the baseline's identity
// (DecisionSections.baselineIdentity, a sha256). It only tells the saved
// baseline from another one of the same bot; 64 bits do that.
const IDENTITY_BYTES = 8;
const identityKey = identity => typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity)
    ? Buffer.from(identity.slice(0, IDENTITY_BYTES * 2), 'hex') : null;

function cardData(value, maxBytes) {
    const bytes = Bytes.fromBase64(value, maxBytes);
    return bytes && bytes.byteLength >= 28 ? bytes.buffer : null;
}

// Plain layout: the baseline key, then decisionSeq, activityLeaf, focus
// (null or text), activity and mp, the card's length and bytes, and the
// restart prefix to the end.
function encode(accepted, baselineIdentity) {
    const key = identityKey(baselineIdentity);
    if (!(accepted?.eventProof instanceof Uint8Array) || !(accepted.card?.data instanceof ArrayBuffer) || !key
        || !accepted.eventProof.length || accepted.eventProof.length > MAX_PLAIN_BYTES) return null;
    try {
        const write = Bytes.writer();
        write.raw(key); write.uint(accepted.decisionSeq); write.uint(accepted.activityLeaf);
        if (accepted.focus === null) write.byte(0);
        else { write.byte(1); write.text(accepted.focus); }
        write.text(accepted.activity); write.number(accepted.mp);
        write.uint(accepted.card.data.byteLength); write.raw(new Uint8Array(accepted.card.data));
        write.raw(accepted.eventProof);
        const plain = write.finish();
        if (plain.length > MAX_PLAIN_BYTES) return null;
        const value = [VERSION, deflateRawSync(plain, { level: 6 }).toString('base64')];
        return Buffer.byteLength(JSON.stringify({ wishAdvisory: value })) <= MAX_BYTES ? value : null;
    } catch (_) { return null; }
}

function decode(value, timestamp, maxCardBytes, characterId, baseline, baselineIdentity) {
    const key = identityKey(baselineIdentity);
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== VERSION || !key
        || !Number.isSafeInteger(characterId) || characterId <= 0) return null;
    try {
        if (Buffer.byteLength(JSON.stringify({ wishAdvisory: value })) > MAX_BYTES) return null;
        const compressed = Bytes.fromBase64(value[1], MAX_BYTES);
        if (!compressed) return null;
        const plain = inflateRawSync(compressed, { maxOutputLength: MAX_PLAIN_BYTES });
        const read = Bytes.reader(plain);
        if (!key.equals(read.raw(IDENTITY_BYTES))) return null;
        const decisionSeq = read.uint(), activityLeaf = read.uint();
        const marked = read.byte();
        const focus = marked === 0 ? null : marked === 1 ? read.text() : undefined;
        const activity = read.text(), mp = read.number(), cardSize = read.uint();
        if (focus === undefined || focus !== null && focus.length > 128 || activityLeaf > 0xffffffff
            || cardSize < 28 || cardSize > maxCardBytes) return null;
        const data = Uint8Array.from(read.raw(cardSize)).buffer, eventProof = Uint8Array.from(read.rest());
        const at = baseline?.at;
        if (!eventProof.length || !Number.isFinite(at) || !Number.isFinite(timestamp) || timestamp < at) return null;
        return { data, decisionSeq, activityLeaf, focus, baseline, activity, mp, eventProof, characterId, saved: value };
    } catch (_) { return null; }
}

module.exports = { encode, decode, cardData, MAX_BYTES };
