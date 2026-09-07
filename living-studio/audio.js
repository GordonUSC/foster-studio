/* Browser-native musical component. No audio before an explicit user gesture.
 * const audio = new FosterAudioEngine({bpm:124,onStep:(step)=>paint(step)});
 * await audio.start(); audio.setStep('kick',4,true); await audio.doubleDrop();
 * audio.setMuted(true); audio.stop(); audio.dispose();
 * stop cancels scheduled notes AND the second drop; mute covers every sound.
 * Synth voices are illustrative, not hardware emulations. */
(function (root) {
  'use strict';
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,Number(v)||0));
  class FosterAudioEngine {
    constructor({bpm=124,volume=0.45,onStep=()=>{}}={}) {
      this.bpm=clamp(bpm,45,220); this.volume=clamp(volume,0,0.8);
      this.muted=false; this.onStep=onStep; this.context=null;
      this.voices=new Set(); this.timers=new Set(); this.playing=false;
      this.pattern={kick:[0,4,8,12],snare:[4,12],hat:[2,6,10,14],bass:[0,3,8,11],bell:[6,14]};
      this.step=0; this.bag=[]; this.lastDrop=null; this.dropUntil=0;
      this.transport=null; this.disposed=false; this.epoch=0;
    }
    async unlock() {
      if(this.disposed) throw new Error('This instrument has been disposed.');
      if(!this.context) {
        const AC=root.AudioContext||root.webkitAudioContext;
        if(!AC) throw new Error('Web Audio is unavailable in this browser.');
        const c=this.context=new AC();
        this.mix=c.createGain(); this.mix.gain.value=0.65;
        this.compressor=c.createDynamicsCompressor();
        Object.entries({threshold:-16,knee:12,ratio:12,attack:0.003,release:0.2}).forEach(([k,v])=>this.compressor[k].value=v);
        this.master=c.createGain(); this.master.gain.value=this.muted?0:this.volume;
        this.analyser=c.createAnalyser(); this.analyser.fftSize=1024;
        this.mix.connect(this.compressor); this.compressor.connect(this.master);
        this.master.connect(this.analyser); this.analyser.connect(c.destination);
      }
      if(this.context.state==='suspended') await this.context.resume();
      return this.context;
    }
    setVolume(value) { this.volume=clamp(value,0,0.8); this._gain(); }
    setMuted(value) { this.muted=!!value; this._gain(); }
    _gain() { if(this.master) this.master.gain.setTargetAtTime(this.muted?0:this.volume,this.context.currentTime,0.012); }
    setTempo(value) { if(this.context&&this.context.currentTime<this.dropUntil)return false;this.bpm=clamp(value,45,220);return true; }
    setStep(row,step,on) {
      if(!Object.hasOwn(this.pattern,row)) throw new Error('Unknown sequencer row');
      step=Math.floor(clamp(step,0,15));
      this.pattern[row]=this.pattern[row].filter(n=>n!==step);
      if(on) this.pattern[row].push(step);
    }
    loadPattern(pattern) {
      for(const row of Object.keys(this.pattern)) this.pattern[row]=Array.from(new Set((pattern[row]||[]).filter(n=>Number.isInteger(n)&&n>=0&&n<16)));
    }
    _later(fn,ms) { const id=setTimeout(()=>{this.timers.delete(id);fn();},ms);this.timers.add(id);return id; }
    _osc({frequency=220,type='sine',duration=0.5,gain=0.15,cutoff=2200,when,slide}={}) {
      const c=this.context; if(!c||this.voices.size>=48) return;
      const t=Math.max(c.currentTime,when??c.currentTime),o=c.createOscillator(),f=c.createBiquadFilter(),a=c.createGain();
      o.type=type; o.frequency.setValueAtTime(Math.max(20,frequency),t);
      if(slide) o.frequency.exponentialRampToValueAtTime(Math.max(20,slide),t+duration*0.8);
      f.type='lowpass'; f.frequency.value=cutoff; f.Q.value=1.2;
      a.gain.setValueAtTime(0.0001,t); a.gain.linearRampToValueAtTime(gain,t+0.008);
      a.gain.exponentialRampToValueAtTime(0.0001,t+duration);
      o.connect(f);f.connect(a);a.connect(this.mix);
      const voice={stop:()=>{try{o.stop();}catch(_){}},cleanup:()=>{o.disconnect();f.disconnect();a.disconnect();this.voices.delete(voice);}};
      this.voices.add(voice);o.onended=voice.cleanup;o.start(t);o.stop(t+duration+0.02);
    }
    _noise(when,duration=0.08,gain=0.1,highpass=6500) {
      const c=this.context;if(this.voices.size>=48)return;
      const t=Math.max(c.currentTime,when),s=c.createBufferSource(),f=c.createBiquadFilter(),a=c.createGain();
      const b=c.createBuffer(1,Math.ceil(c.sampleRate*duration),c.sampleRate),d=b.getChannelData(0);
      for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
      s.buffer=b;f.type='highpass';f.frequency.value=highpass;
      a.gain.setValueAtTime(gain,t);a.gain.exponentialRampToValueAtTime(0.0001,t+duration);
      s.connect(f);f.connect(a);a.connect(this.mix);
      const v={stop:()=>{try{s.stop();}catch(_){}},cleanup:()=>{s.disconnect();f.disconnect();a.disconnect();this.voices.delete(v);}};
      this.voices.add(v);s.onended=v.cleanup;s.start(t);s.stop(t+duration+0.02);
    }
    _hit(row,t,step) {
      if(row==='kick')this._osc({frequency:150,slide:42,duration:0.32,gain:0.55,when:t});
      if(row==='snare'){this._noise(t,0.16,0.19,1300);this._osc({frequency:185,duration:0.1,gain:0.12,when:t});}
      if(row==='hat')this._noise(t,0.055,0.1,6500);
      if(row==='bass')this._osc({frequency:55*Math.pow(2,[0,0,3,7][Math.floor(step/4)]/12),type:'sawtooth',cutoff:650,duration:0.24,gain:0.18,when:t});
      if(row==='bell'){this._osc({frequency:440,duration:0.6,gain:0.1,when:t});this._osc({frequency:1100,duration:0.23,gain:0.035,when:t});}
    }
    async note(midi=60,{duration=0.7,type='sine',cutoff=2400}={}) {
      const epoch=this.epoch;await this.unlock();if(epoch!==this.epoch)return;this._osc({frequency:440*Math.pow(2,(clamp(midi,21,108)-69)/12),duration:clamp(duration,0.05,5),type:['sine','square','triangle','sawtooth'].includes(type)?type:'sine',cutoff:clamp(cutoff,80,12000)});
    }
    async start() {
      const epoch=this.epoch;await this.unlock();if(epoch!==this.epoch||this.playing)return;this.playing=true;this.step=0;this.next=this.context.currentTime+0.04;
      const tick=()=>{
        if(!this.playing)return;
        // Skip missed clock time after a background-tab pause; never flood notes.
        if(this.next<this.context.currentTime-0.12)this.next=this.context.currentTime+0.02;
        while(this.next<this.context.currentTime+0.1){
          const step=this.step,t=this.next;
          for(const row of Object.keys(this.pattern))if(this.pattern[row].includes(step))this._hit(row,t,step);
          this._later(()=>{if(this.playing)this.onStep(step);},Math.max(0,(t-this.context.currentTime)*1000));
          this.next+=60/this.bpm/4;this.step=(step+1)%16;
        }
        this.transport=setTimeout(tick,25);
      };tick();
    }
    _character() {
      if(!this.bag.length)this.bag=['sub','reese','acid','square','glass','growl'].sort(()=>Math.random()-0.5);
      if(this.bag.length>1&&this.bag[this.bag.length-1]===this.lastDrop)[this.bag[0],this.bag[this.bag.length-1]]=[this.bag[this.bag.length-1],this.bag[0]];
      return this.lastDrop=this.bag.pop();
    }
    async doubleDrop() {
      const epoch=this.epoch;await this.unlock();if(epoch!==this.epoch)return {busy:false,cancelled:true};const c=this.context;
      if(c.currentTime<this.dropUntil)return {busy:true};
      const names=[this._character(),this._character()],beat=60/this.bpm;
      const first=this.playing?this.next:c.currentTime+0.025;
      const fire=(name,t,intensity)=>{
        this._osc({frequency:120,slide:28,duration:beat*1.8,gain:0.35,when:t});
        for(let i=0;i<4;i++)this._osc({frequency:41.2*(name==='glass'?4:name==='acid'?[1,1.5,2,1][i]:1)*(1+(name==='reese'?Math.random()*0.04:0)),type:name==='sub'||name==='glass'?'sine':name==='square'?'square':'sawtooth',duration:beat*(name==='reese'?0.8:0.45),gain:0.09*intensity,cutoff:name==='glass'?4200:name==='acid'?1800-i*350:name==='growl'?200+i*650:350+i*210,slide:name==='growl'?30+i*12:undefined,when:t+i*beat/2});
        this._noise(t,0.14,0.08,1800);
      };
      fire(names[0],first,0.85);fire(names[1],first+beat*4,1);
      this.dropUntil=first+beat*7;return {busy:false,characters:names,endsAt:this.dropUntil};
    }
    stop() {
      this.epoch++;this.playing=false;clearTimeout(this.transport);this.transport=null;
      for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
      for(const voice of Array.from(this.voices)){voice.stop();voice.cleanup();}
      this.dropUntil=0;this.step=0;this.onStep(-1);
    }
    async dispose() {this.stop();this.disposed=true;if(this.context&&this.context.state!=='closed')await this.context.close();}
  }
  root.FosterAudioEngine=FosterAudioEngine;
})(typeof window!=='undefined'?window:globalThis);
