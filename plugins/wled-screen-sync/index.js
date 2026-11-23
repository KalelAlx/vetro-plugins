'use strict';
module.exports = function(ctx) {
    var fs = require('fs'), path = require('path'), detail = {}, timer, busy = false, active = false, captureEnabled = true;
    var unit = 'vetro-ambilight-studio.service';
    var runtimeDir = path.join(ctx.dir,'runtime');
    var failures=0, nextCheck=0, startedAt=0, failedStarts=false, epoch=0, checks=Promise.resolve();
    function settings(){return ctx.config.get() || {};}
    function hasTarget(){var address=settings().Wled;return !!address && !/^127\./.test(address);}
    function shouldRun(){return active && captureEnabled && hasTarget();}
    function queue(job){
        var result=checks.then(job);
        checks=result.catch(function(){});
        return result;
    }
    function stopUnit(){return ctx.execute('systemctl stop '+unit,5000);}
    function resetBudget(){failures=0;startedAt=0;nextCheck=0;failedStarts=false;}
    function failure(message){
        startedAt=0;
        failures++;
        nextCheck=Date.now()+Math.min(60000,5000*Math.pow(2,failures-1));
        if(failures>=5){failedStarts=true;captureEnabled=false;}
        detail={stdout:failedStarts?'Capture helper failed five attempts. Press Start to retry.':message+'; retry delayed',state:failedStarts?'failed':'backoff'};
    }
    function quote(value){return "'"+String(value).replace(/'/g,"'\\''")+"'";}
    function ensureRuntimeDir(){
        var st;
        try {st=fs.lstatSync(runtimeDir);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(st){
            if(st.isSymbolicLink()||!st.isDirectory())throw Error('Unsafe runtime directory');
            if((st.mode & 511)!==448)fs.chmodSync(runtimeDir,448);
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
        if (readingHdr || !shouldRun() || settings().Lighting==="tv-audio") return;
        readingHdr = true;
        ctx.execute('busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl GetHdrStatus',2000).then(function(r){
            var m = /^[iyu]{2}\s+([01])\s+0\s*$/.exec(r.stdout || '');
            if (shouldRun() && settings().Lighting!=="tv-audio" && r.exit_code === 0 && m) {
                var old=''; try{old=fs.readFileSync(hdrFile,'utf8');}catch(e){}
                if(old!==m[1]){
                    fs.writeFileSync(hdrFile+'.tmp',m[1]);
                    fs.renameSync(hdrFile+'.tmp',hdrFile);
                }
            }
        }).catch(function(){}).then(function(){readingHdr=false;});
    }
    function check(){
        if(busy || !shouldRun() || Date.now()<nextCheck)return checks;
        busy=true;
        var generation=epoch;
        return queue(function(){
            if(generation!==epoch || !shouldRun())return;
            return ctx.execute('systemctl is-active '+unit+' || true',3000).then(function(r){
                if(generation!==epoch || !shouldRun())return;
                if(r.exit_code!==0)throw Error('Unit status unavailable');
                if((r.stdout||'').trim()==='active'){
                    if(startedAt && Date.now()-startedAt>=15000){failures=0;startedAt=0;}
                    detail=readRuntime();
                    return;
                }
                if(startedAt){failure('Helper exited during startup');return;}
                var exe=path.join(ctx.dir,'Colour.dll');
                var cmd='systemctl reset-failed '+unit+' 2>/dev/null; systemd-run --unit='+unit+' /usr/bin/dotnet '+quote(exe)+' --status-dir '+quote(runtimeDir);
                return ctx.execute(cmd,8000).then(function(start){
                    if(generation!==epoch || !shouldRun())return;
                    if(start.exit_code!==0){failure('Could not launch helper');return;}
                    startedAt=Date.now();detail={stdout:'Capture starting',state:'starting'};
                },function(){
                    if(generation===epoch && shouldRun())failure('Helper launch failed');
                });
            });
        }).catch(function(e){
            if(generation!==epoch)return;
            // A failed status query does not establish that the helper crashed.
            nextCheck=Date.now()+5000;
            detail={stdout:e.message,state:'checking'};
        }).then(function(){busy=false;});
    }
    function syncMode(next,previous){
        if(next.Wled===previous.Wled)return;
        if(!hasTarget()){
            epoch++;detail={stdout:'Select a WLED target',state:'waiting'};
            queue(stopUnit).catch(function(){});
        }else if(active && captureEnabled){resetBudget();check();}
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
                    epoch++;captureEnabled=false;resetBudget();detail={stdout:'Capture stopped',state:'stopped'};
                    queue(stopUnit).then(function(){json(res,{ok:true,state:'stopped'});},function(e){json(res,{error:e.message},500);});
                } else if(action==='start' || action==='restart'){
                    if(!active || !hasTarget())throw Error('Enable the Shard and select a WLED target first');
                    var generation=++epoch;
                    captureEnabled=true;resetBudget();
                    if(action==='restart'){
                        fs.writeFileSync(recoveryFile+'.tmp',String(Date.now()+8000));
                        fs.renameSync(recoveryFile+'.tmp',recoveryFile);
                    }
                    queue(function(){if(action==='restart' && generation===epoch)return stopUnit();}).then(function(){
                        if(generation===epoch)return check();
                    }).then(function(){json(res,{ok:generation===epoch && !failures,state:detail.state||'active'});},function(e){json(res,{error:e.message},500);});
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
        active=true;captureEnabled=true;resetBudget();
        return settingsRoute.start().catch(function(e){detail={stdout:e.message};}).then(function(){
            if(!active)return;
            if(!hasTarget())detail={stdout:'Select a WLED target',state:'waiting'};
            readHdr();hdrTimer=setInterval(readHdr,2000);timer=setInterval(check,5000);
            return hasTarget()?check():queue(stopUnit).catch(function(){});
        });
    },stop:function(){
        epoch++;active=false;captureEnabled=false;clearInterval(timer);clearInterval(hdrTimer);
        return queue(stopUnit).catch(function(){}).then(function(){return settingsRoute.stop();}).catch(function(e){
            detail={stdout:e.message,state:'restore-pending'};
        });
    },status:function(){return detail;}};
};
