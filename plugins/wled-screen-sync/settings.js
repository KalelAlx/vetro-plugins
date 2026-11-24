'use strict';
var fs = require('fs'), path = require('path'), request = require('./controller');
var fields = require('./controls.json');
function isRoutableIpv4(address) {
    if (typeof address !== 'string') return false;
    var parts = address.split('.');
    if (parts.length !== 4) return false;
    var a = Number(parts[0]), b = Number(parts[1]);
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return false;
    return true;
}
function valid(f, v) {
    if (f.type === 'toggle') return typeof v === 'boolean';
    if (f.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (f.options) return typeof v === 'string' && Object.prototype.hasOwnProperty.call(f.options,v);
    if (f.type === 'ipv4') return typeof v === 'string' && /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
    if (f.choices) return f.choices.indexOf(v) >= 0;
    return typeof v === 'number' && v === Math.floor(v) && v >= f.min && v <= f.max;
}
function readBody(req, limit, res, onBody, onTooLarge) {
    var chunks = [], size = 0, done = false;
    req.on('error', function() { done = true; });
    req.on('data', function(chunk) {
        if (done) return;
        var buf = Buffer.isBuffer(chunk) ? chunk : new Buffer(String(chunk), 'utf8');
        size += buf.length;
        if (size > limit) {
            done = true;
            onTooLarge();
            if (typeof req.destroy === 'function') req.destroy();
            return;
        }
        chunks.push(buf);
    });
    req.on('end', function() {
        if (done) return;
        done = true;
        onBody(Buffer.concat(chunks).toString('utf8'));
    });
}
module.exports = function(ctx, status, onModeChange) {
    function httpGet(address,pathname,timeout,cb){
        request(address,pathname,timeout,null,cb);
    }
    function load() {
        var old = ctx.config.get() || {}, values = {};
        fields.forEach(function(f){ values[f.key] = valid(f,old[f.key]) ? old[f.key] : f.default; });
        var effectKey={impact:'ImpactEffect',balanced:'BalancedEffect',music:'MusicEffect'}[values.AudioSampling];
        if(effectKey && old[effectKey]===undefined && old.AudioReaction===values.AudioReaction)values[effectKey]=values.AudioReaction;
        if (old.TopCount === undefined) {
            var total=values.Leds, ends=[0,172,269,441,538];
            ['Top','Right','Bottom','Left'].forEach(function(side,i){
                values[side+'Count']=Math.round(total*ends[i+1]/538)-Math.round(total*ends[i]/538);
            });
        }
        return values;
    }
    var discovery, current=load(), stopped=false, queue=Promise.resolve();
    var savedWledStates=(ctx.config.get()||{}).savedWledStates || {};
    function persist(values){
        var data={};
        Object.keys(values).forEach(function(k){data[k]=values[k];});
        data.savedWledStates=savedWledStates;
        ctx.config.set(data);
    }
    function serial(task){
        var work=queue.then(task);
        queue=work.catch(function(){});
        return work;
    }
    function stateRequest(address,patch){
        return new Promise(function(resolve,reject){
            request(address,'/json/state',4000,patch===null?null:JSON.stringify(patch),function(error,code,body){
                if(error || code<200 || code>=300)return reject(error||Error('WLED HTTP '+code));
                if(patch!==null)return resolve();
                try {resolve(JSON.parse(body));}catch(e){reject(e);}
            });
        });
    }
    function restoreWled(address){
        if(!Object.prototype.hasOwnProperty.call(savedWledStates,address))return Promise.resolve();
        // Only power was changed. WLED retains its effect and segment edits under realtime output.
        return stateRequest(address,{on:savedWledStates[address].on}).then(function(){
            delete savedWledStates[address];persist(current);
        });
    }
    function enterWled(address,brightness){
        if(!isRoutableIpv4(address))return Promise.resolve();
        return stateRequest(address,null).then(function(state){
            var patch={bri:Math.round(brightness*255/100)};
            if(state.on===false){
                savedWledStates[address]={on:false};
                persist(current); // Durable before the controller is changed.
                patch.on=true;
            }
            return stateRequest(address,patch);
        });
    }
    function applyWledBrightness(address,brightness){
        if(!isRoutableIpv4(address))return Promise.resolve();
        return stateRequest(address,{bri:Math.round(brightness*255/100)});
    }
    function switchWledOutput(previous,next){
        if(previous.Wled===next.Wled)return Promise.resolve();
        // Failed restores stay pending so an offline controller cannot lock out target switching.
        return restoreWled(previous.Wled).catch(function(){}).then(function(){return enterWled(next.Wled,next.Brightness);});
    }
    function json(res,value,code) {
        res.writeHead(code || 200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
    }
    var route=function(req,res,sub) {
        if (sub === 'ui' && req.method === 'GET') {
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
            res.end(fs.readFileSync(path.join(__dirname,'panel.html')));return true;
        }
        if (sub === 'settings' && req.method === 'GET') {
            current=load();
            json(res,{fields:fields,values:current});return true;
        }
        if (sub === 'discover' && req.method === 'POST') {
            if (!discovery) discovery = require('./discover')().then(function(devices) {
                discovery = null;
                return devices;
            }, function(error) { discovery = null; throw error; });
            discovery.then(function(devices) { json(res,{devices:devices}); },
                function(error) { json(res,{error:error.message},503); });
            return true;
        }
        if (sub === 'preview' && req.method === 'GET') {
            try {
                var liveState = status ? status() : null;
                if (liveState && (liveState.state === 'stopped' || liveState.state === 'waiting' || liveState.state === 'failed')) {
                    json(res,{rgb:''});return true;
                }
                var preview=path.join(ctx.dir,'runtime','preview.b64');
                var rgb='';
                if (fs.existsSync(preview)) {
                    var st = fs.statSync(preview);
                    if (Date.now() - st.mtime.getTime() <= 3000) rgb = fs.readFileSync(preview,'utf8').trim();
                }
                json(res,{rgb:/^[A-Za-z0-9+/]{192}$/.test(rgb) ? rgb : ''});
            } catch(e){json(res,{error:'Preview unavailable'},503);}
            return true;
        }
        if (sub === 'live' && req.method === 'GET') { json(res,status());return true; }
        if (sub === 'wled-probe' && req.method === 'POST') {
            readBody(req, 4096, res, function(probeBody) {
                try {
                    var address=JSON.parse(probeBody).address;
                    var field=fields.filter(function(item){return item.key==='Wled';})[0];
                    if(!valid(field,address) || !isRoutableIpv4(address))throw Error('Enter a valid non-loopback WLED IPv4 address');
                    httpGet(address,'/json/info',4000,function(error,code,body){
                        if(error)return json(res,{error:error.message||'No WLED response at '+address},400);
                        if(code<200||code>=300)return json(res,{error:'No WLED response at '+address},400);
                        try {
                            var info=JSON.parse(body);
                            json(res,{address:address,name:info.name||'WLED',leds:info.leds&&info.leds.count,version:info.ver||''});
                        } catch(e){json(res,{error:'Invalid WLED response'},400);}
                    });
                } catch(error) { json(res,{error:error.message},400); }
            }, function() { json(res,{error:'Probe payload too large'},413); });
            return true;
        }
        if (sub !== 'settings' || req.method !== 'POST') return false;
        readBody(req, 4096, res, function(body) {
            serial(function(){
                if(stopped)throw Error('Shard stopped');
                var patch=JSON.parse(body);
                if (!patch || Array.isArray(patch) || typeof patch!=='object')throw Error('Invalid settings');
                var next=load(), previous=current;
                Object.keys(patch).forEach(function(k){
                    var field=fields.filter(function(item){return item.key===k;})[0];
                    if(!field || !valid(field,patch[k]))throw Error('Invalid setting: '+k);
                    next[k]=patch[k];
                });
                if(next.Wled!=='127.0.0.1' && !isRoutableIpv4(next.Wled))throw Error('Invalid setting: Wled');
                next.Leds=next.TopCount+next.RightCount+next.BottomCount+next.LeftCount;
                if(next.Leds<1 || next.Leds>4096)throw Error('The four sides must total 1 to 4096 LEDs.');
                var explicitCounts=['TopCount','RightCount','BottomCount','LeftCount'].some(function(k){
                    return Object.prototype.hasOwnProperty.call(patch,k);
                });
                var probe=Promise.resolve();
                if(next.Wled!==previous.Wled && isRoutableIpv4(next.Wled) && !explicitCounts){
                    probe=new Promise(function(resolve){
                        httpGet(next.Wled,'/json/info',4000,function(error,code,text){
                            if(!error && code===200){
                                try {
                                    var leds=JSON.parse(text).leds, count=leds && leds.count;
                                    if(count===Math.floor(count) && count>=1 && count<=4096){
                                        var ends=[0,172,269,441,538];next.Leds=count;
                                        ['Top','Right','Bottom','Left'].forEach(function(side,i){
                                            next[side+'Count']=Math.round(count*ends[i+1]/538)-Math.round(count*ends[i]/538);
                                        });
                                    }
                                }catch(e){}
                            }
                            resolve();
                        });
                    });
                }
                return probe.then(function(){return switchWledOutput(previous,next);}).then(function(){
                    if(Object.prototype.hasOwnProperty.call(patch,'Brightness'))
                        return applyWledBrightness(next.Wled,next.Brightness);
                }).then(function(){
                    current=next;persist(next);
                    if(onModeChange)onModeChange(next,previous);
                    json(res,{values:next});
                });
            }).catch(function(error){json(res,{error:error.message},400);});
        }, function() { json(res,{error:'Settings payload too large'},413); });
        return true;
    };
    route.start=function(){
        stopped=false;persist(current);
        return serial(function(){
            return Object.keys(savedWledStates).reduce(function(chain,address){
                return address===current.Wled?chain:chain.then(function(){return restoreWled(address).catch(function(){});});
            },Promise.resolve()).then(function(){return enterWled(current.Wled);});
        });
    };
    route.stop=function(){
        stopped=true;
        return serial(function(){return restoreWled(current.Wled);});
    };
    return route;
};
