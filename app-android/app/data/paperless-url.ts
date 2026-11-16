/** Pure validation for the Paperless address the settings form accepts. */

/** Returns the address without trailing slashes, or null when it is not an http(s) URL with a host. */
export function normalizePaperlessUrl(input: string): string | null {
    const text = input.trim().replace(/\/+$/, '');
    const match = /^(https?):\/\/([^\s/?#]+)([^\s]*)$/i.exec(text);
    if (!match) return null;
    return `${match[1].toLowerCase()}://${match[2]}${match[3]}`;
}

/** Host part for display ("paperless.example.org"), or the input when it does not parse. */
export function paperlessHost(url: string): string {
    const match = /^https?:\/\/([^\s/?#]+)/i.exec(url);
    return match ? match[1] : url;
}
