'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (!process.argv.includes('--gc-child')) {
    const result = spawnSync(process.execPath, [...process.execArgv, '--expose-gc', __filename, '--gc-child'],
        { env: { ...process.env, L2NODE_CONFIG_FILE: 'config/default.ini', L2NODE_SHARED_CONFIG_FILE: '' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    process.stdout.write(result.stdout);
} else {
    const { Worker } = require('node:worker_threads');
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const Telemetry = require('../src/GameServer/Bot/Population/WorkerHeapTelemetry');
    const window = new Telemetry.MajorGcHeap();
    window.record(300, 0); window.record(100, 1000); window.record(200, 2000);
    assert.deepEqual(window.snapshot(5000), { heapAfterGc: 200, heapAfterGcMax10: 300 });
    assert.deepEqual(window.snapshot(Telemetry.WINDOW_MS + 1), { heapAfterGc: 200, heapAfterGcMax10: 200 });
    // No record left in the window: afterGc goes to 0 together with afterGcMax.
    assert.deepEqual(window.snapshot(Telemetry.WINDOW_MS + 2001), { heapAfterGc: 0, heapAfterGcMax10: 0 });
    // heapRecord() has no after-GC fields until this isolate's observer runs, then carries the window in MB.
    assert.deepEqual(Object.keys(Telemetry.heapRecord()), ['used', 'total', 'external', 'limit']);
    const observed = Telemetry.observe();
    assert.equal(Telemetry.observe(), observed, 'one observer per isolate');
    assert.deepEqual([Telemetry.heapRecord().afterGc, Telemetry.heapRecord().afterGcMax], [null, null]);
    observed.window.record(300 * 1024 * 1024); observed.window.record(100 * 1024 * 1024);
    assert.deepEqual([Telemetry.heapRecord().afterGc, Telemetry.heapRecord().afterGcMax], [100, 300]);
    observed.close();
    assert.equal(Telemetry.heapRecord().afterGc, undefined);
    // A GC whose observer callback runs later than LATE_MS after the GC's end (the task after it was long) is dropped and counted.
    (async () => {
        const lateWindow = Telemetry.observe();
        global.gc();
        for (const start = performance.now(); performance.now() - start < Telemetry.LATE_MS + 15;);
        for (let i = 0; i < 20 && !lateWindow.window.late; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(lateWindow.window.late, 1);
        assert.deepEqual(lateWindow.snapshot(performance.now()).heapGcLate, 1);
        assert.equal(lateWindow.snapshot(performance.now()).v8Heap.late, 1);
        assert.deepEqual([lateWindow.window.snapshot().heapAfterGc, lateWindow.window.snapshot().heapAfterGcMax10], [0, 0]);
        lateWindow.close();
        console.log('A major-GC sample that arrives later than LATE_MS is dropped and counted');
    })();
    const workerPath = path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js');
    const wrapper = `const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
      const {parentPort,workerData}=require('node:worker_threads');
      const loaded=new Module(workerData.workerPath,module);loaded.filename=workerData.workerPath;
      loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
      loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+'\\nmodule.exports.forceHeapProbe=()=>global.gc();',workerData.workerPath);
      parentPort.on('message', message=>{if(message.heapProbe){loaded.exports.forceHeapProbe();parentPort.postMessage({probeDone:true});}});`;
    const epoch = 'heap-gc-native';
    const worker = new Worker(wrapper, { eval: true, workerData: { workerPath, workerEpoch: epoch } });
    let requested = false, probed = false, probes = 0;
    // A forced GC whose sample comes late on a loaded runner is dropped, so probe again until one is accepted.
    const probe = () => worker.postMessage({ ...Protocol.envelope('pause', epoch, {}, `probe-${++probes}`), heapProbe: true });
    const timer = setTimeout(() => { console.error('native GC heartbeat timeout'); worker.terminate(); process.exitCode = 1; }, 20000);
    worker.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
    worker.on('message', message => {
        if (message.type === 'ready' && message.payload.phase === 'loaded') {
            worker.postMessage(Protocol.envelope('init', epoch, { config: { loopIntervalMs: 1000, developerDiagnostics: true } }, 'init'));
        }
        if (message.type === 'ready' && message.payload.phase === 'running' && !requested) {
            requested = true; probe();
        }
        if (message.probeDone) probed = true;
        if (message.type === 'heartbeat' && probed && !(message.payload.heapAfterGc > 0)) probe();
        if (message.type === 'heartbeat' && probed && message.payload.heapAfterGc > 0) {
            try {
                assert(Number.isFinite(message.payload.heapAfterGc));
                assert(message.payload.heapAfterGcMax10 >= message.payload.heapAfterGc);
                // The kernel's due-heap node count keeps its numeric key; the V8 record has its own.
                assert.equal(typeof message.payload.heap, 'number');
                for (const key of ['used', 'total', 'external', 'limit', 'afterGc', 'afterGcMax']) assert(Number.isFinite(message.payload.v8Heap?.[key]), key);
                assert(message.payload.v8Heap.afterGcMax >= message.payload.v8Heap.afterGc);
                console.log('Actual cold-worker heartbeat carries major-GC heap and ten-minute maximum');
            } finally { clearTimeout(timer); worker.terminate(); }
        }
    });
}
