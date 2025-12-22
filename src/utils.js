/**
 * Builds a display string for a group title with an associated color.
 * @param {string} title - The group title; when falsy, defaults to "Group".
 * @param {string} color - The group color; when falsy, defaults to "grey".
 * @returns {string} The formatted title in the form "Title [color]".
 */

function formatGroupTitle(title, color) {
    // If title is empty, Chrome uses "Group".
    const safeTitle = title || "Group";
    const safeColor = color || "grey";
    return `${safeTitle} [${safeColor}]`;
}

/**
 * Parse a group title string formatted as "Name [color]" into its components.
 * @param {string} fullTitle - The input string, expected as `"Name [color]"`; if it doesn't match that pattern the entire input is treated as the name.
 * @returns {{name: string, color: string}} The parsed components: `name` is the trimmed name, `color` is the lowercase color when present or `'grey'` when the pattern does not match.
 */
function parseGroupTitle(fullTitle) {
    // Format: "Name [color]"
    const match = fullTitle.match(/^(.*?) \[([a-z]+)\]$/);
    if (match) {
        return { name: match[1].trim(), color: match[2].toLowerCase() };
    }
    return { name: fullTitle, color: 'grey' }; // Default color
}