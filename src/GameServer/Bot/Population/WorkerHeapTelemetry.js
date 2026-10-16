'use strict';
const { PerformanceObserver, constants } = require('node:perf_hooks');
const v8 = require('node:v8');
const MB = 1024 * 1024;
const MAX_SAMPLES = 128;
const WINDOW_MS = 10 * 60 * 1000;
class MajorGcHeap {
    constructor() { this.last = 0; this.maxima = []; this.head = 0; this.dropped = 0; this.incompleteUntil = 0; }
    prune(at) {
        while (this.head < this.maxima.length && this.maxima[this.head][0] <= at - WINDOW_MS) this.head++;
        if (this.head > 128 && this.head * 2 >= this.maxima.length) {
            this.maxima = this.maxima.slice(this.head); this.head = 0;
        }
    }
    record(heap, at = performance.now()) {
        this.prune(at); this.last = Number(heap) || 0;
        while (this.maxima.length > this.head && this.maxima.at(-1)[1] <= this.last) this.maxima.pop();
        if (this.maxima.length - this.head >= MAX_SAMPLES) {
            this.incompleteUntil = Math.max(this.incompleteUntil, this.maxima[this.head][0] + WINDOW_MS);
            this.head++; this.dropped++;
        }
        this.maxima.push([at, this.last]);
    }
    snapshot(at = performance.now()) {
        this.prune(at);
        return { heapAfterGc: this.last, heapAfterGcMax10: at < this.incompleteUntil ? null : this.maxima[this.head]?.[1] || 0,
            ...(this.dropped ? { heapGcDropped: this.dropped } : {}) };
    }
}
// The heap of the calling isolate in MB: V8 heap used and reserved, the
// external memory V8 counts (Buffers, ArrayBuffers) and the isolate's own
// heap cap (heap_size_limit; a worker without resourceLimits shows the default). Every thread sends this
// one shape on a message it already sends; PopulationStatus.heaps() merges them. `used` is read at an arbitrary
// moment and includes uncollected garbage; afterGc (heap used after the last major GC) and afterGcMax (its maximum over
// the WINDOW_MS window) are the live data. Both come from this isolate's observe() window and are present only
// while it runs (null: no major GC in the window yet).
const megabytes = bytes => bytes > 0 ? Math.round(bytes / MB) : null;
function heapRecord(at) {
    const stats = v8.getHeapStatistics();
    const record = { used: Math.round(stats.used_heap_size / MB), total: Math.round(stats.total_heap_size / MB),
        external: Math.round(stats.external_memory / MB), limit: Math.round(stats.heap_size_limit / MB) };
    if (active) {
        const gc = active.window.snapshot(at);
        record.afterGc = megabytes(gc.heapAfterGc);
        record.afterGcMax = megabytes(gc.heapAfterGcMax10);
    }
    return record;
}
// heaps=<thread>:<used>/<total>/<external>/<limit>/<afterGc>/<afterGcMax>,... in MB; '-' for a thread that has not
// reported yet and for an afterGc/afterGcMax without a major GC. clan is as of its last plan, history its last
// minute tick, market its last answer.
function heapsLine(heaps) {
    return Object.entries(heaps).map(([name, heap]) => `${name}:${heap
        ? `${heap.used}/${heap.total}/${heap.external}/${heap.limit}/${heap.afterGc ?? '-'}/${heap.afterGcMax ?? '-'}` : '-'}`).join(',');
}
// The major-GC observer of this isolate; every thread that reports v8Heap starts it once when developer
// diagnostics are on, and heapRecord() reads its window.
let active = null;
function observe() {
    if (active) return active;
    const window = new MajorGcHeap();
    const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
            if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) window.record(process.memoryUsage().heapUsed);
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    const handle = { window, snapshot: at => ({ ...window.snapshot(at), v8Heap: heapRecord(at) }),
        close: () => { observer.disconnect(); if (active === handle) active = null; } };
    return (active = handle);
}
module.exports = { MAX_SAMPLES, WINDOW_MS, MajorGcHeap, observe, heapRecord, heapsLine };
