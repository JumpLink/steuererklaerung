// The text scanning behind `check:fields`, split out of dev/check-field-coverage.js so the GJS unit
// tests can pin it. Node 24 runs this file directly (type stripping), so it keeps to erasable
// TypeScript: no enums, no namespaces, no parameter properties.

export interface SchemaLeaf {
    /** 1-based line of the declaration. */
    line: number;
    /** The nearest `const XSchema = z…` above the field. */
    block: string;
}

/** `z.array(z.string())` and friends are leaves: a list of plain values is filled in directly. */
const PRIMITIVE_ARRAY = /^\.?array\(\s*z\.(string|number|boolean|enum)\(/;
/** The first call of a chain that makes the field a container rather than a leaf. */
const CONTAINER = /^\.?(object|array|record)\(/;

/**
 * Leaf field names declared in a Zod schema file.
 *
 * Read as text rather than by importing the schemas: Zod 4 gives no stable public way to walk a
 * schema's shape, and a parser that guesses at internals breaks on the next minor.
 *
 * Two declaration shapes exist and both count: `name: z.string()…` on one line, and the chain the
 * formatter breaks once it is long — `name: z` with `.string()` on the next line. The second was
 * invisible to the first version of this scan, and so were camelCase names (`taxModule`,
 * `allowWrite`): a field the scan never sees is a field it can never report.
 */
export function schemaLeaves(src: string): Map<string, SchemaLeaf> {
    const leaves = new Map<string, SchemaLeaf>();
    const lines = src.split('\n');
    let block = '?';
    lines.forEach((line, i) => {
        const decl = /^(?:export )?const (\w+)\s*=\s*z$|^(?:export )?const (\w+)\s*=\s*z\./.exec(line);
        if (decl) block = decl[1] ?? decl[2];
        const match = /^\s{4,}([a-z][A-Za-z0-9_]*)\s*:\s*z(\.|\s*$)/.exec(line);
        if (!match) return;
        // The chain as one string from the first call on, wherever the formatter broke it.
        let chain =
            match[2] === '.'
                ? line
                      .slice(line.indexOf(':') + 1)
                      .trim()
                      .replace(/^z/, '')
                : '';
        if (!chain) {
            const next = lines.slice(i + 1).find((l) => l.trim() !== '');
            const after = lines.slice(i + 2).find((l) => l.trim() !== '' && l !== next);
            chain = `${(next ?? '').trim()}${(after ?? '').trim()}`;
        }
        // Containers are not leaves: their children are what a person fills in.
        if (CONTAINER.test(chain) && !PRIMITIVE_ARRAY.test(chain)) return;
        if (!leaves.has(match[1])) leaves.set(match[1], { line: i + 1, block });
    });
    return leaves;
}

/**
 * The frontend source with everything removed that names a field without USING it: comments,
 * prose in strings, and type declarations.
 *
 * The first version matched `field:` anywhere, so `country: string;` in an interface and a comment
 * reading `country: DE` both counted as a row for the entity's country. A type says what a value
 * looks like; it does not let anyone set one.
 *
 * A string that is nothing but an identifier stays — `'country'` as a key passed to a setter is a
 * real use.
 */
export function stripNonCode(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 2;
            out += ' ';
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            // `${…}` inside a template is code — `${a.gesellschafter.quote}` reads the field — so
            // it is kept, as a parenthesised expression after the emptied literal.
            const expressions: string[] = [];
            let j = i + 1;
            while (j < src.length && src[j] !== c) {
                if (src[j] === '\\') j++;
                else if (c !== '`' && src[j] === '\n') break;
                else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
                    let depth = 1;
                    const start = j + 2;
                    j = start;
                    while (j < src.length && depth > 0) {
                        if (src[j] === '{') depth++;
                        else if (src[j] === '}') depth--;
                        j++;
                    }
                    expressions.push(stripNonCode(src.slice(start, j - 1)));
                    continue;
                }
                j++;
            }
            const body = src.slice(i + 1, j);
            out += /^[A-Za-z_][A-Za-z0-9_]*$/.test(body) ? `${c}${body}${c}` : `${c}${c}`;
            for (const e of expressions) out += ` (${e})`;
            i = j + 1;
            continue;
        }
        out += c;
        i++;
    }
    return stripTypeDeclarations(out);
}

/** Remove `interface X { … }` and `type X = { … }` bodies, brace-matched. */
function stripTypeDeclarations(src: string): string {
    const head = /\b(?:interface\s+\w+(?:<[^>{]*>)?(?:\s+extends\s+[^{]+)?|type\s+\w+(?:<[^>=]*>)?\s*=)\s*\{/g;
    let out = '';
    let from = 0;
    for (let m = head.exec(src); m; m = head.exec(src)) {
        if (m.index < from) continue;
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
        }
        out += src.slice(from, m.index);
        from = j;
        head.lastIndex = j;
    }
    return out + src.slice(from);
}

/** What follows `field:` when it is a type annotation (`country: string;`, `x?: Foo[]`). */
const TYPE_AFTER_COLON =
    /^\s*(?:string|number|boolean|unknown|any|null|undefined|void|[A-Z][a-z]\w*(?:<[^>]*>)?)(?:\[\])?\s*(?:[;,)=|]|$)/m;

/**
 * Whether the (stripped) surface mentions this field the way code USES a field — `x.field`, a
 * `field:` object key with a value, `'field'` — rather than the way a type or prose names it.
 *
 * Still only evidence of a mention, never proof of an editable row.
 */
export function mentions(code: string, field: string): boolean {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:\\?)?\\.${escaped}\\b|['"\`]${escaped}['"\`]`).test(code)) return true;
    const key = new RegExp(`\\b${escaped}\\s*\\??:`, 'g');
    for (let m = key.exec(code); m; m = key.exec(code)) {
        if (!TYPE_AFTER_COLON.test(code.slice(m.index + m[0].length, m.index + m[0].length + 80))) return true;
    }
    return false;
}
