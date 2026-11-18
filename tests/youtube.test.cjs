'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('net');
const address=require('../plugins/youtube/address.js'),tile=require('../plugins/youtube/tile.js'),setup=require('../plugins/youtube/setup.js'),proxyLib=require('../plugins/youtube/proxy.js');
const ifaces={lo:[{address:'127.0.0.1',family:'IPv4',internal:true}],wlan0:[{address:'192.168.1.50',family:'IPv4',internal:false},{address:'fe80::1%wlan0',family:'IPv6',internal:false}]};

test('the proxy only talks to the TV itself',()=>{
 for(const a of ['127.0.0.1','127.0.0.2','::1','::ffff:127.0.0.1','192.168.1.50','::ffff:192.168.1.50','fe80::1'])assert.equal(address.isLocal(a,ifaces),true,a);
 for(const a of ['192.168.1.51','10.0.0.5','::ffff:192.168.1.51','8.8.8.8','',undefined])assert.equal(address.isLocal(a,ifaces),false,String(a));
});
test('address pick and mode',()=>{
 assert.equal(address.lanAddress(ifaces),'192.168.1.50');
 assert.equal(address.lanAddress({lo:ifaces.lo,x:[{address:'169.254.3.4',family:'IPv4',internal:false}]}),null);
 assert.equal(address.tizenMajor('Tizen6/TV 6.0.0'),6);assert.equal(address.tizenMajor('Tizen 9.0.0'),9);assert.equal(address.tizenMajor(''),0);
 assert.equal(address.chooseMode(undefined,6),'loopback');assert.equal(address.chooseMode(undefined,9),'lan');assert.equal(address.chooseMode(undefined,0),'loopback');
 assert.equal(address.chooseMode('loopback',9),'loopback');assert.equal(address.chooseMode('lan',6),'lan');
});
test('Samsung row: a LAN address fits when short, says toolong when not',()=>{
 const stock='--base_url=https://www.youtube.com/tv --dial_name=YouTube --use_eden --start_frag=#start';
 assert.ok(tile.patched(stock,'127.0.0.2',8101).length<=tile.MAX_VALUE);
 assert.ok(tile.patched(stock,'192.168.1.123',8101).length<=tile.MAX_VALUE);
 assert.equal(tile.patched(stock,'192.168.100.123',8101),null);
 const v=tile.patched(stock,'192.168.1.123',8101);
 assert.ok(tile.isPatched(v));assert.equal(tile.original(v),stock);                       // undoes whatever address was written
 const rows=[];const exec=s=>{rows.push(s);return Promise.resolve({stdout:rows.length===1?stock+'\n':''});};
 return tile.apply(exec,'192.168.100.123',8101).then(state=>{assert.equal(state,'toolong');assert.equal(rows.length,1);});    // nothing written
});
test('proxy refuses peers that are not the TV and counts what arrives',()=>new Promise((resolve,reject)=>{
 const logs=[];let allowed=false;
 const port=40000+Math.floor(Math.random()*20000);
 const q=proxyLib.createProxy({host:'127.0.0.1',port,log:m=>logs.push(m),leaf:()=>null,script:()=>null,allow:()=>allowed});
 q.listen(err=>{
  if(err)return reject(err);
  const c1=net.connect(port,'127.0.0.1');c1.on('error',()=>{});c1.resume();
  c1.on('close',()=>{
   try{assert.equal(q.stats().foreign,1);assert.equal(q.stats().accepted,0);}catch(x){q.close(true);return reject(x);}
   allowed=true;
   const c2=net.connect(port,'127.0.0.1',()=>c2.write('GET http://x/ HTTP/1.1\r\n\r\n'));c2.on('error',()=>{});c2.resume();
   c2.on('close',()=>{
    try{assert.equal(q.stats().accepted,1);assert.ok(logs.some(l=>/first connection/.test(l)));assert.ok(logs.some(l=>/not a CONNECT/.test(l)));}catch(x){q.close(true);return reject(x);}
    q.close(true);resolve();
   });
  });
 });
}));
test('Open path starts the app with the chosen proxy address',()=>{
 assert.match(setup.launchScript('192.168.1.50',8101),/--proxy=192\.168\.1\.50:8101,direct:\/\/ --content=\/opt\/usr\/home\/owner\/share\/vyt/);
});
