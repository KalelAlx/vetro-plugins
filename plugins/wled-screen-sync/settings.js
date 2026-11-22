'use strict';
var fs = require('fs'), path = require('path');
var fields = require('./controls.json');
function valid(f, v) {
    if (f.options) return typeof v === 'string' && Object.prototype.hasOwnProperty.call(f.options,v);
    if (f.type === 'ipv4') return typeof v === 'string' && /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
    if (f.choices) return f.choices.indexOf(v) >= 0;
    return typeof v === 'number' && v === Math.floor(v) && v >= f.min && v <= f.max;
}
module.exports = function(ctx, status) {
    function load() {
        var old = ctx.config.get() || {}, values = {};
        fields.forEach(function(f){ values[f.key] = valid(f,old[f.key]) ? old[f.key] : f.default; });
        return values;
    }
    var current = load();
    ctx.config.set(current);
    function json(res,value,code) {
        res.writeHead(code || 200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
    }
    return function(req,res,sub) {
        if (sub === 'ui' && req.method === 'GET') {
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
            res.end(fs.readFileSync(path.join(__dirname,'panel.html')));return true;
        }
        if (sub === 'settings' && req.method === 'GET') {
            current=load();
            json(res,{fields:fields,values:current});return true;
        }
        if (sub === 'live' && req.method === 'GET') { json(res,status());return true; }
        if (sub === 'wled-probe' && req.method === 'POST') {
            var probeBody='';
            req.on('data',function(chunk){probeBody+=chunk;});
            req.on('end',function(){
                try {
                    var address=JSON.parse(probeBody).address;
                    var field=fields.filter(function(item){return item.key==='Wled';})[0];
                    if(!valid(field,address))throw Error('Enter a valid WLED IPv4 address');
                    ctx.execute('curl --connect-timeout 2 --max-time 4 -fsS http://'+address+'/json/info',5000)
                        .then(function(result){
                            if(result.exit_code || result.timed_out)throw Error('No WLED response at '+address);
                            var info=JSON.parse(result.stdout);
                            json(res,{address:address,name:info.name||'WLED',leds:info.leds&&info.leds.count,version:info.ver||''});
                        }).catch(function(error){json(res,{error:error.message},400);});
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
                ctx.config.set(next);current=next;json(res,{values:current});
            } catch(e){json(res,{error:e.message},400);}
        });
        return true;
    };
};
