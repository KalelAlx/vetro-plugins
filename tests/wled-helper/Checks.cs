using System;
using System.IO;
using System.Threading;
class Checks
{
    static void Require(bool value) { if (!value) throw new Exception("WLED helper regression"); }
    sealed class TestBinding : PlaybackBinding
    {
        public string Key = "original";
        public TestBinding() : base(null) {}
        internal override string Identity() { return Key; }
    }
    static void Identity(string root)
    {
        string card = Path.Combine(root,"card0");
        string file = Path.Combine(card,"pcm5c","info");
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(Path.Combine(card,"id"), "sdpaudio\n");
        string header = "card: 0\ndevice: 5\nstream: CAPTURE\n";
        foreach (var label in new[] { "id: 5\nname: ", "id: mic0 cap\nname: microphone",
            "id: pcm dump0 pcmdump0 codec-5\nname: microphone" })
        {
            File.WriteAllText(file, header + label);
            Require(TvAudioCapture.PlaybackDevice(root) == null);
        }
        File.WriteAllText(file,header + "id: pcm dump0 pcmdump0 codec-5\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root) == "hw:0,5");
        var binding = new TestBinding();
        Require(TvAudioCapture.PlaybackDevice(root,binding) == "hw:0,5");
        File.WriteAllText(file,header + "id: 5\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root,binding) == "hw:0,5");
        File.WriteAllText(file,header + "id: 5\nname: microphone");
        Require(TvAudioCapture.PlaybackDevice(root,binding) == null);
        File.WriteAllText(file,header + "id: 5\nname: ");
        binding.Key = "replacement";
        Require(TvAudioCapture.PlaybackDevice(root,binding) == null);
        File.Delete(file);
        file = Path.Combine(card,"pcm6c","info");
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(file,header.Replace("device: 5","device: 6")+"id: pcm dump1 pcmdump1 codec-6\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root) == "hw:0,6");
        File.WriteAllText(Path.Combine(card,"id"),"USBMic");
        Require(TvAudioCapture.PlaybackDevice(root) == null);
    }
    static void Ownership()
    {
        ManualResetEventSlim inside=new ManualResetEventSlim(), finish=new ManualResetEventSlim(), released=new ManualResetEventSlim();
        int starts=0, releases=0, captureThread=0;
        var worker=new PictureWorker(wanted => {
            captureThread=Thread.CurrentThread.ManagedThreadId;
            Interlocked.Increment(ref starts);inside.Set();finish.Wait();
            // Even a rapid off/on cannot cancel the previous owner's stop.
            if(starts==1)Require(!wanted());
        }, () => {
            Require(captureThread==Thread.CurrentThread.ManagedThreadId);
            Interlocked.Increment(ref releases);released.Set();
        });
        worker.Update(true);Require(inside.Wait(2000));
        worker.Update(false);worker.Update(true);
        Require(starts==1 && releases==0);
        finish.Set();Require(released.Wait(2000));
        Require(SpinWait.SpinUntil(()=>{worker.Update(true);return Volatile.Read(ref starts)>=2;},2000));
        worker.Update(false);
        Require(SpinWait.SpinUntil(()=>Volatile.Read(ref releases)>=2,2000));
    }
    static void CombinedDynamics()
    {
        Require(WledAmbiPpi.CombinedGain(0, 0, 0) == 1 && WledAmbiPpi.CombinedGain(1, 0, 0) == 1);
        Require(WledAmbiPpi.CombinedGain(0, 1, 1) == 0 && WledAmbiPpi.CombinedGain(0.55, 1, 1) == 1);
        Require(WledAmbiPpi.CombinedGain(0.4, 1, 1) > 0.8);
        var analyzer = new AudioAnalyzer();
        var config = new Tuning {AudioSensitivity=100, AudioResponse=160, AudioSampling="music"};
        var block = new byte[AudioAnalyzer.BlockBytes];
        double low=1, high=0;
        for (int n=0;n<1000;n++)
        {
            // Steady master with a modest bass accent every half second, then silence and one isolated hit.
            double amplitude=n<700 ? (n%50<12 ? 0.16 : 0.12) : n==990 ? 0.40 : 0;
            for(int i=0;i<AudioAnalyzer.Frames;i++)
            {
                short v=(short)(32767*amplitude*Math.Sin(2*Math.PI*100*i/48000));
                int k=i*4; block[k]=block[k+2]=(byte)v; block[k+1]=block[k+3]=(byte)(v>>8);
            }
            var frame=analyzer.Analyze(block, config);
            if(n>=500 && n<700){low=Math.Min(low,frame.PictureAccent);high=Math.Max(high,frame.PictureAccent);}
            if(n>=980)Require(frame.PictureAccent<0.05);
        }
        Require(high-low>0.15);
        Console.WriteLine("Combined music accent range {0:F2} to {1:F2}", low,high);
    }
    static void Main()
    {
        string tmp=Directory.CreateTempSubdirectory().FullName;
        try {CombinedDynamics();Identity(tmp);Ownership();Console.WriteLine("PASS device identity and single-owner capture lifecycle");}
        finally {Directory.Delete(tmp,true);}
    }
}
