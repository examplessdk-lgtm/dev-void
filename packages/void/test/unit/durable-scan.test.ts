import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { scanDurableObjectModules } from '../../src/durable/scan.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scanDurableObjectModules', () => {
  it('derives stable binding, class, and migration names from filenames', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-durable-scan-'));
    roots.push(root);
    mkdirSync(join(root, 'durable-objects'));
    writeFileSync(join(root, 'durable-objects', 'shopping-cart.ts'), 'export default class {}');

    expect(scanDurableObjectModules(root)).toEqual([
      {
        filePath: join(root, 'durable-objects', 'shopping-cart.ts'),
        bindingName: 'SHOPPING_CART',
        className: 'ShoppingCartDurableObject',
        migrationTag: 'void-durable-shopping-cart-v1',
      },
    ]);
  });

  it('rejects filenames that normalize to the same generated names', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-durable-scan-'));
    roots.push(root);
    mkdirSync(join(root, 'durable-objects'));
    writeFileSync(join(root, 'durable-objects', 'shopping-cart.ts'), 'export default {}');
    writeFileSync(join(root, 'durable-objects', 'shopping_cart.ts'), 'export default {}');

    expect(() => scanDurableObjectModules(root)).toThrow('duplicate generated name');
  });
});
