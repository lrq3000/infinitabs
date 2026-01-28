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
