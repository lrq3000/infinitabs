// utils.js

export function formatGroupTitle(title, color) {
    // If title is empty, Chrome uses "Group".
    const safeTitle = title || "Group";
    const safeColor = color || "grey";
    return `${safeTitle} [${safeColor}]`;
}

export function parseGroupTitle(fullTitle) {
    // Format: "Name [color]"
    const match = fullTitle.match(/^(.*?) \[([a-z]+)\]$/);
    if (match) {
        return { name: match[1].trim(), color: match[2].toLowerCase() };
    }
    return { name: fullTitle, color: 'grey' }; // Default color
}

export function formatSessionTitle(name, windowId) {
    if (windowId) {
        // Remove any existing windowId from the name to avoid duplication
        const cleanName = name.replace(/ \[windowId:\d+\]$/, '');
        return `${cleanName} [windowId:${windowId}]`;
    }
    return name;
}

export function parseSessionTitle(title) {
    const match = title.match(/^(.*?) \[windowId:(\d+)\]$/);
    if (match) {
        return {
            name: match[1].trim(),
            windowId: parseInt(match[2], 10)
        };
    }
    return { name: title, windowId: null };
}

export function generateGuid() {
    return self.crypto.randomUUID();
}

export function isWorkspaceTrivial(snapshot, state) {
    if (!snapshot || snapshot.sessions.length === 0) return true;

    // If only one window
    if (snapshot.sessions.length === 1) {
        const session = state.sessionsById[snapshot.sessions[0].sessionId];
        if (!session) return true;

        // If session has only one tab and it's a new tab/blank
        if (session.logicalTabs.length <= 1) {
            const tab = session.logicalTabs[0];
            if (!tab || tab.url === "chrome://newtab/" || tab.url === "about:blank" || tab.url === "edge://newtab/") {
                return true;
            }
        }
    }
    return false;
}
