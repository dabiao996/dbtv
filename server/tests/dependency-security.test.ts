import test from 'node:test';
import assert from 'node:assert/strict';
const proxyaddr=require('proxy-addr');

test('proxy trust rejects public IPv4 addresses for a malformed mapped IPv6 subnet',()=>{
  const malformed=proxyaddr.compile('::ffff:10.0.0.0/8');
  assert.equal(malformed('203.0.113.7'),false);
  const correct=proxyaddr.compile('10.0.0.0/8');
  assert.equal(correct('10.2.3.4'),true);
  assert.equal(correct('203.0.113.7'),false);
});
