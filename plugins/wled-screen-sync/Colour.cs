using System;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;

internal static class WledAmbiPpi
{
    [DllImport("libvconf.so.0", EntryPoint="vconf_get_int", CharSet=CharSet.Ansi)]
    private static extern int VconfGetInt(string key, out int value);
    [DllImport("libdl.so.2", EntryPoint = "dlopen", CharSet = CharSet.Ansi)]
    private static extern IntPtr dlopen(string filename, int flags);
    [DllImport("libdl.so.2", EntryPoint = "dlsym", CharSet = CharSet.Ansi)]
    private static extern IntPtr dlsym(IntPtr handle, string symbol);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CondFn(IntPtr buf);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PosFn(int slot, int x, int y);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PixFn(int slot, IntPtr buf);
    private static PosFn _pos; private static PixFn _pix;
    private static int _slots, _blkW, _blkH, _sleepMs, _fullW, _fullH;
    private static IntPtr _colBuf;
    private static bool _ppiReady, _ppiDead;

    private static bool PpiVeInit()
    {
        if (_ppiReady) return true;
        if (_ppiDead) return false;   // lib nao tem a API nessa firmware: tenta uma vez so
        IntPtr lib = dlopen("/usr/lib/libvideoenhance.so", 2);
        if (lib == IntPtr.Zero) lib = dlopen("libvideoenhance.so", 1);
        if (lib == IntPtr.Zero) { Console.WriteLine("ppiVe: dlopen fail"); return false; }
        IntPtr fc = dlsym(lib, "cs_ve_get_rgb_measure_condition");
        IntPtr fp = dlsym(lib, "cs_ve_set_rgb_measure_position");
        IntPtr fx = dlsym(lib, "cs_ve_get_rgb_measure_pixel");
        if (fc == IntPtr.Zero || fp == IntPtr.Zero || fx == IntPtr.Zero)
        { _ppiDead = true; Console.WriteLine("ppiVe: dlsym fail (API ausente nesta firmware)"); return false; }
        IntPtr cb = Marshal.AllocHGlobal(256);
        Marshal.Copy(new byte[256], 0, cb, 256);
        int rc = Marshal.GetDelegateForFunctionPointer<CondFn>(fc)(cb);
        if (rc < 0) { Marshal.FreeHGlobal(cb); Console.WriteLine("ppiVe: cond rc=" + rc); return false; }
        _slots = Marshal.ReadInt32(cb, 0); _blkW = Marshal.ReadInt32(cb, 4);
        _blkH = Marshal.ReadInt32(cb, 8); _sleepMs = Marshal.ReadInt32(cb, 12);
        _fullW = Marshal.ReadInt32(cb, 16); _fullH = Marshal.ReadInt32(cb, 20);
        Marshal.FreeHGlobal(cb);
        if (_slots <= 0 || _fullW <= 0) { Console.WriteLine("ppiVe: bad cond"); return false; }
        if (_slots > 16) _slots = 16;
        if (_sleepMs < 1) _sleepMs = 20;
        _pos = Marshal.GetDelegateForFunctionPointer<PosFn>(fp);
        _pix = Marshal.GetDelegateForFunctionPointer<PixFn>(fx);
        _colBuf = Marshal.AllocHGlobal(256);
        _ppiReady = true;
        Console.WriteLine("ppiVe ready: slots=" + _slots + " block=" + _blkW + "x" + _blkH +
            " settle=" + _sleepMs + "ms full=" + _fullW + "x" + _fullH);
        return true;
    }

    // Test opposite borders on the uncropped panel. Keep the previous crop
    // through fades and require the same boundary on two different scan lines.
    private sealed class Border
    {
        private static readonly double[] Depth = {0.018, 0.065, 0.115, 0.155, 0.205, 0.255};
        public double Inset;
        private int depth, candidate = -1, votes, line;
        public void Probe(bool vertical)
        {
            double cross = line == 0 ? 0.36 : 0.64;
            int bright = 0, dark = 0;
            for (int first = 0; first < 2; first += _slots)
            {
                int count = Math.Min(_slots, 2 - first);
                for (int i = 0; i < count; i++)
                {
                    double pos = first+i == 0 ? Depth[depth] : 1-Depth[depth];
                    if (_pos(i,(int)((vertical ? cross : pos)*_fullW),(int)((vertical ? pos : cross)*_fullH)) < 0) return;
                }
                System.Threading.Thread.Sleep(_sleepMs);
                for (int i = 0; i < count; i++)
                {
                    if (_pix(i,_colBuf) < 0) return;
                    int peak = Math.Max(Marshal.ReadInt32(_colBuf),Math.Max(Marshal.ReadInt32(_colBuf,4),Marshal.ReadInt32(_colBuf,8))) >> 2;
                    if (peak <= 8) dark++;
                    if (peak >= 20) bright++;
                }
            }
            if (dark == 2 && depth+1 < Depth.Length) { depth++; return; }
            int observed = (depth == 0 ? bright > 0 : bright == 2) ? depth : -1;
            if (observed != candidate) { candidate = observed; votes = 0; }
            if (observed >= 0 && ++votes >= 2)
                Inset = observed == 0 ? 0 : Depth[observed];
            depth = 0;
            line ^= 1;
        }
    }
    private static readonly Border Rows = new Border(), Columns = new Border();

    private static readonly double[][] SpotFrac = new double[][] {
        new double[]{0.10,0.02}, new double[]{0.30,0.02}, new double[]{0.50,0.02}, new double[]{0.70,0.02}, new double[]{0.90,0.02},
        new double[]{0.98,0.15}, new double[]{0.98,0.50}, new double[]{0.98,0.85},
        new double[]{0.90,0.98}, new double[]{0.70,0.98}, new double[]{0.50,0.98}, new double[]{0.30,0.98}, new double[]{0.10,0.98},
        new double[]{0.02,0.85}, new double[]{0.02,0.50}, new double[]{0.02,0.15},
    };

    private static readonly int[] FullRegions = { 5, 3, 5, 3 };

    private static readonly int[] fallbackRgb = new int[SpotFrac.Length * 3];
    private static bool fallbackInitialized;
    private static volatile Tuning tuning = new Tuning();
    private static bool hdr;
    private static long pictureRecoveryUntil;
    private static string recoveryFile;
    private static readonly int[] FourSpots = {2,6,10,14};
    private static readonly int[] EightSpots = {1,3,5,7,9,11,13,15};
    private static readonly int[] FourRegions = {1,1,1,1}, EightRegions = {2,2,2,2};
    private static byte[] PpiVeFrame()
    {
        int n = tuning.Fallback;
        int[] indices = n==4 ? FourSpots : n==8 ? EightSpots : null;
        int[] counts = n==4 ? FourRegions : n==8 ? EightRegions : FullRegions;
        var rgb = fallbackRgb;
        for (int base_ = 0; base_ < n; base_ += _slots)
        {
            int cnt = Math.Min(_slots, n - base_);
            for (int s = 0; s < cnt; s++)
            {
                int x = (int)((Columns.Inset + SpotFrac[indices == null ? base_ + s : indices[base_ + s]][0] * (1 - 2 * Columns.Inset)) * _fullW);
                int y = (int)((Rows.Inset + SpotFrac[indices == null ? base_ + s : indices[base_ + s]][1] * (1 - 2 * Rows.Inset)) * _fullH);
                if (_pos(s, x, y) < 0) throw new InvalidOperationException("Position unavailable");
            }
            System.Threading.Thread.Sleep(_sleepMs);
            for (int s = 0; s < cnt; s++)
            {
                Marshal.Copy(new byte[256], 0, _colBuf, 256);
                if (_pix(s, _colBuf) < 0) throw new InvalidOperationException("Color unavailable");
                {
                    int i = base_ + s;
                    rgb[i * 3] = Marshal.ReadInt32(_colBuf, 0) >> 2;   // 10-bit -> 8-bit
                    rgb[i * 3 + 1] = Marshal.ReadInt32(_colBuf, 4) >> 2;
                    rgb[i * 3 + 2] = Marshal.ReadInt32(_colBuf, 8) >> 2;
                }
            }
            if (base_ + cnt == n || fallbackInitialized) {
                var mapped = MapRegions(rgb, counts);
                if(tuning.SampleMode=="whole") ApplyWholeStrip(mapped);
                if(tuning.SampleMode=="side") ApplySides(mapped);
                if(tuning.SampleMode=="accent" || tuning.SampleMode=="highlight")
                    SelectSideSamples(mapped, tuning.SampleMode=="accent");
                latest = mapped;
            }
        }
        fallbackInitialized = true;
        return latest;
    }

    private static byte[] MapRegions(int[] rgb, int[] spotN)
    {
        // Map the measured regions to their physical edge in strip order.
        var leds = new byte[LedCount * 3];
        int[] counts = { TopN, RightN, BottomN, LeftN };
        int sp = 0, li = 0;
        for (int e = 0; e < 4; e++)
        {
            for (int i = 0; i < counts[e]; i++)
            {
                int si = sp + Math.Min(spotN[e] - 1, i * spotN[e] / counts[e]);
                leds[li * 3] = (byte)rgb[si * 3]; leds[li * 3 + 1] = (byte)rgb[si * 3 + 1]; leds[li * 3 + 2] = (byte)rgb[si * 3 + 2];
                li++;
            }
            sp += spotN[e];
        }
        return leds;
    }

    private const int LedCount = TopN + RightN + BottomN + LeftN;
    private const int TopN = 172, RightN = 97, BottomN = 172, LeftN = 97;

    private static string frameStatus;
    private static uint pictureSignature;
    private static int pictureWidth, pictureHeight;
    private static int zoneSampleFrame;
    private static double inputChroma, averagedChroma;
    private static double planeMilliseconds;

    private static bool TryReadSourceType(out int source)
    {
        source=0;
        try { return VconfGetInt("memory/system/source_type",out source)==0 && source>=0; }
        catch { return false; }
    }

    private static readonly PictureBorder PictureRows = new PictureBorder();
    private static readonly PictureBorder PictureColumns = new PictureBorder();

    private sealed class PictureBorder
    {
        private int candidate, votes;
        public int Inset { get; private set; }

        public unsafe void Scan(byte* luma, int stride, int length, int crossLength, bool rows)
        {
            int observed = 0;
            for (int depth = 0; depth < length / 4; depth++)
            {
                int nearBright = 0, farBright = 0;
                for (int sample = 1; sample <= 15; sample++)
                {
                    int cross = sample * crossLength / 16;
                    int far = length - 1 - depth;
                    if (luma[rows ? depth * stride + cross : cross * stride + depth] > 24) nearBright++;
                    if (luma[rows ? far * stride + cross : cross * stride + far] > 24) farBright++;
                }
                if (nearBright >= 4 || farBright >= 4)
                {
                    if (depth > 1 && (nearBright < 4 || farBright < 4)) return;
                    observed = depth <= 1 ? 0 : depth;
                    if (Math.Abs(candidate - observed) > 2) { candidate = observed; votes = 0; }
                    if (++votes >= 3) Inset = candidate;
                    return;
                }
            }
        }
    }

    private static unsafe bool ReadPlane()
    {
        var frame = TizenAmbilight.VideoPlaneCapture.Capture();
        if (!frame.HasFrame || frame.RetWidth < 384 || frame.RetHeight < 216 || frame.RetWidth > 960 || frame.RetHeight > 540)
        {
            frameStatus = frame.Status;
            return false;
        }
        planeMilliseconds += frame.CaptureMs;
        pictureWidth = frame.W;
        pictureHeight = frame.H;
        byte* luma = (byte*)TizenAmbilight.VideoPlaneCapture.LumaBuffer.ToPointer();
        byte* chroma = (byte*)TizenAmbilight.VideoPlaneCapture.ChromaBuffer.ToPointer();
        bool cropRows = tuning.Bars == "both" || tuning.Bars == "rows";
        bool cropColumns = tuning.Bars == "both" || tuning.Bars == "columns";
        if (cropRows) PictureRows.Scan(luma, frame.YStride, frame.H, frame.W, true);
        if (cropColumns) PictureColumns.Scan(luma, frame.YStride, frame.W, frame.H, false);
        int left = cropColumns ? Math.Min(PictureColumns.Inset, frame.W / 4) : 0;
        int top = cropRows ? Math.Min(PictureRows.Inset, frame.H / 4) : 0;
        int width = frame.W - 2 * left, height = frame.H - 2 * top;
        uint fingerprint = 2166136261;
        for (int j=0;j<frame.YStride*frame.H;j+=251)
            fingerprint = unchecked((fingerprint ^ luma[j])*16777619);
        for (int j=0;j<frame.CStride*frame.H/2;j+=251)
            fingerprint = unchecked((fingerprint ^ chroma[j])*16777619);
        pictureSignature = fingerprint;
        bool measure = (++zoneSampleFrame % 32 == 0);
        var zoneColors = new byte[tuning.EffectiveZones * 3];
        var pixels = new byte[LedCount * 3];
        var sampleY = new int[4];
        var sampleU = new int[4];
        var sampleV = new int[4];
        long wholeY=0, wholeU=0, wholeV=0;
        for (int zone = 0; zone < tuning.EffectiveZones; zone++)
        {
            int i = zone * LedCount / tuning.EffectiveZones;
            bool horizontal = i < TopN || (i >= TopN + RightN && i < LedCount - LeftN);
            int x, y, dx = 0, dy = 0;
            if (i < TopN) { x = left + (2*i+1)*width/(2*TopN); y = top+1; dy = 1; }
            else if (i < TopN+RightN) { y = top+(2*(i-TopN)+1)*height/(2*RightN); x = left+width-2; dx = -1; }
            else if (horizontal) { x = left+width-1-(2*(i-TopN-RightN)+1)*width/(2*BottomN); y = top+height-2; dy = -1; }
            else { y = top+height-1-(2*(i-LedCount+LeftN)+1)*height/(2*LeftN); x = left+1; dx = 1; }
            int lum=0, u=0, v=0;
            for (int sample=0; sample<4; sample++)
            {
                int depth = sample*tuning.Depth/4;
                int px=x+dx*depth, py=y+dy*depth;
                int uv=(py/2)*frame.CStride+(px & ~1);
                int yValue=luma[py*frame.YStride+px];
                int uValue=chroma[uv], vValue=chroma[uv+1];
                sampleY[sample]=yValue;sampleU[sample]=uValue;sampleV[sample]=vValue;
                if (measure) inputChroma += Math.Sqrt((uValue-128)*(uValue-128)+(vValue-128)*(vValue-128));
            }
            AggregateSamples(sampleY,sampleU,sampleV,out lum,out u,out v);
            int l=298*(lum-64), cb=u-512, cr=v-512;
            if (measure) averagedChroma += Math.Sqrt(cb*cb+cr*cr);
            if(tuning.SampleMode=="whole") {
                wholeY+=lum; wholeU+=u; wholeV+=v;
                continue;
            }
            if (hdr)
            {
                // The reference patches established limited-range codes on this TV.
                int yy = Math.Max(0,Math.Min(255,(int)Math.Round((lum-64)*255.0/876)));
                int uu = 128+(int)Math.Round(cb*255.0/896);
                int vv = 128+(int)Math.Round(cr*255.0/896);
                TizenAmbilight.VideoPlaneCapture.YuvToRgb(yy,uu,vv,1,1,1,1,true,true,
                    out zoneColors[3*zone],out zoneColors[3*zone+1],out zoneColors[3*zone+2]);
            }
            else
            {
                zoneColors[3*zone]=Channel(l+459*cr);
                zoneColors[3*zone+1]=Channel(l-55*cb-136*cr);
                zoneColors[3*zone+2]=Channel(l+541*cb);
            }
        }
        if(tuning.SampleMode=="whole") {
            int lum=(int)((wholeY+tuning.EffectiveZones/2)/tuning.EffectiveZones);
            int u=(int)((wholeU+tuning.EffectiveZones/2)/tuning.EffectiveZones);
            int v=(int)((wholeV+tuning.EffectiveZones/2)/tuning.EffectiveZones);
            int l=298*(lum-64), cb=u-512, cr=v-512;
            byte red,green,blue;
            if(hdr) {
                int yy=Math.Max(0,Math.Min(255,(int)Math.Round((lum-64)*255.0/876)));
                int uu=128+(int)Math.Round(cb*255.0/896), vv=128+(int)Math.Round(cr*255.0/896);
                TizenAmbilight.VideoPlaneCapture.YuvToRgb(yy,uu,vv,1,1,1,1,true,true,out red,out green,out blue);
            } else {
                red=Channel(l+459*cr); green=Channel(l-55*cb-136*cr); blue=Channel(l+541*cb);
            }
            for(int i=0;i<LedCount;i++){pixels[i*3]=red;pixels[i*3+1]=green;pixels[i*3+2]=blue;}
            latest=pixels;
            frameStatus=frame.W+"x"+frame.H+" video plane";
            return true;
        }
        for (int i=0;i<LedCount;i++)
        {
            int src = (i * tuning.EffectiveZones / LedCount) * 3;
            pixels[3*i]=zoneColors[src];pixels[3*i+1]=zoneColors[src+1];pixels[3*i+2]=zoneColors[src+2];
        }
        if(tuning.SampleMode=="side") ApplySides(pixels);
        latest = pixels;
        frameStatus = frame.W + "x" + frame.H + " video plane";
        return true;
    }

    private static void AggregateSamples(int[] ys,int[] us,int[] vs,out int y,out int u,out int v)
    {
        bool accent = tuning.SampleMode == "accent";
        if (accent || tuning.SampleMode == "highlight")
        {
            int best = 0, bestScore = -1;
            for (int i = 0; i < ys.Length; i++) {
                int cb = us[i] - 128, cr = vs[i] - 128;
                int score = accent ? cb * cb + cr * cr : ys[i];
                if (score > bestScore) { bestScore = score; best = i; }
            }
            y = ys[best] * 4; u = us[best] * 4; v = vs[best] * 4;
            return;
        }
        if(tuning.SampleMode=="edge" || tuning.SampleMode=="inner")
        {
            int i=tuning.SampleMode=="edge"?0:3;
            y=ys[i]*4;u=us[i]*4;v=vs[i]*4;
            return;
        }
        if(tuning.SampleMode=="median")
        {
            y=Median4(ys[0],ys[1],ys[2],ys[3])*4;
            u=Median4(us[0],us[1],us[2],us[3])*4;
            v=Median4(vs[0],vs[1],vs[2],vs[3])*4;
            return;
        }
        if(tuning.SampleMode=="weighted")
        {
            y=(ys[0]*4+ys[1]*3+ys[2]*2+ys[3]+5)/10*4;
            u=(us[0]*4+us[1]*3+us[2]*2+us[3]+5)/10*4;
            v=(vs[0]*4+vs[1]*3+vs[2]*2+vs[3]+5)/10*4;
            return;
        }
        y=ys[0]+ys[1]+ys[2]+ys[3];
        u=us[0]+us[1]+us[2]+us[3];
        v=vs[0]+vs[1]+vs[2]+vs[3];
    }
    private static int Median4(int a,int b,int c,int d)
    {
        int low=Math.Min(Math.Min(a,b),Math.Min(c,d));
        int high=Math.Max(Math.Max(a,b),Math.Max(c,d));
        return (a+b+c+d-low-high+1)/2;
    }

    private static readonly int[] SideLengths = { TopN, RightN, BottomN, LeftN };
    // The fallback sampler has one depth per spot. Choose among spots on each side.
    private static void SelectSideSamples(byte[] pixels, bool accent)
    {
        int start = 0;
        foreach (int length in SideLengths) {
            int best = start, bestScore = -1;
            for (int i = start; i < start + length; i++) {
                int r = pixels[3*i], g = pixels[3*i+1], b = pixels[3*i+2];
                int score = accent ? Math.Max(r, Math.Max(g,b)) - Math.Min(r, Math.Min(g,b))
                                   : 54*r + 183*g + 19*b;
                if (score > bestScore) { bestScore = score; best = i; }
            }
            for (int i = start; i < start + length; i++)
                Buffer.BlockCopy(pixels, 3*best, pixels, 3*i, 3);
            start += length;
        }
    }
    private static void ApplySides(byte[] pixels)
    {
        int start = 0;
        foreach (int length in SideLengths) {
            for (int channel = 0; channel < 3; channel++) {
                int total = 0;
                for (int i = start; i < start + length; i++) total += pixels[3*i + channel];
                byte average = (byte)((total + length / 2) / length);
                for (int i = start; i < start + length; i++) pixels[3*i + channel] = average;
            }
            start += length;
        }
    }

    private static void ApplyWholeStrip(byte[] pixels)
    {
        int red=0,green=0,blue=0;
        for(int i=0;i<pixels.Length;i+=3){red+=pixels[i];green+=pixels[i+1];blue+=pixels[i+2];}
        int count=pixels.Length/3;
        byte r=(byte)((red+count/2)/count),g=(byte)((green+count/2)/count),b=(byte)((blue+count/2)/count);
        for(int i=0;i<pixels.Length;i+=3){pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;}
    }

    private static byte Channel(int scaled) { return (byte)Math.Max(0,Math.Min(255,(scaled+512)>>10)); }

    private static volatile byte[] latest;



    private static void Capture()
    {
        int scans = 0, changed = 0, phase = 0;
        TizenAmbilight.VideoPlaneCapture.SetRequestSize(960, 540);
        frameStatus = TizenAmbilight.VideoPlaneCapture.Init();
        bool available = frameStatus == null;
        double deadline = 0;
        var uptime = Stopwatch.StartNew();
        double retryMs = 0, nextHdrRead = 0;
        string hdrFile = System.IO.Path.Combine(AppContext.BaseDirectory,"hdr-state");
        recoveryFile = System.IO.Path.Combine(AppContext.BaseDirectory,"picture-recovery-until");
        int consecutiveFailures = 0, planeErrors = 0, fallbackErrors = 0;
        int sourceType=0, candidateSource=0, candidateVotes=0, nativeReopens=0;
        bool haveSource=TryReadSourceType(out sourceType);
        double nextSourcePoll=0, nextRecoveryReset=0, nextInitRetry=0;
        double longestReadMs = 0;
        var window = Stopwatch.StartNew();
        while (true)
        {
            var previous = latest;
            double started = uptime.Elapsed.TotalMilliseconds;
            if(started>=nextSourcePoll) {
                int observed;
                if(TryReadSourceType(out observed)) {
                    if(!haveSource) { sourceType=observed; haveSource=true; candidateVotes=0; }
                    else if(observed==sourceType) candidateVotes=0;
                    else if(candidateVotes>0 && observed==candidateSource) {
                        candidateVotes++;
                        if(candidateVotes>=2) {
                            int previousSource=sourceType;
                            sourceType=observed; candidateVotes=0;
                            frameStatus=TizenAmbilight.VideoPlaneCapture.Reset();
                            available=frameStatus==null;
                            nativeReopens++;
                            nextRecoveryReset=started+15000;
                            nextInitRetry=started+5000;
                            consecutiveFailures=0; fallbackInitialized=false; retryMs=0;
                            Console.WriteLine("TV source changed "+previousSource+" -> "+sourceType+"; reopened video-plane capture: "+(frameStatus??"ready"));
                        }
                    } else { candidateSource=observed; candidateVotes=1; }
                }
                nextSourcePoll=started+250;
            }
            if(!available && started>=nextInitRetry) {
                frameStatus=TizenAmbilight.VideoPlaneCapture.Init();
                available=frameStatus==null;
                nextInitRetry=started+5000;
            }
            if (started >= nextHdrRead)
            {
                var old = tuning;
                tuning = Tuning.Read(old);
                if (old.Fallback != tuning.Fallback || old.EffectiveZones != tuning.EffectiveZones) fallbackInitialized = false;
                TizenAmbilight.VideoPlaneCapture.HdrPeakNits = tuning.Reference;
                try {
                    long recoveryDeadline;
                    if(long.TryParse(System.IO.File.ReadAllText(recoveryFile).Trim(),out recoveryDeadline))
                        pictureRecoveryUntil=recoveryDeadline;
                    else pictureRecoveryUntil=0;
                } catch(System.IO.IOException) { pictureRecoveryUntil=0; }
                try { hdr = System.IO.File.ReadAllText(hdrFile).Trim() == "1"; }
                catch (System.IO.IOException) {}
                if(tuning.Hdr!="auto") hdr=tuning.Hdr=="on";
                if(tuning.Bars=="off" || tuning.Bars=="columns") Rows.Inset=0;
                if(tuning.Bars=="off" || tuning.Bars=="rows") Columns.Inset=0;
                nextHdrRead = started + 1000;
            }
            uint oldSignature = pictureSignature;
            bool samplerOnly = tuning.Source=="sampler";
            bool attempt = !samplerOnly && available && started >= retryMs;
            bool full = attempt && ReadPlane();
            if (attempt)
            {
                longestReadMs = Math.Max(longestReadMs, uptime.Elapsed.TotalMilliseconds - started);
                if (full) {
                    consecutiveFailures = 0; fallbackInitialized = false;
                    if(pictureRecoveryUntil!=0) {
                        pictureRecoveryUntil=0;
                        try { System.IO.File.Delete(recoveryFile); } catch(System.IO.IOException) {}
                    }
                }
                else
                {
                    planeErrors++;
                    consecutiveFailures++;
                    if(consecutiveFailures>=3 && started>=nextRecoveryReset) {
                        frameStatus=TizenAmbilight.VideoPlaneCapture.Reset();
                        available=frameStatus==null;
                        nativeReopens++;
                        nextRecoveryReset=started+15000;
                        nextInitRetry=started+5000;
                        retryMs=uptime.Elapsed.TotalMilliseconds+500;
                        Console.WriteLine("video-plane recovery reopen "+nativeReopens+": "+(frameStatus??"ready"));
                    }
                    double delay = consecutiveFailures < 3 ? 0 : 500;
                    retryMs = uptime.Elapsed.TotalMilliseconds + delay;
                }
            }
            bool pictureRecovery = pictureRecoveryUntil > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!full && !pictureRecovery && (samplerOnly || !available || consecutiveFailures >= 3))
            {
                try { latest = PpiVeFrame(); }
                catch (InvalidOperationException) { fallbackErrors++; }
            }
            bool difference = false;
            var colors = latest;
            for (int i = 0; i < colors.Length && !difference; i++)
                difference = colors[i] != previous[i];
            if (full ? oldSignature != pictureSignature : difference) changed++;
            if (!full && phase % 8 == 0 && (tuning.Bars=="both" || tuning.Bars=="rows")) Rows.Probe(true);
            if (!full && phase % 8 == 4 && (tuning.Bars=="both" || tuning.Bars=="columns")) Columns.Probe(false);
            phase = (phase + 1) % 8;
            deadline += 1000.0 / (full ? tuning.CaptureHz : 25);
            double remaining = deadline - uptime.Elapsed.TotalMilliseconds;
            if (remaining < -20) deadline = uptime.Elapsed.TotalMilliseconds;
            if (remaining > 0) System.Threading.Thread.Sleep((int)Math.Ceiling(remaining));
            scans++;
            if (window.ElapsedMilliseconds < 5000) continue;
            string status = String.Format("{0}, {1} slots at {2} ms, {7} regions, capture {3:F2}/s, changed {4:F2}/s, {8} output target, top/bottom inset {5:P1}, side inset {6:P1}, plane read {9:F1}ms",
                samplerOnly ? "Selected TV sampler" : frameStatus, _slots, _sleepMs, scans / window.Elapsed.TotalSeconds, changed / window.Elapsed.TotalSeconds, full ? (tuning.Bars=="both" || tuning.Bars=="rows" ? (double)PictureRows.Inset / pictureHeight : 0) : Rows.Inset, full ? (tuning.Bars=="both" || tuning.Bars=="columns" ? (double)PictureColumns.Inset / pictureWidth : 0) : Columns.Inset, full ? tuning.EffectiveZones : tuning.Fallback, tuning.SendHz, planeMilliseconds/scans);
            status += String.Format(", plane errors {0}, fallback errors {1}, longest read {2:F0} ms, UDP errors {3}",
                planeErrors, fallbackErrors, longestReadMs, System.Threading.Interlocked.CompareExchange(ref udpErrors,0,0));
            status += ", WLED " + tuning.Wled;
            status += ", TV input " + (haveSource ? sourceType.ToString() : "unknown") + ", capture reopens " + nativeReopens;
            status += full ? (hdr ? ", HDR10 PQ BT.2020" : ", SDR BT.709") : pictureRecovery ? ", trying full-picture recovery" : ", TV sampled RGB";
            status += ", saturation " + tuning.Saturation + "%, smoothing " + tuning.Smooth + " ms, sampling " + tuning.SampleMode;
            if (inputChroma > 0) status += String.Format(", zone chroma cancellation {0:F1}%",100*(1-averagedChroma/inputChroma));
            inputChroma = averagedChroma = 0;
            longestReadMs = 0;
            planeMilliseconds = 0;
            changed = 0;
            try { System.IO.File.WriteAllText("/tmp/ambilight-studio-rate", status); }
            catch (System.IO.IOException) {}
            scans = 0;
            window.Restart();
        }
    }

    private static int Main(string[] args)
    {
        tuning = Tuning.Read(tuning);
        if (!PpiVeInit()) return 1;
        latest = new byte[LedCount * 3];
        var current = Array.ConvertAll(latest, value => (double)value);
        var capture = new System.Threading.Thread(Capture) { IsBackground = true };
        capture.Start();
        var pixels = new byte[current.Length];
        var clock = Stopwatch.StartNew();
        double nextPreview = 0;
        double previous = 0;
        double next = 0;
        using (var udp = new UdpClient())
        {
            System.Net.IPEndPoint endpoint = null;
            string destination = null;
            while (true)
            {
                double now = clock.Elapsed.TotalMilliseconds;
                var config = tuning;
                if (config.Lighting=="audio") {
                    System.Threading.Thread.Sleep(100);
                    next=previous=clock.Elapsed.TotalMilliseconds;
                    continue;
                }
                double blend = config.Smooth==0 ? 1 : 1 - Math.Exp(-(now - previous) / config.Smooth);
                previous = now;
                var target = latest;
                for (int i = 0; i < pixels.Length; i++)
                {
                    current[i] += (target[i] - current[i]) * blend;
                    pixels[i] = (byte)Math.Round(current[i]);
                }
                if (config.Lighting != "screen") RenderManual(pixels,config,now);
                config.Apply(pixels);
                int port = config.Protocol=="dnrgb" ? 21324 : 4048;
                if (destination != config.Wled || endpoint.Port != port) { endpoint = new System.Net.IPEndPoint(System.Net.IPAddress.Parse(config.Wled),port); destination = config.Wled; }
                try {
                    bool previewDue = now >= nextPreview;
                    byte[] preview = previewDue ? new byte[48 * 3] : null;
                    SendDdp(udp, endpoint, pixels, config, preview);
                    if (previewDue) {
                        nextPreview = now + 1000;
                        try { System.IO.File.WriteAllText("/tmp/ambilight-studio-preview", Convert.ToBase64String(preview)); }
                        catch (System.IO.IOException) { }
                    }
                }
                catch (SocketException) { System.Threading.Interlocked.Increment(ref udpErrors); }
                next += 1000.0 / config.SendHz;
                double remaining = next - clock.Elapsed.TotalMilliseconds;
                if (remaining > 0) System.Threading.Thread.Sleep((int)Math.Ceiling(remaining));
                else next = clock.Elapsed.TotalMilliseconds;
            }
        }
    }
    private static void RenderManual(byte[] pixels,Tuning config,double now)
    {
        double phase = (now / (1000 * config.Period)) % 1;
        double pulse = config.Lighting=="breathe" ? 0.5-0.5*Math.Cos(2*Math.PI*phase) : 1;
        for (int i=0;i<LedCount;i++) {
            double gain=pulse;
            if(config.Lighting=="wave") gain=0.5+0.5*Math.Cos(2*Math.PI*(3.0*i/LedCount-phase));
            if(config.Lighting=="twinkle" || config.Lighting=="spark") {
                bool firefly=config.Lighting=="spark";
                double t=now/(config.Period*(firefly?900.0:250.0));
                int cell=firefly?i/6:i;
                t+=(cell*0.61803398875)%1;
                uint hash=unchecked((uint)(cell*374761393+(int)t*668265263));
                hash=unchecked((hash^(hash>>13))*1274126177u);
                double envelope=Math.Sin(Math.PI*(t-Math.Floor(t)));
                gain=(hash%100 < (firefly?24:14)) ? envelope*envelope : 0.025;
            }
            if(config.Lighting=="chase") {
                double distance=(phase-i/(double)LedCount+1)%1;
                gain=Math.Max(0,1-5*distance);
            }
            for(int ch=0;ch<3;ch++) pixels[3*i+ch]=(byte)Math.Round(((config.ManualRgb>>(16-8*ch))&255)*gain);
        }
    }
    private static int udpErrors;
    private static byte sequence = 1;

    private static void SendDdp(UdpClient udp, System.Net.IPEndPoint endpoint, byte[] rgb, Tuning config, byte[] preview)
    {
        const int ChannelsPerPacket = 1440;
        for (int offset = 0; offset < config.Leds * 3; offset += ChannelsPerPacket)
        {
            int count = Math.Min(ChannelsPerPacket, config.Leds * 3 - offset);
            if (count <= 0) break;
            bool last = offset + count == config.Leds * 3;
            bool raw = config.Protocol=="dnrgb";
            int header = raw ? 4 : 10;
            var packet = new byte[header + count];
            if(raw) {
                packet[0]=4; packet[1]=2;
                packet[2]=(byte)((offset/3)>>8); packet[3]=(byte)(offset/3);
            } else {
            packet[0] = (byte)(last ? 0x41 : 0x40);
            packet[1] = sequence;
            sequence = (byte)(sequence % 15 + 1);
            packet[2] = 0x0B;
            packet[3] = 1;
            packet[4] = (byte)(offset >> 24);
            packet[5] = (byte)(offset >> 16);
            packet[6] = (byte)(offset >> 8);
            packet[7] = (byte)offset;
            packet[8] = (byte)(count >> 8);
            packet[9] = (byte)count;
            }
            // Start at the bottom-left, then travel up the left edge.
            int corner = config.StartCorner=="top-left" ? 0 :
                config.StartCorner=="top-right" ? config.TopCount :
                config.StartCorner=="bottom-right" ? config.TopCount+config.RightCount :
                config.Leds-config.LeftCount;
            int firstOutputLed = offset / 3;
            for(int j=0;j<count;j+=3) {
                int sourceLed=(firstOutputLed+j/3)%config.Leds;
                int logical=config.Direction=="reverse" ? (corner+config.Offset-sourceLed+config.Leds*2)%config.Leds : (corner+config.Offset+sourceLed)%config.Leds;
                int position;
                if (logical < config.TopCount) position=logical*TopN/config.TopCount;
                else if ((logical-=config.TopCount) < config.RightCount) position=TopN+logical*RightN/config.RightCount;
                else if ((logical-=config.RightCount) < config.BottomCount) position=TopN+RightN+logical*BottomN/config.BottomCount;
                else position=TopN+RightN+BottomN+(logical-config.BottomCount)*LeftN/Math.Max(1,config.LeftCount);

                bool? enabled = position < TopN ? config.Top : position < TopN + RightN ? config.Right :
                    position < TopN + RightN + BottomN ? config.Bottom : config.Left;
                if (enabled != false) Buffer.BlockCopy(rgb,position*3,packet,header+j,3);
            }
            udp.Send(packet, packet.Length, endpoint);
            if (preview != null) {
                for (int i = 0; i < preview.Length / 3; i++) {
                    int index = (i * config.Leds / (preview.Length / 3)) * 3 - offset;
                    if (index >= 0 && index < count) Buffer.BlockCopy(packet, header + index, preview, i * 3, 3);
                }
            }
        }
    }

}
