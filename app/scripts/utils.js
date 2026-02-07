export function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) color += letters[Math.floor(Math.random() * 16)];
    return color;
}

/**
 * Produce a deterministic color for a given name.
 * Uses a simple string hash to pick an HSL color, then converts to hex.
 * This ensures the same input name always yields the same color while
 * keeping saturation/lightness in a pleasant range.
 */
export function colorFromName(name) {
    const str = (name || '').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
        // keep in 32-bit int range
        hash = hash & hash;
    }
    const h = Math.abs(hash) % 360; // hue 0-359
    const s = 50 + (Math.abs(hash >> 8) % 20); // saturation 50-69
    const l = 40 + (Math.abs(hash >> 16) % 20); // lightness 40-59
    return hslToHex(h, s, l);
}

function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
