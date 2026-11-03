'use strict';

// ==========================================================
// Shared UI helpers (every web page and the Mini App)
// ----------------------------------------------------------
// Icons come from one Lucide sprite, assets/icons/lucide.svg, built by
// scripts/build-icons.js from the names used in the pages and scripts. An icon
// is decoration: anything it means is also said in text or in aria-label.
// ==========================================================

const UI_ICON_SPRITE = 'assets/icons/lucide.svg';

/** An inline Lucide icon, sized and coloured by its surroundings. */
function uiIcon(name, extraClass) {
    return `<svg class="ui-icon${extraClass ? ' ' + extraClass : ''}" aria-hidden="true" focusable="false"><use href="${UI_ICON_SPRITE}#${name}"></use></svg>`;
}
