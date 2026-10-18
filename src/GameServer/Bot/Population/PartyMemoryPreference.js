// One selection owns this cache; scoring performs no SQL and never changes memory.
function create({ memory = invoke('GameServer/Social/InteractionMemoryRuntime'), timestamp = Date.now() } = {}) {
    const pairs = new Map();
    const directed = (sourceId, targetId) => {
        const relation = memory.assess({ id: sourceId }, { id: targetId }, {}, timestamp);
        if (!relation.ready || !(relation.effective || relation.personal)) return 0;
        const p = relation.effective || relation.personal;
        return Math.max(-100, Math.min(100, p.affinity + p.trust * 2 - p.hostility * 2 - p.fear));
    };
    // pairs: smaller id -> larger id -> the pair's mean of both directions.
    const pair = (a, b) => {
        const left = Number(a.characterId), right = Number(b.characterId);
        if (left === right) return 0;
        const low = left < right ? left : right, high = left < right ? right : left;
        let row = pairs.get(low);
        if (!row) pairs.set(low, row = new Map());
        let value = row.get(high);
        if (value === undefined) row.set(high, value = (directed(left, right) + directed(right, left)) / 2);
        return value;
    };
    return {
        score(state, peers) {
            return peers.length ? peers.reduce((sum, peer) => sum + pair(state, peer), 0) / peers.length : 0;
        },
        groupScore(members) {
            let total = 0, count = 0;
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) { total += pair(members[i], members[j]); count++; }
            }
            return count ? total / count : 0;
        }
    };
}

module.exports = { create };
