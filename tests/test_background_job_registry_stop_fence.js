process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');

require('../src/Global');

const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');

// E243: tick() hands a due job to a microtask. A stop() that comes before that
// microtask runs must keep the job from starting: shutdown stops the registry
// and then flushes and closes the database, so a job started after stop()
// would write behind the last flush.
async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
    let runs = 0;
    const errors = [];
    const registry = BackgroundJobRegistry.create({
        tickMs: 50,
        now: () => 1000,
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
        onError: (job, error) => errors.push(`${job}:${error.message}`)
    });
    registry.register({ name: 'queued_before_stop', intervalMs: 1000, offsetMs: 0, run: () => { runs += 1; } });

    registry.start(1000);
    assert.strictEqual(registry.jobs.get('queued_before_stop').inFlight, true, 'the initial tick queues the due job');
    registry.stop();
    await flush();

    assert.strictEqual(runs, 0, 'a job queued before stop() must not start after stop()');
    const job = registry.jobs.get('queued_before_stop');
    assert.strictEqual(job.inFlight, false, 'the fenced job releases its in-flight slot');
    assert.strictEqual(job.completed, 0, 'a fenced job is not counted as completed');
    assert.deepStrictEqual(errors, []);

    // A later start() runs the job normally again.
    registry.start(5000);
    await flush();
    assert.strictEqual(runs, 1, 'the registry runs jobs again after a new start()');
    registry.stop();
    console.log('background job registry stop fence ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
