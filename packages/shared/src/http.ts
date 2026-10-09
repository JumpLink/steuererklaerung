/** Max chars of a response body echoed in an error message (was DEFAULTS.HTTP_ERROR_SNIPPET_LEN). */
const HTTP_ERROR_SNIPPET_LEN = 120;

export function httpErrorSnippet(res: Response, body: string): string {
    return `HTTP ${res.status}: ${body.slice(0, HTTP_ERROR_SNIPPET_LEN)}`;
}
