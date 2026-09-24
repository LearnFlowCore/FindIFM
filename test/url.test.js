const test=require('node:test'); const assert=require('node:assert/strict'); const {normalizeUrl}=require('../src/utils/url');
test('normalizes tracking, hash, www and protocol',()=>assert.equal(normalizeUrl('http://www.Example.com/a?utm_source=x&ok=1#part'),'https://example.com/a?ok=1'));
