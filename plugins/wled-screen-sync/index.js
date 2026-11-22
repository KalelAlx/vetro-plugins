'use strict';
module.exports = function(ctx) {
    var fs = require('fs'), path = require('path'), detail = {}, timer, busy = false, active = false, captureEnabled = true;
    var unit = 'vetro-ambilight-colour.service';
    var hdrFile = path.join(ctx.dir,'hdr-state'), recoveryFile = path.join(ctx.dir,'picture-recovery-until'), hdrTimer, readingHdr = false;
    function readHdr() {
        if (readingHdr || !active) return;
        readingHdr = true;
        ctx.execute('busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl GetHdrStatus',2000).then(function(r){
            var m = /^[iyu]{2}\s+([01])\s+0\s*$/.exec(r.stdout || '');
            if (active && r.exit_code === 0 && m) {
                fs.writeFileSync(hdrFile+'.tmp',m[1]);
                fs.renameSync(hdrFile+'.tmp',hdrFile);
            }
        }).catch(function(){}).then(function(){readingHdr=false;});
    }
    function check() {
        if (busy || !active || !captureEnabled) return;
        busy = true;
        var exe = path.join(ctx.dir,'Colour.exe');
        var command = 'if ! systemctl is-active --quiet '+unit+'; then systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit=vetro-ambilight-colour /usr/bin/dotnet '+exe+'; fi; systemctl is-active '+unit+'; cat /tmp/ambilight538-capture-rate 2>/dev/null || true';
        ctx.execute(command,8000).then(function(r){detail=r; if(!active) return ctx.execute('systemctl stop '+unit,5000);}).catch(function(e){detail={error:e.message};}).then(function(){busy=false;});
    }
    var settingsRoute = require("./settings.js")(ctx,function(){return detail;});
    function json(res,value,code) {
        res.writeHead(code || 200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
    }
    function route(req,res,sub) {
        if (sub === "ui") return settingsRoute(req,res,sub);
        if (sub !== 'capture-action' || req.method !== 'POST') return settingsRoute(req,res,sub);
        var body='',size=0;
        req.on('data',function(chunk){size+=chunk.length;if(size<=128)body+=chunk;});
        req.on('end',function(){
            try {
                if(size>128)throw Error('Invalid capture action');
                var action=JSON.parse(body).action;
                if(action==='stop'){
                    captureEnabled=false;detail={stdout:'Capture stopped',state:'stopped'};
                    ctx.execute('systemctl stop '+unit+'; systemctl is-active '+unit+' 2>/dev/null || true',8000).then(function(){json(res,{ok:true,state:'stopped'});},function(e){json(res,{error:e.message},500);});
                } else if(action==='start'){
                    if(!active)throw Error('Enable the Ambilight Shard first');
                    captureEnabled=true;
                    var exe=path.join(ctx.dir,'Colour.exe');
                    ctx.execute('if ! systemctl is-active --quiet '+unit+'; then systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+exe+'; fi; systemctl is-active '+unit,10000)
                        .then(function(r){json(res,{ok:r.exit_code===0,state:r.stdout.trim()});},function(e){json(res,{error:e.message},500);});
                } else if(action==='restart'){
                    if(!active)throw Error('Enable the Ambilight Shard first');
                    captureEnabled=true;
                    fs.writeFileSync(recoveryFile+'.tmp',String(Date.now()+8000));
                    fs.renameSync(recoveryFile+'.tmp',recoveryFile);
                    ctx.execute('if systemctl is-active --quiet '+unit+'; then systemctl restart '+unit+'; else systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+path.join(ctx.dir,'Colour.exe')+'; fi; systemctl is-active '+unit,12000)
                        .then(function(r){json(res,{ok:r.exit_code===0,state:r.stdout.trim(),pictureRecoveryMs:8000});},function(e){json(res,{error:e.message},500);});
                } else throw Error('Unknown capture action');
            } catch(e){json(res,{error:e.message},400);}
        });
        return true;
    }
    return {route:route,start:function(){
        fs.writeFileSync(path.join(ctx.dir,'Colour.exe'),new Buffer(fs.readFileSync(path.join(__dirname,'payload.b64'),'utf8'),'base64'));
        active=true;captureEnabled=true;readHdr();hdrTimer=setInterval(readHdr,2000);check();timer=setInterval(check,5000);
    },stop:function(){active=false;clearInterval(timer);clearInterval(hdrTimer);ctx.execute('systemctl stop '+unit,5000).catch(function(){});},status:function(){return detail;}};
};
