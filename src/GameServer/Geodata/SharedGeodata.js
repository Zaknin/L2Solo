const fs = require('fs');
const path = require('path');
const { isMainThread } = require('worker_threads');

const INDEX_LENGTH = 256 * 256;
const INDEX_BYTES = INDEX_LENGTH * Int32Array.BYTES_PER_ELEMENT;
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
    }

    load(key, buildOffsetIndex) {
        const region = this.regions.get(key);
        if (!region) return null;
        const buffer = Buffer.from(this.descriptor.arena, region.dataOffset, region.byteLength);
        const index = new Int32Array(this.descriptor.arena, region.indexOffset, INDEX_LENGTH);
        if (Atomics.load(this.ready, region.readyIndex) !== 1) {
            // Raw files are immutable until restart. Concurrent loaders write the same
            // bytes and offsets; a terminated loader publishes nothing and needs no lock.
            const fd = fs.openSync(path.join(this.descriptor.directory, `${key}.l2j`), 'r');
            try {
                if (fs.fstatSync(fd).size !== region.byteLength) {
                    throw new Error(`Geodata region ${key} changed size; restart required`);
                }
                let offset = 0;
                while (offset < buffer.length) {
                    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
                    if (read === 0) throw new Error(`Unexpected end of geodata region ${key}`);
                    offset += read;
                }
            } finally {
                fs.closeSync(fd);
            }
            buildOffsetIndex(buffer, index);
            Atomics.store(this.ready, region.readyIndex, 1);
        }
        return { buffer, index };
    }

    stats() {
        let loadedBytes = 0;
        let loadedRegions = 0;
        for (const region of this.descriptor.regions) {
            if (Atomics.load(this.ready, region.readyIndex) !== 1) continue;
            loadedBytes += region.byteLength + INDEX_BYTES;
            loadedRegions++;
        }
        return { reservedBytes: this.descriptor.arena.byteLength, loadedBytes, loadedRegions };
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
