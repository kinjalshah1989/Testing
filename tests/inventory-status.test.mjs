import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAvailability, availabilityIndexes, inventoryKey, normalizeProductName } from '../netlify/shared/inventory-status.mjs';
import { adminEmails, bearerToken, requireAdmin } from '../netlify/shared/admin-auth.mjs';

test('inventory keys are normalized and invalid types are rejected', () => {
  assert.equal(inventoryKey('Jewelry', ' Ruby-Set '), 'jewelry:ruby-set');
  assert.throws(() => inventoryKey('../admin', 'ruby-set'), /valid product type/i);
  assert.throws(() => inventoryKey('jewelry', ''), /valid product type/i);
});

test('availability defaults to available and applies a sold-out override', () => {
  const products = [{ id: 'ruby-set', name: 'Ruby Set' }, { id: 'emerald-set', name: 'Emerald Set' }];
  const documents = [{ productKey: 'jewelry:ruby-set', productName: 'Ruby Set', available: false }];
  const result = applyAvailability(products, 'jewelry', documents);
  assert.equal(result[0].available, false);
  assert.equal(result[0].availabilityLabel, 'Sold Out');
  assert.equal(result[1].available, true);
  assert.equal(result[1].availabilityLabel, 'Available');
});

test('normalized product names provide checkout-safe fallback matching', () => {
  assert.equal(normalizeProductName('  Maharani   Ruby Set  '), 'maharani ruby set');
  const indexes = availabilityIndexes([{ productName: '  Maharani   Ruby Set ', available: false }]);
  assert.equal(indexes.byName.get('maharani ruby set').available, false);
});

test('admin allowlist and bearer token parsing are strict', () => {
  const original = process.env.GLOBAL_RANI_ADMIN_EMAILS;
  process.env.GLOBAL_RANI_ADMIN_EMAILS = 'Owner@Example.com, second@example.com';
  assert.deepEqual([...adminEmails()], ['owner@example.com', 'second@example.com']);
  assert.equal(bearerToken(new Request('https://example.com', { headers:{ Authorization:'Bearer abc.123' } })), 'abc.123');
  assert.equal(bearerToken(new Request('https://example.com')), '');
  if (original === undefined) delete process.env.GLOBAL_RANI_ADMIN_EMAILS;
  else process.env.GLOBAL_RANI_ADMIN_EMAILS = original;
});

test('admin endpoint fails closed when no allowlist is configured', async () => {
  const originalGlobal = process.env.GLOBAL_RANI_ADMIN_EMAILS;
  const originalAdmin = process.env.ADMIN_EMAILS;
  delete process.env.GLOBAL_RANI_ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  await assert.rejects(() => requireAdmin(new Request('https://example.com')), error => error.status === 503);
  if (originalGlobal !== undefined) process.env.GLOBAL_RANI_ADMIN_EMAILS = originalGlobal;
  if (originalAdmin !== undefined) process.env.ADMIN_EMAILS = originalAdmin;
});

test('an allowlisted email is still not enough without a signed Firebase token', async () => {
  const original = process.env.GLOBAL_RANI_ADMIN_EMAILS;
  process.env.GLOBAL_RANI_ADMIN_EMAILS = 'owner@example.com';
  await assert.rejects(() => requireAdmin(new Request('https://example.com')), error => error.status === 401);
  if (original === undefined) delete process.env.GLOBAL_RANI_ADMIN_EMAILS;
  else process.env.GLOBAL_RANI_ADMIN_EMAILS = original;
});
