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

const http = require('node:http');
const events = require('node:events');
const os = require('node:os');
const controller = require('../plugins/wled-screen-sync/controller');

test('controller deadlines, oversized bodies and interrupted responses complete once', async t => {
    const srv=http.createServer((req,res)=>{
        if(req.url==='/large')res.end(Buffer.alloc(65537));
        else if(req.url==='/partial'){res.write('part'); setImmediate(()=>res.destroy());}
    });
    await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
    t.after(()=>srv.close());
    for(const path of ['/large','/partial','/silent']){
        let calls=0;
        const error=await new Promise(resolve=>controller('127.0.0.1',path,150,null,e=>{
            calls++;resolve(e);
        },srv.address().port));
        assert(error instanceof Error);
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(calls,1);
    }
});

function harness(t, initial) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-check-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    let data={...initial}, power=false, failRestore=false;
    const writes=[], commands=[];
    t.mock.method(http,'request',(opts,onResponse)=>{
        const req=new events.EventEmitter();
        req.setTimeout=req.destroy=()=>{};
        req.end=body=>queueMicrotask(()=>{
            const res=new events.EventEmitter();
            res.statusCode=200;
            let result={on:power,seg:[{id:0,fx:77}]};
            if(body){
                const patch=JSON.parse(body); writes.push(patch);
                if(failRestore && patch.on===false)res.statusCode=503;
                else power=patch.on;
                result={success:res.statusCode===200};
            }
            onResponse(res);res.emit('data',Buffer.from(JSON.stringify(result)));res.emit('end');
        });
        return req;
    });
    return {ctx:{dir,config:{get:()=>structuredClone(data),set:v=>{data=structuredClone(v);}},
        execute:async cmd=>{commands.push(cmd);return {exit_code:0,stdout:'inactive'};}},
        writes,commands,fail:v=>{failRestore=v;}};
}

test('power snapshot survives lost stop, retries failed restore, never writes segment edits',async t=>{
    const h=harness(t,{Wled:'192.0.2.1'}), create=require('../plugins/wled-screen-sync/settings');
    const instance=()=>create(h.ctx,()=>({}),()=>{});
    await instance().start();
    assert.deepEqual(h.ctx.config.get().savedWledStates,{'192.0.2.1':{on:false}});
    const restart=instance();await restart.start();
    h.fail(true);await assert.rejects(restart.stop(),/503/);
    assert.deepEqual(h.ctx.config.get().savedWledStates,{'192.0.2.1':{on:false}});
    h.fail(false);await restart.stop();
    assert.deepEqual(h.ctx.config.get().savedWledStates,{});
    assert.deepEqual(h.writes,[{on:true},{on:false},{on:false}]);
});

test('a launch acknowledgement does not reset the five-start crash budget',async t=>{
    const h=harness(t,{Wled:'192.0.2.1',Lighting:'tv-audio'});
    const timers=new Map();
    t.mock.method(global,'setInterval',(fn,ms)=>{timers.set(ms,fn);return ms;});
    t.mock.method(global,'clearInterval',ms=>timers.delete(ms));
    let now=50000;
    t.mock.method(Date,'now',()=>now);
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    await shard.start();
    for(let i=0;i<20;i++){now+=65000;await timers.get(5000)();timers.get(2000)();}
    assert.equal(h.commands.filter(cmd=>cmd.includes('systemd-run')).length,5);
    assert.equal(shard.status().state,'failed');
    assert(!h.commands.some(cmd=>cmd.startsWith('busctl') || cmd.startsWith('systemctl stop')));
    await shard.stop();
});

test('loopback target does not start the helper or poll HDR',async t=>{
    const h=harness(t,{Wled:'127.0.0.1'});
    const shard=require('../plugins/wled-screen-sync')(h.ctx);
    await shard.start();await shard.stop();
    assert(!h.commands.some(cmd=>cmd.includes('systemd-run')||cmd.startsWith('busctl')));
    assert.equal(h.writes.length,0);
});
