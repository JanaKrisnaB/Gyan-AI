import React, { useState, useRef, useEffect } from 'react';
import {
  Mic,
  Square,
  Upload,
  Volume2,
  FileAudio,
  AlertCircle,
  X,
} from 'lucide-react';
import { SupportedLanguage, TestCase } from '../types';
import { transcribeAudioChunk, playSpokenVoice } from '../services/api';

interface AudioRecorderProps {
  language: SupportedLanguage;
  onTranscriptComplete: (transcript: string) => void;
  isProcessing: boolean;
  setIsProcessing: (val: boolean) => void;
  stateLabel: string;
  setStateLabel: (val: string) => void;
  testCases?: TestCase[];
  onSelectTestCase?: (tc: TestCase) => void;
  initialTranscript?: string;
}

/**
 * Downsamples Float32 PCM frames from AudioContext sampleRate to 16000 Hz mono
 * and encodes a standalone 16-bit Linear PCM WAV Blob.
 * Returns null if the audio segment is near-complete silence.
 */
function encodePcmFramesTo16kWavBlob(
  frames: Float32Array[],
  sourceSampleRate: number
): Blob | null {
  let totalLength = 0;
  for (const f of frames) {
    totalLength += f.length;
  }
  if (totalLength === 0) return null;

  const merged = new Float32Array(totalLength);
  let offset = 0;
  let sumSquares = 0;
  for (const f of frames) {
    merged.set(f, offset);
    for (let i = 0; i < f.length; i++) {
      sumSquares += f[i] * f[i];
    }
    offset += f.length;
  }

  const rms = Math.sqrt(sumSquares / totalLength);
  // Skip completely silent segments so we don't send empty room noise
  if (rms < 0.0025) {
    return null;
  }

  const targetSampleRate = 16000;
  const ratio = sourceSampleRate / targetSampleRate;
  const outputSamples = Math.max(1, Math.floor(totalLength / ratio));
  const wavBuffer = new ArrayBuffer(44 + outputSamples * 2);
  const view = new DataView(wavBuffer);

  const writeAscii = (byteOffset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(byteOffset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + outputSamples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Linear PCM = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true); // Byte rate (16000 * 2)
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16 bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, outputSamples * 2, true);

  let outByteOffset = 44;
  for (let i = 0; i < outputSamples; i++) {
    const srcIdx = Math.min(totalLength - 1, Math.floor(i * ratio));
    const sample = Math.max(-1, Math.min(1, merged[srcIdx]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(outByteOffset, int16, true);
    outByteOffset += 2;
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  language,
  onTranscriptComplete,
  isProcessing,
  setIsProcessing,
  stateLabel,
  setStateLabel,
  testCases = [],
  onSelectTestCase,
  initialTranscript = '',
}) => {
  const [activeTab, setActiveTab] = useState<'record' | 'upload' | 'text' | 'samples'>('record');
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState(initialTranscript);
  const [confirmedLiveTranscript, setConfirmedLiveTranscript] = useState('');
  const [interimTailText, setInterimTailText] = useState('');
  const [parallelChunksCompleted, setParallelChunksCompleted] = useState(0);
  const [parallelChunksInFlight, setParallelChunksInFlight] = useState(0);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [previewingSampleId, setPreviewingSampleId] = useState<string | null>(null);
  const [levelBars, setLevelBars] = useState<number[]>(new Array(12).fill(12));
  const [transcribeStep, setTranscribeStep] = useState<'idle' | 'uploading' | 'transcribing' | 'ready'>('idle');

  // Sync when parent resets or loads a saved lecture
  useEffect(() => {
    setPartialTranscript(initialTranscript);
  }, [initialTranscript]);

  // Audio / Media recording & parallel STT refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const speechRecognitionRef = useRef<any>(null);
  const liveSpeechTranscriptRef = useRef<string>('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Rolling 5-second PCM buffer and ordered Gnani Prisma segment state
  const pcmRollingFramesRef = useRef<Float32Array[]>([]);
  const pcmRollingSampleCountRef = useRef<number>(0);
  const pcmSampleRateRef = useRef<number>(48000);
  const nextSegmentIndexRef = useRef<number>(0);
  const gnaniSegmentsMapRef = useRef<Map<number, string>>(new Map());
  const inFlightSegmentPromisesRef = useRef<Promise<void>[]>([]);
  const languageRef = useRef<SupportedLanguage>(language);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    return () => {
      stopRecordingCleanup();
    };
  }, []);

  const formatTime = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const rebuildOrderedLiveTranscript = () => {
    const entries = Array.from(gnaniSegmentsMapRef.current.entries()).sort(
      (a, b) => a[0] - b[0]
    );
    const joined = entries
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join(' ');
    setConfirmedLiveTranscript(joined);
    return joined;
  };

  const dispatchParallelPcmSegment = (framesToFlush: Float32Array[], sampleRate: number) => {
    const wavBlob = encodePcmFramesTo16kWavBlob(framesToFlush, sampleRate);
    if (!wavBlob) return;

    const segmentIndex = nextSegmentIndexRef.current;
    nextSegmentIndexRef.current += 1;
    setParallelChunksInFlight((c) => c + 1);

    const segmentPromise = (async () => {
      try {
        const res = await transcribeAudioChunk(
          new File([wavBlob], `live_segment_${segmentIndex + 1}.wav`, { type: 'audio/wav' }),
          languageRef.current,
          segmentIndex,
          99
        );
        const text = res?.transcript?.trim() || '';
        if (text) {
          gnaniSegmentsMapRef.current.set(segmentIndex, text);
          rebuildOrderedLiveTranscript();
          setParallelChunksCompleted((c) => c + 1);
          // Clear interim tail up to the newly locked Gnani segment
          setInterimTailText('');
        }
      } catch {
        // Individual parallel segment error is ignored; full audio fallback remains available
      } finally {
        setParallelChunksInFlight((c) => Math.max(0, c - 1));
      }
    })();

    inFlightSegmentPromisesRef.current.push(segmentPromise);
  };

  const startLevelMeterAndParallelStt = (stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioContextRef.current = ctx;
      pcmSampleRateRef.current = ctx.sampleRate || 48000;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Capture raw PCM frames and flush every 5 seconds to Gnani Prisma v3.0 in parallel
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      const fiveSecondSampleThreshold = pcmSampleRateRef.current * 5;

      processor.onaudioprocess = (audioEvent: AudioProcessingEvent) => {
        const inputData = audioEvent.inputBuffer.getChannelData(0);
        const copy = new Float32Array(inputData.length);
        copy.set(inputData);
        pcmRollingFramesRef.current.push(copy);
        pcmRollingSampleCountRef.current += copy.length;

        if (pcmRollingSampleCountRef.current >= fiveSecondSampleThreshold) {
          const batch = pcmRollingFramesRef.current;
          pcmRollingFramesRef.current = [];
          pcmRollingSampleCountRef.current = 0;
          dispatchParallelPcmSegment(batch, pcmSampleRateRef.current);
        }
      };

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevels = () => {
        animationFrameRef.current = requestAnimationFrame(updateLevels);
        analyser.getByteFrequencyData(dataArray);
        const nextBars: number[] = [];
        for (let i = 0; i < 12; i++) {
          const val = dataArray[i % dataArray.length] || 0;
          const pct = Math.max(12, Math.min(100, Math.round((val / 255) * 100)));
          nextBars.push(pct);
        }
        setLevelBars(nextBars);
      };

      updateLevels();
    } catch {
      // Quiet fallback if Web Audio context is restricted
    }
  };

  const stopRecordingCleanup = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
      } catch {}
      scriptProcessorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch {}
      speechRecognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setLevelBars(new Array(12).fill(12));
  };

  const handleStartRecording = async () => {
    setErrorMessage(null);
    setStatusNotice(null);
    setConfirmedLiveTranscript('');
    setInterimTailText('');
    setParallelChunksCompleted(0);
    setParallelChunksInFlight(0);
    setChunkCount(0);
    setRecordSeconds(0);
    setTranscribeStep('idle');

    liveSpeechTranscriptRef.current = '';
    pcmRollingFramesRef.current = [];
    pcmRollingSampleCountRef.current = 0;
    nextSegmentIndexRef.current = 0;
    gnaniSegmentsMapRef.current.clear();
    inFlightSegmentPromisesRef.current = [];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Microphone access is not available in this browser. Open this page over HTTPS or localhost, or use Upload audio.'
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
          setChunkCount((c) => c + 1);
        }
      };

      recorder.onstop = async () => {
        // 1. Flush any remaining sub-5s tail PCM frames (> 0.35s) into a final parallel Gnani STT request
        const remainingFrames = pcmRollingFramesRef.current;
        const remainingSamples = pcmRollingSampleCountRef.current;
        pcmRollingFramesRef.current = [];
        pcmRollingSampleCountRef.current = 0;

        if (remainingSamples > pcmSampleRateRef.current * 0.35) {
          dispatchParallelPcmSegment(remainingFrames, pcmSampleRateRef.current);
        }

        // Materialize full MediaRecorder fallback Blob before stopping tracks
        const rawAudio = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        let fullAudio = rawAudio;
        try {
          const buf = await rawAudio.arrayBuffer();
          fullAudio = new Blob([buf], { type: rawAudio.type || 'audio/webm' });
        } catch {}

        stopRecordingCleanup();
        setIsRecording(false);
        setIsProcessing(true);
        setTranscribeStep('transcribing');
        setStateLabel('Finalizing live Gnani Prisma v3.0 transcript...');

        // Wait for all parallel 5s chunks (plus the final tail chunk) to finish
        if (inFlightSegmentPromisesRef.current.length > 0) {
          await Promise.allSettled(inFlightSegmentPromisesRef.current);
        }

        const parallelAssembled = rebuildOrderedLiveTranscript();

        if (
          !parallelAssembled &&
          (!fullAudio || fullAudio.size === 0) &&
          !liveSpeechTranscriptRef.current.trim()
        ) {
          setIsProcessing(false);
          setTranscribeStep('idle');
          setStateLabel('Ready to record');
          setErrorMessage(
            'No audio was captured from your microphone. Check that your microphone is unmuted and try again.'
          );
          return;
        }

        try {
          let transcript = parallelAssembled;

          // If parallel segments did not produce text (e.g., very short recording), transcribe full audio Blob
          if (!transcript && fullAudio && fullAudio.size > 0) {
            try {
              const res = await transcribeAudioChunk(fullAudio, languageRef.current, 0, 1);
              transcript = res.transcript?.trim() || '';
              if (res.notice) {
                setStatusNotice(res.notice);
              }
            } catch (sttErr: any) {
              if (liveSpeechTranscriptRef.current && liveSpeechTranscriptRef.current.trim().length > 0) {
                transcript = liveSpeechTranscriptRef.current.trim();
              } else {
                throw sttErr;
              }
            }
          }

          if (!transcript && liveSpeechTranscriptRef.current && liveSpeechTranscriptRef.current.trim().length > 0) {
            transcript = liveSpeechTranscriptRef.current.trim();
          }

          if (!transcript) {
            throw new Error(
              'No speech was detected in the recording. Speak closer to the microphone or use "Write or paste notes".'
            );
          }

          setPartialTranscript(transcript);
          setTranscribeStep('ready');
          setStateLabel('Transcript ready. Generating notes and quiz...');
          onTranscriptComplete(transcript);
        } catch (err: any) {
          setErrorMessage(
            err.message || 'Audio transcription failed. Check your microphone or try uploading an audio file.'
          );
          setTranscribeStep('idle');
          setStateLabel('Transcription stopped');
        } finally {
          setIsProcessing(false);
        }
      };

      recorder.start(500);
      setIsRecording(true);
      setStateLabel('Recording live lecture');
      startLevelMeterAndParallelStt(stream);

      // Instant interim caption tail while speaking between 5s Gnani Prisma chunks
      if (typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        try {
          const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = language === 'hi' ? 'hi-IN' : language === 'ta' ? 'ta-IN' : 'en-IN';
          rec.onresult = (ev: any) => {
            let full = '';
            let latestResult = '';
            for (let i = 0; i < ev.results.length; i++) {
              const piece = ev.results[i][0].transcript;
              full += piece + ' ';
              if (i >= ev.resultIndex) {
                latestResult += piece + ' ';
              }
            }
            if (full.trim()) {
              liveSpeechTranscriptRef.current = full.trim();
            }
            if (latestResult.trim()) {
              setInterimTailText(latestResult.trim());
            }
          };
          rec.start();
          speechRecognitionRef.current = rec;
        } catch {
          // Parallel 5-second Gnani Prisma STT still runs regardless of browser SpeechRecognition
        }
      }

      timerIntervalRef.current = window.setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      let msg = err.message || 'Microphone could not be started.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Microphone is blocked. Allow microphone access in your browser settings and try again.';
      } else if (err.name === 'NotFoundError') {
        msg = 'No microphone was found on this device. Connect a microphone or upload an audio file instead.';
      }
      setErrorMessage(msg);
      setIsRecording(false);
      stopRecordingCleanup();
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      setStateLabel('Finalizing live transcript...');
      setIsProcessing(true);
      setTranscribeStep('transcribing');
      try {
        mediaRecorderRef.current.requestData();
      } catch {}
      mediaRecorderRef.current.stop();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    setErrorMessage(null);
    setStatusNotice(null);
    setIsProcessing(true);
    setTranscribeStep('uploading');
    setStateLabel(`Uploading "${file.name}"...`);

    try {
      setTranscribeStep('transcribing');
      setStateLabel(`Transcribing "${file.name}" with Gnani Prisma v3.0...`);
      const res = await transcribeAudioChunk(file, language, 0, 1);
      const text = res.transcript?.trim() || '';
      if (res.notice) {
        setStatusNotice(res.notice);
      }
      if (!text) {
        throw new Error(
          'No speech could be transcribed from this file. Check that the audio file contains clear speech.'
        );
      }
      setPartialTranscript(text);
      setIsProcessing(false);
      setTranscribeStep('ready');
      setStateLabel('Transcription complete');
      onTranscriptComplete(text);
    } catch (err: any) {
      setErrorMessage(
        err.message || 'Could not transcribe the uploaded audio file. Try a WAV or MP3 file with clear spoken voice.'
      );
      setIsProcessing(false);
      setTranscribeStep('idle');
      setStateLabel('Upload failed');
    } finally {
      e.target.value = '';
    }
  };

  // Compute line count for notebook left margin gutter (used in Write or paste notes tab)
  const wordCount = partialTranscript.trim()
    ? partialTranscript.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const lineCount = Math.max(8, Math.min(20, Math.ceil(wordCount / 9) + 2));

  const combinedLiveTranscript = [confirmedLiveTranscript, interimTailText]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    <section aria-label="Lecture capture and input" className="space-y-4">
      {/* Mode Selector Bar (44px minimum touch targets, sentence case) */}
      <div
        role="tablist"
        aria-label="Lecture input method"
        className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 bg-[#D8E0E8]/45 p-1 rounded-md border border-[#D8E0E8]"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'record'}
          disabled={isRecording || isProcessing}
          onClick={() => {
            setErrorMessage(null);
            setActiveTab('record');
          }}
          className={`min-h-[44px] px-3 py-2 text-xs sm:text-sm font-display-ui font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'record'
              ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
              : 'text-[#2C353E] hover:bg-white/60'
          }`}
        >
          Record lecture
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'upload'}
          disabled={isRecording || isProcessing}
          onClick={() => {
            setErrorMessage(null);
            setActiveTab('upload');
          }}
          className={`min-h-[44px] px-3 py-2 text-xs sm:text-sm font-display-ui font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'upload'
              ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
              : 'text-[#2C353E] hover:bg-white/60'
          }`}
        >
          Upload audio
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'text'}
          disabled={isRecording || isProcessing}
          onClick={() => {
            setErrorMessage(null);
            setActiveTab('text');
            setTimeout(() => textareaRef.current?.focus(), 50);
          }}
          className={`min-h-[44px] px-3 py-2 text-xs sm:text-sm font-display-ui font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'text'
              ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
              : 'text-[#2C353E] hover:bg-white/60'
          }`}
        >
          Write or paste notes
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'samples'}
          disabled={isRecording || isProcessing}
          onClick={() => {
            setErrorMessage(null);
            setActiveTab('samples');
          }}
          className={`min-h-[44px] px-3 py-2 text-xs sm:text-sm font-display-ui font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'samples'
              ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
              : 'text-[#2C353E] hover:bg-white/60'
          }`}
        >
          Sample lectures
        </button>
      </div>

      {/* Actionable Error Message */}
      {errorMessage && (
        <div
          role="alert"
          className="p-3.5 bg-white border border-[#B83A3A] rounded-md flex items-start justify-between gap-3 text-xs sm:text-sm text-[#2C353E]"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-[#B83A3A] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <p className="font-display-ui font-semibold text-[#B83A3A]">Audio capture issue</p>
              <p className="mt-0.5 leading-relaxed">{errorMessage}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss error message"
            onClick={() => setErrorMessage(null)}
            className="min-h-[44px] min-w-[44px] -m-1.5 flex items-center justify-center text-[#2C353E]/70 hover:text-[#2C353E] cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Upload / Transcribe Progress Bar */}
      {isProcessing && (
        <div
          role="status"
          aria-live="polite"
          className="p-4 bg-white border border-[#D8E0E8] rounded-md space-y-2.5"
        >
          <div className="flex items-center justify-between text-xs sm:text-sm font-display-ui">
            <span className="font-semibold text-[#1B365D]">{stateLabel}</span>
            <span className="tabular-nums text-[#2C353E]/75">
              {transcribeStep === 'uploading' ? 'Step 1 of 2' : 'Step 2 of 2'}
            </span>
          </div>
          <div className="w-full h-2 bg-[#F7F6F2] rounded-sm overflow-hidden border border-[#D8E0E8]">
            <div
              className="h-full bg-[#1B365D] transition-all duration-300"
              style={{ width: transcribeStep === 'uploading' ? '45%' : '85%' }}
            />
          </div>
          <p className="text-xs text-[#2C353E]/75">
            Converting audio to 16 kHz mono WAV and transcribing via Gnani Prisma v3.0.
          </p>
        </div>
      )}

      {/* TAB 1: Record Live Lecture with Parallel Gnani Prisma v3.0 Live Transcript */}
      {activeTab === 'record' && (
        <div className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden">
          <div className="border-b-2 border-[#B83A3A]/70 bg-[#F7F6F2]/50 px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isRecording ? 'bg-[#B83A3A]' : 'bg-[#1B365D]'
                }`}
                aria-hidden="true"
              />
              <span className="font-display-ui font-semibold text-xs sm:text-sm text-[#1B365D]">
                {isRecording
                  ? 'Recording & transcribing live with Gnani Prisma v3.0'
                  : 'Live classroom voice recorder'}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs font-display-ui text-[#2C353E]">
              {isRecording && (parallelChunksCompleted > 0 || parallelChunksInFlight > 0) && (
                <span className="tabular-nums text-[#1B365D] font-medium hidden sm:inline">
                  {parallelChunksInFlight > 0
                    ? `Transcribing segment (${parallelChunksCompleted} done)...`
                    : `${parallelChunksCompleted} ${
                        parallelChunksCompleted === 1 ? 'segment' : 'segments'
                      } transcribed`}
                </span>
              )}
              <span className="tabular-nums font-bold text-sm sm:text-base text-[#1B365D]">
                {formatTime(recordSeconds)}
              </span>
              {chunkCount > 0 && isRecording && (
                <span className="tabular-nums text-[#2C353E]/70 hidden md:inline">
                  {Math.floor(recordSeconds)}s captured
                </span>
              )}
            </div>
          </div>

          <div className="p-6 sm:p-8 flex flex-col items-center text-center space-y-5">
            {/* Live 12-Bar Audio Level Meter */}
            <div
              aria-label="Microphone audio level"
              className="flex items-end justify-center gap-1.5 h-12 px-5 py-2 bg-[#F7F6F2] border border-[#D8E0E8] rounded-md"
            >
              {levelBars.map((heightPct, idx) => (
                <span
                  key={idx}
                  className={`w-2 rounded-xs transition-transform duration-75 origin-bottom ${
                    isRecording ? 'bg-[#1B365D]' : 'bg-[#D8E0E8]'
                  }`}
                  style={{
                    height: '32px',
                    transform: `scaleY(${isRecording ? Math.max(0.18, heightPct / 100) : 0.25})`,
                  }}
                />
              ))}
            </div>

            <div className="max-w-lg space-y-1.5">
              <h2 className="font-display-ui font-bold text-base sm:text-lg text-[#1B365D]">
                {isRecording
                  ? 'Listening and transcribing in parallel...'
                  : 'Record a lecture in Hindi-English, Tamil-English, or English'}
              </h2>
              <p className="text-xs sm:text-sm text-[#2C353E]/80 leading-relaxed">
                {isRecording
                  ? 'Every 5 seconds of speech is transcribed live by Gnani Prisma v3.0 onto the ruled lines below.'
                  : 'Gnani Prisma v3.0 transcribes your spoken audio in parallel as you speak and generates a summary, key concepts, and a 5-question voice quiz.'}
              </p>
            </div>

            {/* Parallel Live Transcript Surface on Ruled Lines (Appears while recording or when live text is captured) */}
            {(isRecording || combinedLiveTranscript) && (
              <div
                role="region"
                aria-label="Live parallel lecture transcript"
                aria-live="polite"
                className="w-full max-w-2xl border border-[#D8E0E8] rounded-md overflow-hidden text-left bg-white"
              >
                <div className="px-4 py-2 bg-[#F7F6F2] border-b border-[#D8E0E8] flex items-center justify-between gap-2 text-xs font-display-ui">
                  <span className="font-semibold text-[#1B365D]">
                    Live transcript (Gnani Prisma v3.0)
                  </span>
                  <span className="text-[#2C353E]/70 tabular-nums">
                    {parallelChunksInFlight > 0
                      ? 'Syncing 5s audio chunk...'
                      : parallelChunksCompleted > 0
                      ? `${parallelChunksCompleted} ${
                          parallelChunksCompleted === 1 ? 'chunk' : 'chunks'
                        } locked in`
                      : 'Listening for first 5s segment...'}
                  </span>
                </div>
                <div className="grid grid-cols-[12px_1fr] min-h-[96px]">
                  <div className="notebook-ruled-area border-r border-[#B83A3A]" aria-hidden="true" />
                  <div className="notebook-ruled-area px-4 py-1">
                    {combinedLiveTranscript ? (
                      <p className="font-prose-indic text-sm sm:text-base leading-[32px]">
                        {confirmedLiveTranscript && (
                          <span className="text-[#1B365D] font-medium">
                            {confirmedLiveTranscript}{' '}
                          </span>
                        )}
                        {interimTailText && (
                          <span className="text-[#2C353E]/70">{interimTailText}</span>
                        )}
                      </p>
                    ) : (
                      <p className="font-prose-indic text-sm sm:text-base text-[#2C353E]/45 leading-[32px]">
                        Speak into your microphone — words will write onto these lines as Gnani Prisma transcribes each 5-second segment...
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Primary Record / Stop Control */}
            <div className="pt-2 w-full sm:w-auto">
              {!isRecording ? (
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleStartRecording}
                  className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-[#1B365D] hover:bg-[#142947] active:bg-[#0F213A] disabled:opacity-50 text-white font-display-ui font-semibold text-sm sm:text-base rounded-md inline-flex items-center justify-center gap-2.5 cursor-pointer shadow-xs"
                >
                  <Mic className="w-5 h-5" aria-hidden="true" />
                  <span>Start recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopRecording}
                  className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-[#B83A3A] hover:bg-[#9E2F2F] text-white font-display-ui font-semibold text-sm sm:text-base rounded-md inline-flex items-center justify-center gap-2.5 cursor-pointer shadow-xs"
                >
                  <Square className="w-4 h-4 fill-white" aria-hidden="true" />
                  <span>Stop and transcribe ({formatTime(recordSeconds)})</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Upload Audio File (Only upload box, no paste notebook) */}
      {activeTab === 'upload' && (
        <div className="bg-white border border-[#D8E0E8] rounded-md p-5 sm:p-6">
          <label
            htmlFor="lecture-audio-upload"
            className="w-full border border-dashed border-[#1B365D]/40 hover:border-[#1B365D] bg-[#F7F6F2]/60 rounded-md p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors"
          >
            <FileAudio className="w-9 h-9 text-[#1B365D] mb-2.5" aria-hidden="true" />
            <span className="font-display-ui font-semibold text-sm sm:text-base text-[#1B365D]">
              {selectedFileName ? selectedFileName : 'Select a lecture audio file from your phone or computer'}
            </span>
            <span className="text-xs text-[#2C353E]/75 mt-1 mb-5">
              WAV, MP3, WebM, M4A, or FLAC up to 100 MB — transcribed automatically via Gnani Prisma v3.0
            </span>
            <span className="min-h-[44px] px-5 py-2.5 bg-[#1B365D] text-white font-display-ui font-semibold text-xs sm:text-sm rounded-md inline-flex items-center gap-2">
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Choose audio file</span>
            </span>
            <input
              id="lecture-audio-upload"
              type="file"
              accept="audio/*,.mp3,.wav,.webm,.m4a,.ogg,.flac"
              onChange={handleFileUpload}
              disabled={isProcessing}
              className="sr-only"
            />
          </label>
        </div>
      )}

      {/* TAB 3: Write or Paste Notes — ONLY tab where the Ruled Lecture Notebook Page appears */}
      {activeTab === 'text' && (
        <div className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden">
          <div className="border-b-2 border-[#B83A3A]/70 bg-[#F7F6F2]/50 px-3 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  wordCount > 0 ? 'bg-[#1B365D]' : 'bg-[#D8E0E8]'
                }`}
                aria-hidden="true"
              />
              <span className="font-display-ui font-semibold text-xs sm:text-sm text-[#1B365D]">
                Lecture notebook page
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs font-display-ui text-[#2C353E]">
              <span className="tabular-nums text-[#2C353E]/75">
                {wordCount} {wordCount === 1 ? 'word' : 'words'}
              </span>
            </div>
          </div>

          {/* Ruled Notebook Page Body with Red Vertical Margin Line */}
          <div className="grid grid-cols-[40px_1fr] sm:grid-cols-[52px_1fr] min-h-[256px]">
            {/* Left Margin Gutter (Red vertical rule on right border) */}
            <div
              aria-hidden="true"
              className="notebook-ruled-area border-r border-[#B83A3A] select-none flex flex-col items-end pr-2 pt-[1px] text-[11px] font-display-ui text-[#2C353E]/40 tabular-nums"
            >
              {Array.from({ length: lineCount }).map((_, idx) => (
                <span key={idx} className="h-[32px] leading-[32px] block">
                  {idx + 1}
                </span>
              ))}
            </div>

            {/* Right Ruled Writing Surface */}
            <div className="notebook-ruled-area relative pl-3 sm:pl-5 pr-3 sm:pr-6">
              <label htmlFor="notebook-transcript-textarea" className="sr-only">
                Paste or write lecture notes
              </label>
              <textarea
                id="notebook-transcript-textarea"
                ref={textareaRef}
                rows={lineCount}
                value={partialTranscript}
                onChange={(e) => setPartialTranscript(e.target.value)}
                disabled={isProcessing}
                placeholder="Paste or type your lecture transcript or class notes onto these ruled lines..."
                className="w-full max-w-[72ch] bg-transparent border-0 focus:outline-none focus:ring-0 resize-y text-[15px] sm:text-base text-[#1B365D] placeholder:text-[#2C353E]/45 font-prose-indic leading-[32px] p-0 m-0"
                style={{ lineHeight: '32px' }}
              />
            </div>
          </div>

          {/* Notebook Page Footer Bar */}
          <div className="border-t border-[#D8E0E8] bg-[#F7F6F2]/70 px-3 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#2C353E]/80">
              {statusNotice ? (
                <span>{statusNotice}</span>
              ) : (
                <span>
                  Paste English, Hindi-English, or Tamil-English lecture notes to generate study material.
                </span>
              )}
            </div>

            <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
              {partialTranscript.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setPartialTranscript('');
                    setStatusNotice(null);
                  }}
                  disabled={isProcessing}
                  className="min-h-[44px] px-3 py-2 text-xs font-display-ui font-medium text-[#2C353E] hover:text-[#B83A3A] bg-white border border-[#D8E0E8] rounded-md cursor-pointer"
                >
                  Clear page
                </button>
              )}

              <button
                type="button"
                disabled={isProcessing || partialTranscript.trim().length === 0}
                onClick={() => onTranscriptComplete(partialTranscript.trim())}
                className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white text-xs sm:text-sm font-display-ui font-semibold rounded-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Generate notes and quiz
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Sample Lectures (Only sample list, no paste notebook) */}
      {activeTab === 'samples' && (
        <div className="bg-white border border-[#D8E0E8] rounded-md divide-y divide-[#D8E0E8]">
          <div className="px-4 py-3 bg-[#F7F6F2]/60">
            <h3 className="font-display-ui font-semibold text-sm text-[#1B365D]">
              Pre-recorded classroom lectures
            </h3>
            <p className="text-xs text-[#2C353E]/75 mt-0.5">
              Load a sample Tamil-English or Hindi-English lecture to test notes, audio explanations, and the voice quiz.
            </p>
          </div>
          {testCases.map((tc) => (
            <div key={tc.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1 max-w-xl">
                <div className="flex items-center gap-2 text-xs text-[#2C353E]/75">
                  <span className="font-display-ui font-medium text-[#1B365D]">{tc.language}</span>
                </div>
                <h4 className="font-display-ui font-semibold text-sm text-[#2C353E]">{tc.title}</h4>
                <p className="text-xs text-[#2C353E]/80 line-clamp-2 font-prose-indic">
                  {tc.raw_transcript}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  aria-label={`Listen to sample ${tc.title}`}
                  onClick={() => {
                    if (previewingSampleId === tc.id) {
                      setPreviewingSampleId(null);
                      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                        window.speechSynthesis.cancel();
                      }
                    } else {
                      setPreviewingSampleId(tc.id);
                      playSpokenVoice(tc.clean_transcript.slice(0, 160), tc.langCode, null, () => {
                        setPreviewingSampleId(null);
                      });
                    }
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer ${
                    previewingSampleId === tc.id
                      ? 'bg-[#1B365D] text-white border-[#1B365D]'
                      : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
                  }`}
                >
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  <span>{previewingSampleId === tc.id ? 'Stop audio' : 'Preview voice'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPartialTranscript(tc.raw_transcript);
                    if (onSelectTestCase) onSelectTestCase(tc);
                    else onTranscriptComplete(tc.raw_transcript);
                  }}
                  className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs font-display-ui font-semibold cursor-pointer whitespace-nowrap"
                >
                  Open lecture
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
