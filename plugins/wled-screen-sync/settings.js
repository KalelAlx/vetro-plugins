'use strict';
var fs = require('fs'), path = require('path');
var fields = require('./controls.json');
function valid(f, v) {
    if (f.type === 'toggle') return typeof v === 'boolean';
    if (f.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (f.options) return typeof v === 'string' && Object.prototype.hasOwnProperty.call(f.options,v);
    if (f.type === 'ipv4') return typeof v === 'string' && /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);
    if (f.choices) return f.choices.indexOf(v) >= 0;
    return typeof v === 'number' && v === Math.floor(v) && v >= f.min && v <= f.max;
}
module.exports = function(ctx, status) {
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
    var discovery;
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
            // The capture service and the dashboard can have separate /tmp mounts.
            // Read in the same execution context used for capture statistics.
            var readPreview = 'file=/tmp/ambilight-studio-preview; ' +
                'if [ -r "$file" ]; then modified=$(stat -c %Y "$file") || exit 1; ' +
                'age=$(($(date +%s)-modified)); ' +
                'if [ "$age" -ge 0 ] && [ "$age" -lt 4 ]; then cat "$file"; fi; fi';
            ctx.execute(readPreview,2000).then(function(result){
                if (result.exit_code || result.timed_out) return json(res,{error:'Preview read failed'},503);
                var rgb = (result.stdout || '').trim();
                json(res,{rgb:/^[A-Za-z0-9+/]{192}$/.test(rgb) ? rgb : ''});
            },function(){json(res,{error:'Preview unavailable'},503);});
            return true;
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
                next.Leds=next.TopCount+next.RightCount+next.BottomCount+next.LeftCount;
                if(next.Leds<1 || next.Leds>4096) throw Error('The four sides must total 1 to 4096 LEDs.');
                function save(){ctx.config.set(next);current=next;json(res,{values:current});}
                if(next.Lighting==='audio' && (current.Lighting!=='audio' || current.Wled!==next.Wled)){
                    var target='http://'+next.Wled;
                    ctx.execute('curl -fsS --max-time 3 '+target+'/json/eff',4000).then(function(result){
                        var names=JSON.parse(result.stdout);
                        var effect=names.indexOf('Freqwave');
                        if(effect<0) throw Error('This WLED controller does not advertise the Freqwave audio effect.');
                        var body=JSON.stringify({on:true,lor:0,seg:[{id:0,on:true,fx:effect}]});
                        return ctx.execute("curl -fsS --max-time 3 -H 'Content-Type: application/json' --data '"+body+"' "+target+'/json/state',4000);
                    }).then(function(result){
                        if(result.exit_code || result.timed_out || !JSON.parse(result.stdout).success) throw Error('WLED refused audio sync');
                        save();
                    }).catch(function(e){json(res,{error:e.message},400);});
                } else save();
            } catch(e){json(res,{error:e.message},400);}
        });
        return true;
    };
};
