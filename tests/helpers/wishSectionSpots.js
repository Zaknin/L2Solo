'use strict';

// Standalone SpotProfiles.ensure sees only raid profiles until physical
// spawns exist. Populate its ordinary input from actual native definitions,
// then let the native index/profile builders make the test's catalogue.
module.exports = () => {
    const Data = invoke('GameServer/DataCache');
    const World = invoke('GameServer/World/World');
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const npc = Data.npcs.find(row => row.selfId === 414);
    const model = { model: { ...npc.template, selfId: npc.selfId } };
    const Npc = invoke('GameServer/Model/Npc');
    const definitions = invoke('GameServer/Knowledge/GameDataCatalogue').native().spawnsForNpc(414);
    const original = World.npc;
    try {
        World.npc = { ...original, spawns: definitions.flatMap(({ definition }) => (definition.coords || []).map(loc => ({
            ...npc, fetchAttackable: () => Npc.prototype.fetchAttackable.call(model),
            fetchSelfId: () => npc.selfId, fetchName: () => npc.template.name, fetchLevel: () => npc.template.level,
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ
        }))) };
        Service.reset(); Profiles.reset();
        const rows = Profiles.ensure();
        if (!rows.some(row => row.npcEntries?.some(entry => entry.selfId === 414)))
            throw new Error('native ordinary spawn fixture was not indexed');
        return rows;
    } finally { World.npc = original; }
};
