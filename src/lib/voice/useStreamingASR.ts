import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

// --- Singleton State ---
let globalIsRecording = false;
let activeAudioContext: AudioContext | null = null;
let activeStream: MediaStream | null = null;
let activeProcessor: AudioWorkletNode | null = null;

// Pub/sub for React components
const subscribers = new Set<(isRecording: boolean) => void>();

function notifySubscribers() {
  subscribers.forEach(cb => cb(globalIsRecording));
}

// Global DOM updater
function appendResultToInput(text: string) {
  if (!text) return;
  const textarea = (document.querySelector(".copilotKitInput textarea") ||
    document.querySelector(".copilotKitChat textarea") ||
    document.querySelector("textarea")) as HTMLTextAreaElement | null;
  if (!textarea) return;

  const currentVal = textarea.value.trim();
  const newText = currentVal ? `${currentVal} ${text}` : text;

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(textarea, newText);
  } else {
    textarea.value = newText;
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  // Auto-focus the input and place cursor at the end so Enter key sends immediately
  textarea.focus();
  const len = textarea.value.length;
  textarea.setSelectionRange(len, len);
}

function encodeWAV(samples: Int16Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (view: DataView, offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); // 1 channel
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        view.setInt16(offset, samples[i], true);
    }

    return new Blob([view], { type: 'audio/wav' });
}

async function sendAudioChunk(samples: Int16Array) {
    if (samples.length === 0) return;
    try {
        const blob = encodeWAV(samples, 16000);
        const formData = new FormData();
        formData.append("file", blob, "audio.wav");
        
        const res = await fetch("/api/voice/transcribe", {
            method: "POST",
            body: formData
        });
        
        if (!res.ok) {
            console.error("Transcription error", await res.text());
            return;
        }
        
        const data = await res.json();
        if (data.text) {
            appendResultToInput(data.text);
        }
    } catch (e) {
        console.error("Failed to send audio chunk", e);
    }
}

let releaseMicLock: (() => void) | null = null;

async function startGlobalRecording(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
) {
  if (globalIsRecording) return;
  
  // Try to acquire cross-tab lock to prevent multiple tabs from using the mic
  if (navigator.locks) {
    let lockAcquired = false;
    navigator.locks.request('nango_mic_lock', { ifAvailable: true }, (lock) => {
      if (!lock) return;
      lockAcquired = true;
      return new Promise<void>((resolve) => {
        releaseMicLock = resolve;
      });
    }).catch(console.error);
    
    // Yield to let the lock callback execute
    await new Promise(r => setTimeout(r, 10));
    if (!lockAcquired) {
       toast.error("麦克风已在另一个标签页中开启，请先将其关闭。");
       return;
    }
  }

  try {
    const stream = await getUserMedia({ audio: true });
    activeStream = stream;

    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    activeAudioContext = new AudioContextClass({ sampleRate: 16000 });
    const source = activeAudioContext.createMediaStreamSource(stream);
    
    // Create AudioWorklet via Blob URL
    const workletCode = `
class VadProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Lower threshold for better mic sensitivity
        this.SILENCE_THRESHOLD = 0.005;
        this.silenceFrames = 0;
        this.speechDetected = false;
        this.pcmBuffer = [];
        this.bufferLength = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const channelData = input[0];

        let sum = 0;
        const pcmData = new Int16Array(channelData.length);
        for (let i = 0; i < channelData.length; i++) {
            sum += Math.abs(channelData[i]);
            let s = Math.max(-1, Math.min(1, channelData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const average = sum / channelData.length;

        this.pcmBuffer.push(pcmData);
        this.bufferLength += pcmData.length;

        if (average >= this.SILENCE_THRESHOLD) {
            this.speechDetected = true;
            this.silenceFrames = 0;
        } else {
            this.silenceFrames++;
        }

        // 100 frames = ~0.8s silence pause after speech
        const TARGET_SILENCE_FRAMES = 100;
        const MAX_BUFFER_SAMPLES = 240000; // 15 seconds max chunk

        const shouldFlushSilence = this.speechDetected && this.silenceFrames >= TARGET_SILENCE_FRAMES && this.bufferLength > 8000;
        const shouldFlushMax = this.bufferLength >= MAX_BUFFER_SAMPLES;

        if (shouldFlushSilence || shouldFlushMax) {
            const combined = new Int16Array(this.bufferLength);
            let offset = 0;
            for (const chunk of this.pcmBuffer) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            this.port.postMessage(combined);
            
            this.pcmBuffer = [];
            this.bufferLength = 0;
            this.silenceFrames = 0;
            this.speechDetected = false;
        } else if (!this.speechDetected && this.bufferLength > 8000) {
            // Discard pure background silence when no speech was ever detected
            const keepChunks = this.pcmBuffer.slice(-4);
            this.pcmBuffer = keepChunks;
            this.bufferLength = keepChunks.reduce((acc, c) => acc + c.length, 0);
        }

        return true;
    }
}
registerProcessor('vad-processor', VadProcessor);
`;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    
    await activeAudioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl); // cleanup

    activeProcessor = new AudioWorkletNode(activeAudioContext, 'vad-processor');
    
    activeProcessor.port.onmessage = (e) => {
        if (!globalIsRecording) return;
        const pcmData = e.data; // Int16Array
        sendAudioChunk(pcmData);
    };

    source.connect(activeProcessor);
    activeProcessor.connect(activeAudioContext.destination);

    globalIsRecording = true;
    notifySubscribers();

  } catch (err) {
    console.error("Failed to start recording", err);
    toast.error("Failed to access microphone or start recording.");
    stopGlobalRecording();
  }
}

function stopGlobalRecording() {
  globalIsRecording = false;
  
  if (activeProcessor) {
      activeProcessor.disconnect();
      activeProcessor = null;
  }

  if (activeAudioContext) {
      activeAudioContext.close();
      activeAudioContext = null;
  }

  if (activeStream) {
      activeStream.getTracks().forEach(track => track.stop());
      activeStream = null;
  }
  
  if (releaseMicLock) {
      releaseMicLock();
      releaseMicLock = null;
  }
  
  notifySubscribers();
}

export function forceStopStreamingASR() {
  stopGlobalRecording();
}

interface UseStreamingASRProps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

export function useStreamingASR({ 
  getUserMedia = typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) : undefined
}: UseStreamingASRProps) {
  const [isRecording, setIsRecording] = useState(globalIsRecording);

  useEffect(() => {
    subscribers.add(setIsRecording);
    
    return () => {
      subscribers.delete(setIsRecording);
    };
  }, []);

  const startRecording = useCallback(() => {
    if (!getUserMedia) {
      toast.error("Browser microphone API is not provided or unsupported.");
      return;
    }
    startGlobalRecording(getUserMedia);
  }, [getUserMedia]);

  const stopRecording = useCallback(() => {
    stopGlobalRecording();
  }, []);

  return { isRecording, startRecording, stopRecording };
}
