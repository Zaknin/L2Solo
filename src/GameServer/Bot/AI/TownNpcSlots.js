const MAX_NPCS = 256;
const LEASE_MS = 30000;
const MAX_WAITERS = 256;
const buckets = new Map();

function release(session) {
    const lease = session?.townNpcSlot;
    if (lease) {
        const bucket = buckets.get(lease.key);
        if (bucket?.owners[lease.index]?.token === lease.token) bucket.owners[lease.index] = null;
        delete session.townNpcSlot;
    }
    const ticket = session?.townNpcQueue;
    if (ticket) {
        buckets.get(ticket.key)?.waiters.delete(ticket.token);
        delete session.townNpcQueue;
    }
}

function reserve(session, key, makePoints, preferred = 0, now = Date.now()) {
    if ((session.townNpcSlot && session.townNpcSlot.key !== key)
        || (session.townNpcQueue && session.townNpcQueue.key !== key)) release(session);
    let bucket = buckets.get(key);
    if (!bucket) {
        if (buckets.size >= MAX_NPCS) buckets.delete(buckets.keys().next().value);
        bucket = { points: makePoints(), owners: [], waiters: new Map() };
        buckets.set(key, bucket);
    }
    // Keep only small expiring tokens here, never sessions or actor graphs.
    for (const [token, until] of bucket.waiters) if (until <= now) bucket.waiters.delete(token);
    for (let index = 0; index < bucket.owners.length; index++) {
        if (bucket.owners[index]?.until <= now) bucket.owners[index] = null;
    }
    const lease = session.townNpcSlot;
    if (lease && bucket.owners[lease.index]?.token === lease.token) {
        bucket.owners[lease.index].until = now + LEASE_MS;
        return bucket.points[lease.index];
    }
    delete session.townNpcSlot;
    let ticket = session.townNpcQueue;
    if (!ticket || !bucket.waiters.has(ticket.token)) {
        if (bucket.waiters.size >= MAX_WAITERS) return null;
        ticket = { key, token: Symbol('npc-queue') };
        session.townNpcQueue = ticket;
    }
    bucket.waiters.set(ticket.token, now + LEASE_MS);
    const free = bucket.points.length - bucket.owners.filter(Boolean).length;
    let ahead = 0;
    for (const token of bucket.waiters.keys()) {
        if (token === ticket.token) break;
        ahead++;
    }
    // A later tick may use the second free place, but cannot take a place
    // owed to an earlier arrival. Poll order must not starve old shoppers.
    if (ahead >= free) return null;
    for (let step = 0; step < bucket.points.length; step++) {
        const index = (Math.abs(preferred) + step) % bucket.points.length;
        if (bucket.owners[index]?.until > now) continue;
        const token = ticket.token;
        bucket.owners[index] = { token, until: now + LEASE_MS };
        session.townNpcSlot = { key, index, token };
        bucket.waiters.delete(token);
        delete session.townNpcQueue;
        return bucket.points[index];
    }
    return null;
}

module.exports = { reserve, release, MAX_NPCS, MAX_WAITERS, LEASE_MS };
