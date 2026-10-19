// NPC sales and item awards must not publish stale stack amounts over each
// other while their SQLite writes are awaiting completion.
const pending = new WeakMap();

function run(backpack, work) {
    const previous = pending.get(backpack);
    let result;
    try { result = previous ? previous.then(work) : Promise.resolve(work()); }
    catch (error) { result = Promise.reject(error); }
    const settled = result.catch(() => {});
    pending.set(backpack, settled);
    settled.then(() => {
        if (pending.get(backpack) === settled) pending.delete(backpack);
    });
    return result;
}

module.exports = { run };
