const fs = require('fs');
const path = require('path');
const { isMainThread } = require('worker_threads');

const INDEX_LENGTH = 256 * 256;
const INDEX_BYTES = INDEX_LENGTH * Int32Array.BYTES_PER_ELEMENT;
const INDEX_READY = 1;
const RAW_READY = 2;
const align = value => Math.ceil(value / 4) * 4;

function validateDescriptor(descriptor) {
    if (descriptor?.version !== 1 || typeof descriptor.directory !== 'string'
        || !(descriptor.arena instanceof SharedArrayBuffer) || !Array.isArray(descriptor.regions)) {
        throw new Error('Invalid shared geodata descriptor');
    }
    let offset = descriptor.regions.length * Int32Array.BYTES_PER_ELEMENT;
    const keys = new Set();
    const regions = descriptor.regions.map((region, readyIndex) => {
        if (!region || !/^\d+_\d+$/.test(region.key) || keys.has(region.key)
            || !Number.isSafeInteger(region.byteLength) || region.byteLength < 0
            || region.readyIndex !== readyIndex || region.indexOffset !== offset
            || region.dataOffset !== offset + INDEX_BYTES) {
            throw new Error('Invalid shared geodata region descriptor');
        }
        keys.add(region.key);
        offset = align(region.dataOffset + region.byteLength);
        if (!Number.isSafeInteger(offset) || offset > descriptor.arena.byteLength) {
            throw new Error('Shared geodata region exceeds arena');
        }
        return Object.freeze({ ...region });
    });
    if (offset !== descriptor.arena.byteLength) throw new Error('Invalid shared geodata arena size');
    return Object.freeze({ version: 1, directory: descriptor.directory, arena: descriptor.arena,
        regions: Object.freeze(regions) });
}

class SharedGeodata {
    constructor(descriptor) {
        this.descriptor = validateDescriptor(descriptor);
        this.ready = new Int32Array(descriptor.arena, 0, descriptor.regions.length);
        this.regions = new Map(this.descriptor.regions.map(region => [region.key, region]));
        this.heightFileReads = 0;
    }

    readInto(region, buffer, position = 0) {
        const fd = fs.openSync(path.join(this.descriptor.directory, `${region.key}.l2j`), 'r');
        try {
            // Full reads verify the catalog size; block reads rely on immutable files.
            if (buffer.length === region.byteLength && fs.fstatSync(fd).size !== region.byteLength) {
                throw new Error(`Geodata region ${region.key} changed size; restart required`);
            }
            let offset = 0;
            while (offset < buffer.length) {
                const read = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
                if (read === 0) throw new Error(`Unexpected end of geodata region ${region.key}`);
                offset += read;
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    load(key, buildOffsetIndex, cachedIndex) {
        const region = this.regions.get(key);
        if (!region) return null;
        const buffer = Buffer.from(this.descriptor.arena, region.dataOffset, region.byteLength);
        const index = cachedIndex || new Int32Array(this.descriptor.arena, region.indexOffset, INDEX_LENGTH);
        if (!(Atomics.load(this.ready, region.readyIndex) & RAW_READY)) {
            // Raw files are immutable until restart. Concurrent loaders write the same
            // bytes and offsets; a terminated loader publishes nothing and needs no lock.
            this.readInto(region, buffer);
            if (!(Atomics.load(this.ready, region.readyIndex) & INDEX_READY)) {
                buildOffsetIndex(buffer, index);
            }
            Atomics.or(this.ready, region.readyIndex, INDEX_READY | RAW_READY);
        }
        return { buffer, index };
    }

    loadHeightBlock(key, blockId, buildOffsetIndex, cachedIndex) {
        const region = this.regions.get(key);
        if (!region) return null;
        const index = cachedIndex || new Int32Array(this.descriptor.arena, region.indexOffset, INDEX_LENGTH);
        if (!(Atomics.load(this.ready, region.readyIndex) & INDEX_READY)) {
            // Build offsets without touching the reserved raw span; only the index stays.
            const temporary = Buffer.allocUnsafe(region.byteLength);
            this.readInto(region, temporary);
            buildOffsetIndex(temporary, index);
            Atomics.or(this.ready, region.readyIndex, INDEX_READY);
        }
        const blockOffset = index[blockId];
        if (Atomics.load(this.ready, region.readyIndex) & RAW_READY) {
            return { ...this.load(key, buildOffsetIndex, index), blockOffset, raw: true };
        }
        const nextOffset = blockId + 1 < index.length ? index[blockId + 1] : region.byteLength;
        // Partial fixtures leave later offsets at zero; the existing decoder still
        // reads their indexed block from the remaining file bytes.
        const endOffset = nextOffset > blockOffset ? nextOffset : region.byteLength;
        const buffer = Buffer.allocUnsafe(Math.max(0, endOffset - blockOffset));
        if (buffer.length) {
            this.readInto(region, buffer, blockOffset);
            this.heightFileReads++;
        }
        return { buffer, index, blockOffset: 0, raw: false };
    }

    stats() {
        let loadedBytes = 0;
        let loadedRegions = 0;
        let rawRegions = 0;
        let indexOnlyRegions = 0;
        for (const region of this.descriptor.regions) {
            const ready = Atomics.load(this.ready, region.readyIndex);
            if (!(ready & INDEX_READY)) continue;
            loadedBytes += INDEX_BYTES;
            loadedRegions++;
            if (ready & RAW_READY) {
                loadedBytes += region.byteLength;
                rawRegions++;
            } else {
                indexOnlyRegions++;
            }
        }
        return { reservedBytes: this.descriptor.arena.byteLength, loadedBytes, loadedRegions,
            rawRegions, indexOnlyRegions, heightFileReads: this.heightFileReads };
    }
}

function create(directory) {
    if (!isMainThread) throw new Error('Shared geodata arena must be created on the main thread');
    let files;
    try {
        files = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        files = [];
    }
    const catalog = files.filter(file => (file.isFile() || file.isSymbolicLink()) && /^\d+_\d+\.l2j$/.test(file.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    const sizes = [];
    for (const file of catalog) {
        try {
            sizes.push({ key: file.name.slice(0, -4), byteLength: fs.statSync(path.join(directory, file.name)).size });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    let offset = sizes.length * Int32Array.BYTES_PER_ELEMENT;
    const regions = sizes.map(({ key, byteLength }, readyIndex) => {
        const region = { key, byteLength, indexOffset: offset,
            dataOffset: offset + INDEX_BYTES, readyIndex };
        offset = align(region.dataOffset + byteLength);
        return region;
    });
    // Reserve address space only; region pages are touched by their first loader.
    return new SharedGeodata({ version: 1, directory, arena: new SharedArrayBuffer(offset), regions });
}

module.exports = { create, attach: descriptor => new SharedGeodata(descriptor) };
