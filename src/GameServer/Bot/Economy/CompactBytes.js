'use strict';
// The primitives of the bounded saved proofs (the quantity read list, the
// restart prefix): unsigned LEB128 integers, exact Numbers and UTF-8 text,
// each with one canonical byte form. A read throws on truncation or a
// non-canonical primitive; each owner's codec catches it and refuses the
// whole value. An owner's layout may still read more than one byte form as
// the same content (WishNetwork accepts root text splits its pack never
// writes): nothing compares saved bytes, only the decoded values.

// An exact Number: tag 0 and an unsigned integer, or tag 1 and the raw
// double (-0, negative, fraction, above 2^53); tag 2 is a permitted null.
const exactUint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function writer() {
    const bytes = [];
    const uint = value => {
        if (!Number.isSafeInteger(value) || value < 0) throw Error('compact integer');
        do { const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit + (value ? 128 : 0)); } while (value);
    };
    const double = value => { const encoded = Buffer.allocUnsafe(8); encoded.writeDoubleLE(value); bytes.push(...encoded); };
    return {
        uint, double,
        // Any safe integer: the sign and six magnitude bits, then the rest.
        signed(value) {
            if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw Error('compact signed');
            const magnitude = Math.abs(value), rest = Math.floor(magnitude / 64);
            bytes.push((magnitude % 64) * 2 + (value < 0 ? 1 : 0) + (rest ? 128 : 0));
            if (rest) uint(rest);
        },
        byte(value) { bytes.push(value); },
        raw(value) { bytes.push(...value); },
        number(value, nullable = false) {
            if (value === null && nullable) bytes.push(2);
            else if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('compact number');
            else if (exactUint(value)) { bytes.push(0); uint(value); }
            else { bytes.push(1); double(value); }
        },
        text(value) {
            if (typeof value !== 'string') throw Error('compact text');
            const encoded = Buffer.from(value, 'utf8');
            if (encoded.toString('utf8') !== value) throw Error('compact text');
            uint(encoded.length); bytes.push(...encoded);
        },
        // Each item writes at least one byte, so a read bounds its count.
        list(values, write) { if (!Array.isArray(values)) throw Error('compact list'); uint(values.length); values.forEach(write); },
        finish: () => Uint8Array.from(bytes)
    };
}

function reader(value) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let at = 0;
    const byte = () => { if (at >= bytes.length) throw Error('compact truncation'); return bytes[at++]; };
    const raw = size => {
        if (size > bytes.length - at) throw Error('compact truncation');
        const result = bytes.subarray(at, at + size); at += size; return result;
    };
    const uint = () => {
        let result = 0, factor = 1, count = 0, digit;
        do {
            digit = byte(); count++; result += (digit % 128) * factor;
            if (!Number.isSafeInteger(result) || count > 8) throw Error('compact integer');
            factor *= 128;
        } while (digit >= 128);
        if (count > 1 && digit === 0) throw Error('compact overlong');
        return result;
    };
    const double = () => raw(8).readDoubleLE(0);
    return {
        byte, raw, uint, double,
        signed() {
            const digit = byte();
            let magnitude = Math.floor((digit % 128) / 2);
            if (digit >= 128) {
                const rest = uint();
                if (!rest) throw Error('compact overlong');
                magnitude += rest * 64;
                if (!Number.isSafeInteger(magnitude)) throw Error('compact signed');
            }
            if (digit % 2 && !magnitude) throw Error('compact signed');
            return digit % 2 ? -magnitude : magnitude;
        },
        number(nullable = false) {
            const tag = byte();
            if (tag === 0) return uint();
            if (tag === 2 && nullable) return null;
            const result = tag === 1 ? double() : NaN;
            if (!Number.isFinite(result) || exactUint(result)) throw Error('compact number');
            return result;
        },
        text() {
            const encoded = raw(uint()), result = encoded.toString('utf8');
            if (!Buffer.from(result, 'utf8').equals(encoded)) throw Error('compact text');
            return result;
        },
        list(read) {
            const count = uint();
            if (count > bytes.length - at) throw Error('compact list');
            return Array.from({ length: count }, read);
        },
        rest: () => raw(bytes.length - at),
        done: () => at === bytes.length
    };
}

// Bytes that cross a JSON-measured wire as text: the canonical base64 of
// at most maxBytes bytes, else null.
function fromBase64(text, maxBytes) {
    if (typeof text !== 'string' || text.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
    const bytes = Buffer.from(text, 'base64');
    return bytes.toString('base64') === text && bytes.byteLength <= maxBytes ? Uint8Array.from(bytes) : null;
}
module.exports = { writer, reader, fromBase64 };
