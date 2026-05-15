// HTML rendering primitive: a tagged template that escapes every
// interpolated value by default, with an opt-in `Raw` wrapper for
// already-trusted fragments (composed sub-templates, the static CSS
// string). Server-rendered HTML is the *entire* web posture for slice
// 5b — no client-side framework, no hydration — so escape discipline
// is the only XSS line of defense.
//
// Slice 5b commits to no client-side interactivity (PRD §Anonymous-
// browse surface; ROADMAP Phase 2 slice 5b — "no interactivity beyond
// navigation"). That makes the rendering surface simple by
// construction: pages emit text that browsers consume statically, and
// the only untrusted inputs are graph contents (cause/sub-topic
// names, node IDs, etc.) flowing through `${value}` interpolations.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Wrapper that marks a string as already-escaped HTML so the template
// passes it through verbatim. `html` itself returns `Raw`, which is
// what makes composition work: the result of `html`...`` can be
// interpolated into another `html`...`` without double-escaping.
export class Raw {
  constructor(public readonly value: string) {}
}

// Mark a string as trusted HTML. Use sparingly — the `html` tagged
// template is the preferred entry point because it composes; `raw`
// exists for static fragments like the baseline stylesheet that are
// stored as constants and have no interpolation surface.
export function raw(value: string): Raw {
  return new Raw(value);
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(String(value));
}

// Tag function. Concatenates the literal segments with rendered
// interpolations; every interpolation is escaped unless it's a `Raw`
// (or an array of `Raw`s, the composition pattern pages use to emit
// lists). Returns `Raw` so the result composes into other templates.
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]);
    out += strings[i + 1] ?? '';
  }
  return new Raw(out);
}

// Wrap a body fragment in the full HTML5 document shell. The
// `<title>` is escaped via the template; the stylesheet is included
// inline as a `Raw` because keeping it inline avoids a second
// request for two pages of read-only content. If the stylesheet
// grows, slice 5c can split it into a separately-cached
// `/static/anchorage.css` route.
export function renderDocument(opts: { title: string; stylesheet: Raw; body: Raw }): string {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<style>${opts.stylesheet}</style>
</head>
<body>
${opts.body}
</body>
</html>
`;
  return doc.value;
}
