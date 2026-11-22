'use strict';
var fs = require('fs'), path = require('path'), http = require('http');
var fields = require('./controls.json');
function valid(f, v) {
    if (f.type === 'toggle') return typeof v === 'boolean';
    if (f.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (f.options) return typeof v === 'string' && Object.prototype.hasOwnProperty.call(f.options,v);
    if (f.type === 'ipv4') return typeof v === 'string' && /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
    if (f.choices) return f.choices.indexOf(v) >= 0;
    return typeof v === 'number' && v === Math.floor(v) && v >= f.min && v <= f.max;
}
module.exports = function(ctx, status, onModeChange) {
    function httpGet(address,pathname,timeout,cb){
        var req=http.get({host:address,port:80,path:pathname,timeout:timeout},function(res){
            var body='',size=0;
            res.on('data',function(chunk){size+=chunk.length;if(size>65536){req.destroy();return;}body+=chunk.toString('utf8');});
            res.on('end',function(){cb(null,res.statusCode,body);});
        });
        req.on('timeout',function(){req.destroy(Error('WLED timed out'));});
        req.on('error',cb);
    }
    function httpPost(address,pathname,body,timeout,cb){
        var req=http.request({host:address,port:80,path:pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:timeout},function(res){
            var text='',size=0;
            res.on('data',function(chunk){size+=chunk.length;if(size>65536){req.destroy();return;}text+=chunk.toString('utf8');});
            res.on('end',function(){cb(null,res.statusCode,text);});
        });
        req.on('timeout',function(){req.destroy(Error('WLED timed out'));});
        req.on('error',cb);
        req.end(body);
    }
    function load() {
        var old = ctx.config.get() || {}, values = {};
        fields.forEach(function(f){ values[f.key] = valid(f,old[f.key]) ? old[f.key] : f.default; });
        if (old.TopCount === undefined) {
            var total=values.Leds, ends=[0,172,269,441,538];
            ['Top','Right','Bottom','Left'].forEach(function(side,i){
                values[side+'Count']=Math.round(total*ends[i+1]/538)-Math.round(total*ends[i]/538);
            });
        }
        return values;
    }
    var discovery, savedWledStates={};
    function streamsAudioOrPicture(mode){return mode==='screen'||mode==='screen-audio'||mode==='tv-audio';}
    function writeWled(address,state,callback){
        httpPost(address,'/json/state',JSON.stringify(state),4000,function(error,code,body){
            callback(!error&&code>=200&&code<300);
        });
    }
    function restoreWled(address,callback){
        var saved=savedWledStates[address];
        if(!saved)return callback();
        writeWled(address,saved,function(){delete savedWledStates[address];callback();});
    }
    function enterWled(address,callback){
        if(address==='127.0.0.1')return callback();
        if(savedWledStates[address])return writeWled(address,{on:true,seg:[{id:0,fx:0}]},function(){callback();});
        httpGet(address,'/json/state',4000,function(error,code,body){
            if(error||code<200||code>=300)return callback();
            try{
                var state=JSON.parse(body);
                if(!state||!Array.isArray(state.seg)||!state.seg.length)return callback();
                savedWledStates[address]={on:state.on,bri:state.bri,transition:0,seg:state.seg};
            }catch(e){return callback();}
            writeWled(address,{on:true,seg:[{id:0,fx:0}]},function(){callback();});
        });
    }
    function switchWledOutput(previous,next,callback){
        var wasStreaming=streamsAudioOrPicture(previous.Lighting), willStream=streamsAudioOrPicture(next.Lighting);
        var targetChanged=previous.Wled!==next.Wled;
        if(wasStreaming&&(!willStream||targetChanged))
            return restoreWled(previous.Wled,function(){
                if(willStream)enterWled(next.Wled,callback);else callback();
            });
        if(willStream&&(!wasStreaming||targetChanged))return enterWled(next.Wled,callback);
        callback();
    }

    var current = load();
    ctx.config.set(current);
    if(streamsAudioOrPicture(current.Lighting))enterWled(current.Wled,function(){});
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
                var preview=path.join(ctx.dir,'runtime','preview.b64');
                var rgb=fs.existsSync(preview)?fs.readFileSync(preview,'utf8').trim():'';
                json(res,{rgb:/^[A-Za-z0-9+/]{192}$/.test(rgb) ? rgb : ''});
            } catch(e){json(res,{error:'Preview unavailable'},503);}
            return true;
        }
        if (sub === 'live' && req.method === 'GET') { json(res,status());return true; }
        if (sub === 'wled-probe' && req.method === 'POST') {
            var probeBody='';
            req.on('data',function(chunk){probeBody+=chunk;});
            req.on('data',function(chunk){if(probeBody.length>4096)req.destroy();});
            req.on('end',function(){
                try {
                    var address=JSON.parse(probeBody).address;
                    var field=fields.filter(function(item){return item.key==='Wled';})[0];
                    if(!valid(field,address))throw Error('Enter a valid WLED IPv4 address');
                    httpGet(address,'/json/info',4000,function(error,code,body){
                        if(error)return json(res,{error:error.message||'No WLED response at '+address},400);
                        if(code<200||code>=300)return json(res,{error:'No WLED response at '+address},400);
                        try {
                            var info=JSON.parse(body);
                            json(res,{address:address,name:info.name||'WLED',leds:info.leds&&info.leds.count,version:info.ver||''});
                        } catch(e){json(res,{error:'Invalid WLED response'},400);}
                    });
                } catch(error) { json(res,{error:error.message},400); }
            });
            return true;
        }
        if (sub !== 'settings' || req.method !== 'POST') return false;
        var body='', size=0;
        req.on('data',function(chunk){size+=chunk.length;if(size<=4096)body+=chunk;});
        req.on('end',function(){
            if(size>4096)return json(res,{error:'Settings payload too large'},413);
            try {
                var patch=JSON.parse(body);
                if(!patch || Array.isArray(patch) || typeof patch!=='object')throw Error('Invalid settings');
                var next = load();
                Object.keys(patch).forEach(function(k){
                    var f=fields.filter(function(item){return item.key===k;})[0];
                    if (!f || !valid(f,patch[k]))throw Error('Invalid setting: '+k);
                    next[k]=patch[k];
                });
                next.Leds=next.TopCount+next.RightCount+next.BottomCount+next.LeftCount;
                if(next.Leds<1 || next.Leds>4096) throw Error('The four sides must total 1 to 4096 LEDs.');
                var save=function(){
                    var previous=current;
                    ctx.config.set(next);current=next;
                    if(onModeChange)onModeChange(next.Lighting,previous.Lighting);
                    json(res,{values:current});
                };
                var modeSave=function(){
                    var previous=current;
                    var refreshCounts=function(){
                        switchWledOutput(previous,next,save);
                    };
                    if(next.Wled===current.Wled)return refreshCounts();
                    httpGet(next.Wled,'/json/info',4000,function(error,code,response){
                        if(!error&&code>=200&&code<300){
                            try{
                                var info=JSON.parse(response), count=info.leds&&info.leds.count;
                                if(count&&count===Math.floor(count)&&count>=1&&count<=4096){
                                    next.Leds=count;
                                    var ends=[0,172,269,441,538];
                                    ['Top','Right','Bottom','Left'].forEach(function(side,i){
                                        next[side+'Count']=Math.round(count*ends[i+1]/538)-Math.round(count*ends[i]/538);
                                    });
                                }
                            }catch(e){}
                        }
                        refreshCounts();
                    });
                };
                modeSave();
            } catch(e){json(res,{error:e.message},400);}
        });
        return true;
    };
    route.stop=function(callback){
        if(streamsAudioOrPicture(current.Lighting))return restoreWled(current.Wled,callback);
        callback();
    };
    return route;
};
