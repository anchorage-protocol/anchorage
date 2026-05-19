import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw, renderDocument } from './render.js';
import {
  matchContributorRoute,
  matchManuscriptRoute,
  matchNodeRoute,
  matchSubTopicRoute,
} from './web.js';

// Slice 5b — `@anchorage/web` package unit tests. The runtime
// dependency graph is one-way (web → contracts only at runtime), so
// these tests stay free of `@anchorage/server`. End-to-end coverage
// of the integration (`buildWebHandler` + `InProcessReader` + a
// real `Server` driving the route surface against seeded graph
// state) lives in `packages/server/src/web-integration.test.ts`,
// where the server-runtime symbols are first-class.

describe('render primitives', () => {
  it('escapes HTML metacharacters by default', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('"&\'<>')).toBe('&quot;&amp;&#39;&lt;&gt;');
  });

  it('html`` escapes interpolated values but passes Raw through verbatim', () => {
    const safe = html`<p>${'<b>nope</b>'}</p>`;
    expect(safe.value).toBe('<p>&lt;b&gt;nope&lt;/b&gt;</p>');
    const composed = html`<div>${raw('<b>yes</b>')}</div>`;
    expect(composed.value).toBe('<div><b>yes</b></div>');
  });

  it('renders arrays of values by concatenation', () => {
    const items = [1, 2, 3];
    const out = html`<ul>${items.map((n) => html`<li>${n}</li>`)}</ul>`;
    expect(out.value).toBe('<ul><li>1</li><li>2</li><li>3</li></ul>');
  });

  it('renderDocument wraps a body in the HTML5 shell with escaped title', () => {
    const out = renderDocument({
      title: 'Title <with> tags',
      stylesheet: raw('body{color:red}'),
      body: html`<p>hi</p>`,
    });
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<title>Title &lt;with&gt; tags</title>');
    expect(out).toContain('<style>body{color:red}</style>');
    expect(out).toContain('<p>hi</p>');
  });
});

describe('route matchers', () => {
  it('matchSubTopicRoute returns the id segment for /sub-topic/:id', () => {
    expect(matchSubTopicRoute('/sub-topic/abc')).toBe('abc');
    expect(matchSubTopicRoute('/sub-topic/sub-topic_01HXXXX')).toBe('sub-topic_01HXXXX');
  });
  it('matchNodeRoute returns the id segment for /node/:id', () => {
    expect(matchNodeRoute('/node/nod_abc')).toBe('nod_abc');
  });
  it('matchContributorRoute returns the id segment for /contributor/:id', () => {
    expect(matchContributorRoute('/contributor/idn_abc')).toBe('idn_abc');
  });
  it('matchManuscriptRoute returns the id segment for /manuscript/:id', () => {
    expect(matchManuscriptRoute('/manuscript/sub-topic_01HXXXX')).toBe('sub-topic_01HXXXX');
  });
  it('returns undefined for unrelated paths', () => {
    for (const m of [
      matchSubTopicRoute,
      matchNodeRoute,
      matchContributorRoute,
      matchManuscriptRoute,
    ]) {
      expect(m('/')).toBeUndefined();
      expect(m('/something/else')).toBeUndefined();
    }
    expect(matchSubTopicRoute('/sub-topic')).toBeUndefined();
    expect(matchSubTopicRoute('/sub-topic/')).toBeUndefined();
    expect(matchSubTopicRoute('/sub-topic/abc/extra')).toBeUndefined();
    expect(matchNodeRoute('/node/')).toBeUndefined();
    expect(matchContributorRoute('/contributor/abc/extra')).toBeUndefined();
    expect(matchManuscriptRoute('/manuscript/abc/extra')).toBeUndefined();
  });
  it('decodes percent-encoded segments', () => {
    expect(matchSubTopicRoute('/sub-topic/abc%20def')).toBe('abc def');
    expect(matchNodeRoute('/node/abc%20def')).toBe('abc def');
    expect(matchContributorRoute('/contributor/abc%20def')).toBe('abc def');
    expect(matchManuscriptRoute('/manuscript/abc%20def')).toBe('abc def');
  });
});
