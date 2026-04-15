import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Link } from '../../src/runtime/link';

describe('Link', () => {
  it('merges GET data into the rendered href', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '/users',
          data: {
            tag: ['a', 'b'],
            page: 2,
            active: true,
            skip: null,
            missing: undefined,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="/users?tag=a&amp;tag=b&amp;page=2&amp;active=true"');
  });

  it('preserves dot-segment relative hrefs when merging GET data', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users?sort=name#team',
          data: {
            page: 2,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users?sort=name&amp;page=2#team"');
  });

  it('preserves hrefs when GET data does not add query params', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users',
          data: {
            empty: [],
            skip: null,
            missing: undefined,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users"');
  });

  it('rejects nested GET data', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', data: { filters: { status: 'open' } } }, 'Users'),
      ),
    ).toThrow('Void Link GET data only supports primitive values and arrays');
  });

  it('rejects prefetch on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', prefetch: true }, 'Create'),
      ),
    ).toThrow('Void Link prefetch only supports GET links');
  });

  it('rejects reloadDocument on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', reloadDocument: true }, 'Create'),
      ),
    ).toThrow('Void Link reloadDocument only supports GET links');
  });
});
