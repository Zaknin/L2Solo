(function exposeObserverFormat(root, factory) {
    const format = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = format;
    if (root) root.WorldObserverFormat = format;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    'use strict';

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    // Negatives clamp to 0; one fraction digit below 10000, none from there on.
    function compactAmount(value) {
        const amount = Math.max(0, Number(value || 0));
        if (amount < 1000) return amount.toLocaleString();
        return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: amount < 10000 ? 1 : 0 }).format(amount);
    }

    return Object.freeze({ escapeHtml, compactAmount });
}));
