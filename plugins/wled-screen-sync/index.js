'use strict';
module.exports = function(ctx) {
    var fs = require('fs'), path = require('path'), detail = {}, timer, busy = false, active = false, captureEnabled = true;
    var unit = 'vetro-ambilight-studio.service';
    var runtimeDir = path.join(ctx.dir,'runtime');
    var failures = 0, nextCheck = 0;
    function quote(value){return "'"+String(value).replace(/'/g,"'\\''")+"'";}
    function ensureRuntimeDir(){
        if(fs.existsSync(runtimeDir)){
            var st=fs.lstatSync(runtimeDir);
            if(st.isSymbolicLink()||!st.isDirectory())throw Error('Unsafe runtime directory');
        } else fs.mkdirSync(runtimeDir,448);
    }
    function writeAsset(name,body){
        var tmp=path.join(ctx.dir,name+'.new'), target=path.join(ctx.dir,name);
        fs.writeFileSync(tmp,body);
        fs.renameSync(tmp,target);
    }
    function readRuntime(){
        try { if(!fs.existsSync(path.join(runtimeDir,'rate.txt'))) return {}; return {stdout:fs.readFileSync(path.join(runtimeDir,'rate.txt'),'utf8'),exit_code:0,timed_out:false}; } catch(e){return {stdout:'Capture status unavailable',exit_code:1,error:e.message};}
    }
    var hdrFile = path.join(ctx.dir,'hdr-state'), recoveryFile = path.join(ctx.dir,'picture-recovery-until'), hdrTimer, readingHdr = false;
    function readHdr() {
        if (readingHdr || !active) return;
        readingHdr = true;
        ctx.execute('busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl GetHdrStatus',2000).then(function(r){
            var m = /^[iyu]{2}\s+([01])\s+0\s*$/.exec(r.stdout || '');
            if (active && r.exit_code === 0 && m) {
                var old=''; try{old=fs.readFileSync(hdrFile,'utf8');}catch(e){}
                if(old!==m[1]){
                    fs.writeFileSync(hdrFile+'.tmp',m[1]);
                    fs.renameSync(hdrFile+'.tmp',hdrFile);
                }
            }
        }).catch(function(){}).then(function(){readingHdr=false;});
    }
    function check() {
        if (busy || !active) return;
        if(!captureEnabled) {
            ctx.execute('systemctl stop '+unit,5000).catch(function(){});
            detail={stdout:'Capture stopped',state:'stopped'};
            return;
        }
        var now=Date.now();
        if(now<nextCheck) { detail={stdout:'Helper start backed off',state:'backoff'}; return; }
        busy = true;
        var exe = path.join(ctx.dir,'Colour.dll');
        var command = 'if ! systemctl is-active --quiet '+unit+'; then systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+quote(exe)+' --status-dir '+quote(runtimeDir)+'; fi; systemctl is-active '+unit+'; true';
        ctx.execute(command,8000).then(function(r){
            if(!active || !captureEnabled) return ctx.execute('systemctl stop '+unit,5000);
            if(r.exit_code===0){failures=0;detail=readRuntime();}else{
                failures++; nextCheck=Date.now()+Math.min(60000,5000*Math.pow(2,Math.min(failures,4)));
                detail={stdout:'Helper unavailable; start retry backed off',state:'backoff',exit_code:r.exit_code};
            }
        }).catch(function(e){
            failures++; nextCheck=Date.now()+Math.min(60000,5000*Math.pow(2,Math.min(failures,4)));
            detail={error:e.message,state:'backoff'};
        }).then(function(){busy=false;});
    }
    function syncMode(mode,previous){
        captureEnabled=true;
        if(mode==='screen'||mode==='screen-audio'||mode==='tv-audio'){
            detail={stdout:'Capture starting',state:'starting'};
            if(active)check();
        } else {
            detail={stdout:'Screen capture stopped; '+mode+' output active',state:'effect-active'};
            if(active)check();
        }
    }
    var settingsRoute = require("./settings.js")(ctx,function(){return detail;},syncMode);
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
                    var exe=path.join(ctx.dir,'Colour.dll');
                    ctx.execute('if ! systemctl is-active --quiet '+unit+'; then systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+quote(exe)+' --status-dir '+quote(runtimeDir)+'; fi; systemctl is-active '+unit,10000)
                        .then(function(r){json(res,{ok:r.exit_code===0,state:r.stdout.trim()});},function(e){json(res,{error:e.message},500);});
                } else if(action==='restart'){
                    if(!active)throw Error('Enable the Ambilight Shard first');
                    captureEnabled=true;
                    fs.writeFileSync(recoveryFile+'.tmp',String(Date.now()+8000));
                    fs.renameSync(recoveryFile+'.tmp',recoveryFile);
                    var exe=path.join(ctx.dir,'Colour.dll');
                    ctx.execute('if systemctl is-active --quiet '+unit+'; then systemctl restart '+unit+'; else systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+quote(exe)+' --status-dir '+quote(runtimeDir)+'; fi; systemctl is-active '+unit,12000)
                        .then(function(r){json(res,{ok:r.exit_code===0,state:r.stdout.trim(),pictureRecoveryMs:8000});},function(e){json(res,{error:e.message},500);});
                } else throw Error('Unknown capture action');
            } catch(e){json(res,{error:e.message},400);}
        });
        return true;
    }
    return {route:route,start:function(){
        ensureRuntimeDir();
        writeAsset('Colour.dll',new Buffer(fs.readFileSync(path.join(__dirname,'payload.b64'),'utf8'),'base64'));
        writeAsset('Colour.runtimeconfig.json',fs.readFileSync(path.join(__dirname,'Colour.runtimeconfig.json'),'utf8'));
        writeAsset('Colour.deps.json',fs.readFileSync(path.join(__dirname,'Colour.deps.json'),'utf8'));
        active=true;captureEnabled=true;failures=0;nextCheck=0;readHdr();hdrTimer=setInterval(readHdr,2000);check();timer=setInterval(check,5000);
    },stop:function(){
        active=false;captureEnabled=false;clearInterval(timer);clearInterval(hdrTimer);
        return ctx.execute('systemctl stop '+unit,5000).catch(function(){});
    },status:function(){if(detail&&Object.prototype.hasOwnProperty.call(detail,'stdout'))return detail;return readRuntime();}};
};
