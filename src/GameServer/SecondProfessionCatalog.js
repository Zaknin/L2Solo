'use strict';

// Pure route data: safe for the transaction owner without loading World.
const routes = require('../../data/Templates/second_profession_trials.json');
const currentIndex = require('./Knowledge/NativeServiceIndex').currentIndex;
const routeIndex = currentIndex(['classId', 'npcs'], rows => {
    const byClass = new Map(), byNpc = new Map();
    for (const route of rows) {
        if (!Array.isArray(route.npcs)) throw Error('invalid route NPC list');
        if (!byClass.has(route.classId)) byClass.set(route.classId, route);
        for (const npcId of new Set(route.npcs)) {
            if (!byNpc.has(npcId)) byNpc.set(npcId, []);
            byNpc.get(npcId).push(route);
        }
    }
    return { byClass, byNpc };
});
function routeForClass(classId, source) {
    if (arguments.length < 2) source = routes;
    const index = routeIndex(source);
    return index ? Number.isNaN(classId) ? undefined : index.byClass.get(classId)
        : source.find(route => route.classId === classId);
}
function routesForNpc(npcId, source) {
    if (arguments.length < 2) source = routes;
    const index = routeIndex(source);
    return index ? (index.byNpc.get(npcId) || []).slice()
        : source.filter(route => route.npcs.includes(npcId));
}
function hasNpc(npcId) {
    const index = routeIndex(routes);
    return index ? index.byNpc.has(npcId) : routes.some(route => route.npcs.includes(npcId));
}
function handles(id) {
    if (!routes.length) return false;
    if (id && ['object', 'function'].includes(typeof id))
        return routes.some(route => route.npcs.includes(Number(id)));
    return hasNpc(Number(id));
}
module.exports = { routes, routeForClass, routesForNpc, hasNpc, handles };
