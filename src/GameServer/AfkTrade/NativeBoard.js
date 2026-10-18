'use strict';
const PREFIX = 'L2SOLO_BOARD_V1\n';
const PREFIX_V2 = 'L2SOLO_BOARD_V2\n';
const text = (value, max = 160) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
function encode(session, model) {
    const actions = [];
    const action = (entry, role) => {
        if (!entry?.command) return 0;
        const id = actions.push({ ...entry, role });
        return id;
    };
    const rows = (model.rows || []).map(row => ({ ...row,
        select: action(row.select, 'row'), primary: action(row.primary, 'row'), locate: action(row.locate, 'row') }));
    for (const entry of model.actions || []) action(entry, entry.role);
    const query = session.playerBoardView || {};
    const side = query.side === 'workshop' ? 'workshop' : Number(query.side) === 3 ? 'buy' : 'sell';
    const revision = ++session.nativeBoardRevision;
    const meeting = model.meeting;
    const lines = [['state', session.nativeBoardEpoch, revision, model.screen || 'list', side, text(query.town, 64),
        text(session.playerBoardSearch, 48), model.itemId || 0, text(model.itemName, 96), text(model.title || 'Market Board', 64),
        text(model.message, 240), model.page || 1, rows.length, actions.length, (model.towns || []).length, (model.details || []).length].join('\t')];
    if (session.nativeBoardVersion === 2) lines[0] += '\t' + (query.tradeType || 'all');
    lines.push(['meeting', meeting ? 1 : 0, text(meeting?.name, 64), text(meeting?.town, 64), text(meeting?.phase, 96), meeting?.seconds || 0].join('\t'));
    for (const row of rows) lines.push(['row', row.itemId || 0, text(row.name, 96), text(row.owner, 64), text(row.town, 64),
        text(row.price, 40), text(row.quantity, 40), text(row.mode, 64), row.select, row.primary, row.locate].join('\t'));
    for (let i = 0; i < actions.length; i++) lines.push(['action', i + 1, actions[i].role, text(actions[i].label, 32)].join('\t'));
    for (const town of model.towns || []) lines.push(['town', text(town, 64)].join('\t'));
    for (const [label, value] of model.details || []) lines.push(['detail', text(label, 40), text(value, 160)].join('\t'));
    const result = (session.nativeBoardVersion === 2 ? PREFIX_V2 : PREFIX) + lines.join('\n');
    if (result.length > 8192 || rows.length > 12 || actions.length > 64 || (model.details || []).length > 16) throw Error('Native board exceeds C4 bounds');
    session.nativeBoardActions = actions;
    session.nativeBoardTowns = model.towns || [];
    session.nativeBoardModel = model;
    return result;
}
function begin(session) {
    session.nativeBoardOpen = true;
    session.nativeBoardEpoch = (session.nativeBoardEpoch || 0) + 1;
    session.nativeBoardRevision = 0;
}
function present(session, html, model, response) {
    session.nativeBoardModel = model;
    if (session.nativeBoardVersion >= 1) {
        if (!session.nativeBoardOpen) return;
        const snapshot = encode(session, model);
        session.dataSendToMe(response.npcHtml(session.actor.fetchId(), snapshot));
        return snapshot;
    }
    session.dataSendToMe(response.npcHtml(session.actor.fetchId(), html));
    return html;
}
function create({ window = () => require('./PlayerBoardWindow') } = {}) {
    async function handle(session, parts) {
        if (!session?.actor || !session.nativeBoardOpen) return;
        if (parts[1] === 'open' && parts.length === 3 && ['0', '1', '2'].includes(parts[2])) {
            session.nativeBoardVersion = Number(parts[2]);
            return window().show(session, session.playerBoardView || {});
        }
        if (String(session.nativeBoardEpoch) !== parts[2]) return;
        if (parts[1] === 'close' && parts.length === 3) {
            session.nativeBoardOpen = false;
            session.nativeBoardActions = [];
            return;
        }
        if (session.nativeBoardBusy || String(session.nativeBoardRevision) !== parts[3]) return;
        let command;
        if (parts[1] === 'run' && (parts.length === 5 || parts.length === 6)) {
            const action = session.nativeBoardActions?.[Number(parts[4]) - 1];
            if (!action || String(Number(parts[4])) !== parts[4]) return;
            command = action.command;
            if (action.role === 'quantity') {
                if (parts.length !== 6 || !/^[1-9]\d{0,15}$/.test(parts[5]) || !Number.isSafeInteger(Number(parts[5]))) return;
                command += ' ' + parts[5];
            } else if (parts.length !== 5) return;
        } else if (parts[1] === 'town' && parts.length === 5) {
            const town = session.nativeBoardTowns?.[Number(parts[4])];
            if (!town || String(Number(parts[4])) !== parts[4]) return;
            command = 'board town ' + town;
        } else if (parts[1] === 'type' && session.nativeBoardVersion === 2 && parts.length === 5) {
            if (!['all', 'meeting', 'shop'].includes(parts[4])) return;
            command = 'board type ' + parts[4];
        } else if (parts[1] === 'search' && parts.length === 5) {
            let query;
            try { query = decodeURIComponent(parts[4]).trim(); } catch { return; }
            if (query.length > 48 || /[\x00-\x1f\x7f$]/.test(query)) return;
            command = query ? 'board search ' + query : 'board list ' + (session.playerBoardView?.side === 'workshop' ? 'workshop'
                : Number(session.playerBoardView?.side) === 3 ? 'buy' : 'sell') + ' ' + (session.playerBoardView?.town ? encodeURIComponent(session.playerBoardView.town) : '-') + ' 0 -'
                + (session.playerBoardView?.tradeType && session.playerBoardView.tradeType !== 'all' ? ' ' + session.playerBoardView.tradeType : '');
            if (!query) session.playerBoardSearch = '';
        } else if (parts[1] === 'refresh' && parts.length === 4) return window().refresh(session);
        else return;
        // Consume the rendered action set before async gameplay work. Prices,
        // revisions and permissions are revalidated by the existing board path.
        session.nativeBoardActions = [];
        const marker = session.nativeBoardBusy = {};
        try { return await window().handle(session, command.split(' ')); }
        finally { if (session.nativeBoardBusy === marker) session.nativeBoardBusy = undefined; }
    }
    return handle;
}
module.exports = { PREFIX, PREFIX_V2, text, encode, begin, present, create, handle: create() };
