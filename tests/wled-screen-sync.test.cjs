'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname,'..');

test('WLED helper payload verification rejects source mismatch', () => {
    const {verifyPayload} = require('../scripts/build-wled-screen-sync-helper.cjs');
    const rebuilt = Buffer.from('Colour.dll fixture');
    assert.throws(() => verifyPayload(rebuilt, Buffer.from('different').toString('base64')), /SHA-256 mismatch/);
});

test('WLED source has no WLED Freqwave mode and uses runtime files', () => {
    const files = ['index.js','settings.js','Colour.cs','controls.json','panel.html'].map(name => fs.readFileSync(path.join(root,'plugins/wled-screen-sync',name),'utf8'));
    const joined = files.join('\n');
    assert(!/Freqwave|Lighting.?===?.?['"]audio|WLED audio sync/.test(joined));
    assert(!/\/tmp\/ambilight-studio-(rate|preview)/.test(joined));
    assert(joined.includes('runtimeDir'));
    assert(joined.includes('screen-audio'));
});

test('WLED helper has platform and 32-bit native guards', () => {
    const colour = fs.readFileSync(path.join(root,'plugins/wled-screen-sync/Colour.cs'),'utf8');
    const plane = fs.readFileSync(path.join(root,'plugins/wled-screen-sync/VideoPlaneCapture.cs'),'utf8');
    assert.match(colour,/--check-platform/);
    assert.match(colour,/IntPtr\.Size!=4/);
    assert.match(plane,/IntPtr\.Size != 4/);
});
