using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

[DataContract]
internal sealed class Tuning
{
    [DataMember(IsRequired=true)] public string Hdr = "auto";
    [DataMember(IsRequired=true)] public int Saturation = 100;
    [DataMember(IsRequired=true)] public int Brightness = 100;
    [DataMember(IsRequired=true)] public int Gamma = 100;
    [DataMember(IsRequired=true)] public int Reference = 203;
    [DataMember(IsRequired=true)] public int Black = 0;
    [DataMember(IsRequired=true)] public int Red = 100;
    [DataMember(IsRequired=true)] public int Green = 100;
    [DataMember(IsRequired=true)] public int Blue = 100;
    [DataMember(IsRequired=true)] public int Smooth = 125;
    [DataMember(IsRequired=true)] public int CaptureHz = 60;
    [DataMember(IsRequired=true)] public int SendHz = 62;
    [DataMember(IsRequired=true)] public string Source = "auto";
    [DataMember(IsRequired=true)] public int Fallback = 16;
    [DataMember(IsRequired=true)] public string Bars = "both";
    [DataMember(IsRequired=true)] public int Depth = 16;
    [DataMember(IsRequired=true)] public string SampleMode = "average";
    [DataMember(IsRequired=true)] public int Offset = 0;
    [DataMember(IsRequired=true)] public string Direction = "normal";
    [DataMember(IsRequired=true)] public string Wled = "127.0.0.1";
    [DataMember(IsRequired=true)] public int Leds = 538;
    [DataMember(IsRequired=true)] public int Zones = 512;
    [DataMember(IsRequired=true)] public string ZonesMode = "match";
    [DataMember] public string Lighting = "screen";
    [DataMember] public string Protocol = "ddp";
    [DataMember] public string ImpactEffect, BalancedEffect, MusicEffect, CustomDetector;
    [DataMember] public int CustomThreshold;
    public double AccentThreshold = 0.29;
    [DataMember] public string PictureImpactEffect, PictureBalancedEffect, PictureMusicEffect, PictureAudioReaction;
    [DataMember] public string AudioReaction = "spectrum";
    [DataMember] public int AudioSensitivity = 100;
    [DataMember] public int AudioBlend = 35;
    [DataMember] public string AudioSampling = "balanced";
    [DataMember] public int AudioResponse = 160;
    [DataMember] public bool? Top;
    [DataMember] public bool? Right;
    [DataMember] public bool? Bottom;
    [DataMember] public bool? Left;
    [DataMember] public int TopCount = 172;
    [DataMember] public int RightCount = 97;
    [DataMember] public int BottomCount = 172;
    [DataMember] public int LeftCount = 97;
    public bool HasTarget { get { return !Wled.StartsWith("127.", StringComparison.Ordinal); } }
    public int EffectiveZones { get { return ZonesMode=="match" ? Math.Min(538,Leds) : Zones; } }
    [DataMember(IsRequired=true)] public string StartCorner = "bottom-left";
    private byte[] redCurve, greenCurve, blueCurve;
    private static string lastJson;
    private static readonly string ConfigFile = Path.Combine(Path.GetDirectoryName(typeof(Tuning).Assembly.Location),"config.json");
    public static Tuning Read(Tuning previous)
    {
        try {
            string json=File.ReadAllText(ConfigFile);
            if (json==lastJson) return previous;
            using(var stream=new MemoryStream(Encoding.UTF8.GetBytes(json))) {
                var serializer=new DataContractJsonSerializer(typeof(Tuning));
                var t=(Tuning)serializer.ReadObject(stream);
                if (t.SendHz<5 || t.CaptureHz<5 || t.Depth<4 || t.Offset<0 || t.Offset>4095 || t.Leds<1 || t.Leds>4096 || t.Zones<4 || t.Zones>512 || (t.ZonesMode!="match" && t.ZonesMode!="custom") || string.IsNullOrEmpty(t.Wled)) return previous;
                if (t.TopCount < 0 || t.RightCount < 0 || t.BottomCount < 0 || t.LeftCount < 0 ||
                    Math.Max(Math.Max(t.TopCount, t.RightCount), Math.Max(t.BottomCount, t.LeftCount)) > t.Leds) return previous;
                if (t.TopCount+t.RightCount+t.BottomCount+t.LeftCount != t.Leds) return previous;
                if (String.IsNullOrEmpty(t.Lighting)) t.Lighting="screen";
                if (String.IsNullOrEmpty(t.AudioReaction)) t.AudioReaction="spectrum";
                t.AudioSensitivity=Math.Max(25,Math.Min(300,t.AudioSensitivity));
                t.AudioBlend=Math.Max(0,Math.Min(100,t.AudioBlend));
                t.AudioResponse=Math.Max(40,Math.Min(600,t.AudioResponse==0?160:t.AudioResponse));
                string pictureEffect=t.AudioSampling=="custom"?t.PictureAudioReaction:
                    t.AudioSampling=="impact"?t.PictureImpactEffect:t.AudioSampling=="music"?t.PictureMusicEffect:t.PictureBalancedEffect;
                if (t.AudioSampling=="custom") {
                    t.AudioSampling=t.CustomDetector;
                    t.AccentThreshold=Math.Max(10,Math.Min(90,t.CustomThreshold))/100.0;
                } else {
                    bool impact=t.AudioSampling=="impact", music=t.AudioSampling=="music";
                    t.AudioReaction=(impact?t.ImpactEffect:music?t.MusicEffect:t.BalancedEffect) ?? t.AudioReaction;
                    t.AudioSensitivity=100;
                    t.AudioResponse=impact?115:music?145:190;
                    t.AccentThreshold=impact?0.52:music?0.22:0.32;
                }
                if (t.Lighting=="screen-audio") t.AudioReaction=pictureEffect ?? "intensity";
                if (t.AudioSampling!="impact" && t.AudioSampling!="music") t.AudioSampling="balanced";
                t.redCurve=t.Curve(t.Red); t.greenCurve=t.Curve(t.Green); t.blueCurve=t.Curve(t.Blue);
                lastJson=json;
                return t;
            }
        } catch(IOException) { return previous; }
          catch(SerializationException) { return previous; }
    }
    private byte[] Curve(int gain)
    {
        var table=new byte[256];
        for(int i=0;i<256;i++)
            table[i]=(byte)Math.Min(255,Math.Round(255*Math.Pow(i/255.0,Gamma/100.0)*Brightness*gain/10000.0));
        return table;
    }
    public void Apply(byte[] rgb)
    {
        if(redCurve==null || (Black==0 && Brightness==100 && Gamma==100 && Red==100 && Green==100 && Blue==100 && Saturation==100))return;
        for(int i=0;i<rgb.Length;i+=3){
            int r=rgb[i],g=rgb[i+1],b=rgb[i+2];
            if(Math.Max(r,Math.Max(g,b))<=Black) {rgb[i]=rgb[i+1]=rgb[i+2]=0;continue;}
            int y=(54*r+183*g+19*b+128)>>8;
            rgb[i]=redCurve[Adjust(r,y)];rgb[i+1]=greenCurve[Adjust(g,y)];rgb[i+2]=blueCurve[Adjust(b,y)];
        }
    }
    // Audio palettes are deliberately authored with restrained hues. Apply
    // brightness, gamma and white balance, but leave image saturation tuning
    // out so a vivid screen setting cannot turn audio colors neon.
    public void ApplyAudio(byte[] rgb)
    {
        if(redCurve==null)return;
        for(int i=0;i<rgb.Length;i+=3){
            if(Math.Max(rgb[i],Math.Max(rgb[i+1],rgb[i+2]))<=Black){rgb[i]=rgb[i+1]=rgb[i+2]=0;continue;}
            rgb[i]=redCurve[rgb[i]];rgb[i+1]=greenCurve[rgb[i+1]];rgb[i+2]=blueCurve[rgb[i+2]];
        }
    }
    private int Adjust(int channel,int luma)
    {
        return Math.Max(0,Math.Min(255,(luma*100+(channel-luma)*Saturation+50)/100));
    }
}
