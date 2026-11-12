import React, { useState, useEffect, useRef } from 'react';
import {
  LectureAnalysis,
  SupportedLanguage,
  LectureAskResponse,
  WeakTopicItem,
} from '../types';
import {
  Volume2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Check,
  Mic,
  Square,
  X,
} from 'lucide-react';
import {
  playSpokenVoice,
  prefetchSpokenVoice,
  transcribeAudioChunk,
  askLectureQuestion,
} from '../services/api';

interface AnalysisViewerProps {
  analysis: LectureAnalysis;
  rawTranscript: string;
  language: SupportedLanguage;
  weakTopics?: WeakTopicItem[];
  onStartExplain: () => void;
  onStartQuiz: () => void;
  onStartWeakTopicRevision?: () => void;
  onSaveLecture?: () => void;
  isSavedFeedback?: boolean;
}

export const AnalysisViewer: React.FC<AnalysisViewerProps> = ({
  analysis,
  rawTranscript,
  language,
  weakTopics = [],
  onStartQuiz,
  onStartWeakTopicRevision,
  onSaveLecture,
  isSavedFeedback = false,
}) => {
  const [transcriptTab, setTranscriptTab] = useState<'clean' | 'raw'>('clean');
  // Audio step: -1 = summary, 0..N-1 = concept index
  const [playingStep, setPlayingStep] = useState<number | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const voiceControllerRef = useRef<{ stop: () => void } | null>(null);

  // "Missed Class" Voice Q&A State
  const [askPhase, setAskPhase] = useState<'idle' | 'listening' | 'checking' | 'answered'>('idle');
  const [askCheckingStep, setAskCheckingStep] = useState<'transcribing' | 'searching'>('transcribing');
  const [askRecordSeconds, setAskRecordSeconds] = useState<number>(0);
  const [liveSpokenQuestion, setLiveSpokenQuestion] = useState<string>('');
  const [typedQuestion, setTypedQuestion] = useState<string>('');
  const [showTypeQuestion, setShowTypeQuestion] = useState<boolean>(false);
  const [askResult, setAskResult] = useState<LectureAskResponse | null>(null);
  const [isAskAnswerSpeaking, setIsAskAnswerSpeaking] = useState<boolean>(false);
  const [askError, setAskError] = useState<string | null>(null);

  const askRecorderRef = useRef<MediaRecorder | null>(null);
  const askChunksRef = useRef<Blob[]>([]);
  const askStreamRef = useRef<MediaStream | null>(null);
  const askTimerRef = useRef<number | null>(null);
  const askSpeechRecRef = useRef<any>(null);
  const askLiveSpeechTextRef = useRef<string>('');
  const askVoiceControllerRef = useRef<{ stop: () => void } | null>(null);

  const totalConcepts = analysis.concepts.length;

  useEffect(() => {
    // Proactively prefetch the first quiz question, summary opening, and first concept in the background
    const toWarm: string[] = [];
    if (analysis.questions?.[0]?.q) {
      toWarm.push(`Question 1. ${analysis.questions[0].q}`);
    }
    if (analysis.questions?.[1]?.q) {
      toWarm.push(`Question 2. ${analysis.questions[1].q}`);
    }
    if (analysis.summary) {
      toWarm.push(`Lecture summary. ${analysis.summary}`);
    }
    if (analysis.concepts?.[0]) {
      toWarm.push(`${analysis.concepts[0].term}. ${analysis.concepts[0].explanation}`);
    }
    if (toWarm.length > 0) {
      prefetchSpokenVoice(toWarm, language);
    }

    return () => {
      stopAudio();
      stopAskVoice();
      cleanupAskRecording();
    };
  }, [analysis, language]);

  const stopAudio = () => {
    if (voiceControllerRef.current) {
      voiceControllerRef.current.stop();
      voiceControllerRef.current = null;
    }
    setIsPlayingAudio(false);
  };

  const stopAskVoice = () => {
    if (askVoiceControllerRef.current) {
      askVoiceControllerRef.current.stop();
      askVoiceControllerRef.current = null;
    }
    setIsAskAnswerSpeaking(false);
  };

  const cleanupAskRecording = () => {
    if (askTimerRef.current) {
      clearInterval(askTimerRef.current);
      askTimerRef.current = null;
    }
    if (askSpeechRecRef.current) {
      try {
        askSpeechRecRef.current.stop();
      } catch {}
      askSpeechRecRef.current = null;
    }
    if (askStreamRef.current) {
      askStreamRef.current.getTracks().forEach((t) => t.stop());
      askStreamRef.current = null;
    }
  };

  const formatTime = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const speakAskAnswer = (answerText: string) => {
    stopAudio();
    stopAskVoice();
    setIsAskAnswerSpeaking(true);
    const controller = playSpokenVoice(answerText, language, null, () => {
      setIsAskAnswerSpeaking(false);
    });
    askVoiceControllerRef.current = controller;
  };

  const submitQuestionToLecture = async (questionText: string) => {
    if (!questionText.trim()) return;
    stopAudio();
    stopAskVoice();
    setAskError(null);
    setAskPhase('checking');
    setAskCheckingStep('searching');

    try {
      const response = await askLectureQuestion({
        transcript: rawTranscript,
        clean_transcript: analysis.clean_transcript || rawTranscript,
        concepts: analysis.concepts || [],
        question: questionText.trim(),
        language,
      });

      setAskResult(response);
      setAskPhase('answered');
      speakAskAnswer(response.answer);
    } catch (err: any) {
      setAskError(
        err.message || 'Could not check the lecture transcript right now. Try asking again.'
      );
      setAskPhase('idle');
    }
  };

  const startAskVoiceQuestion = async () => {
    stopAudio();
    stopAskVoice();
    setAskError(null);
    setLiveSpokenQuestion('');
    setAskRecordSeconds(0);
    askLiveSpeechTextRef.current = '';
    askChunksRef.current = [];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Microphone access requires HTTPS or localhost. Use "Type question instead" below.'
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      askStreamRef.current = stream;

      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      askRecorderRef.current = recorder;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          askChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const rawBlob = new Blob(askChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        let detachedBlob = rawBlob;
        try {
          const buf = await rawBlob.arrayBuffer();
          detachedBlob = new Blob([buf], { type: rawBlob.type || 'audio/webm' });
        } catch {}

        cleanupAskRecording();

        setAskPhase('checking');
        setAskCheckingStep('transcribing');

        try {
          let recognizedQuestion = '';

          if (detachedBlob.size > 0) {
            try {
              const sttRes = await transcribeAudioChunk(detachedBlob, 'en', 0, 1);
              if (sttRes?.transcript?.trim()) {
                recognizedQuestion = sttRes.transcript.trim();
              }
            } catch (sttErr: any) {
              if (askLiveSpeechTextRef.current.trim()) {
                recognizedQuestion = askLiveSpeechTextRef.current.trim();
              } else {
                throw sttErr;
              }
            }
          }

          if (!recognizedQuestion && askLiveSpeechTextRef.current.trim()) {
            recognizedQuestion = askLiveSpeechTextRef.current.trim();
          }

          if (!recognizedQuestion) {
            throw new Error(
              'No spoken question was heard. Speak clearly into your microphone or type your question below.'
            );
          }

          await submitQuestionToLecture(recognizedQuestion);
        } catch (err: any) {
          setAskError(
            err.message ||
              'Could not transcribe your question. Try speaking again or type your question below.'
          );
          setAskPhase('idle');
        }
      };

      recorder.start(500);
      setAskPhase('listening');

      if (
        typeof window !== 'undefined' &&
        ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
      ) {
        try {
          const SpeechRec =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = 'en-IN';
          rec.onresult = (ev: any) => {
            let full = '';
            for (let i = 0; i < ev.results.length; i++) {
              full += ev.results[i][0].transcript + ' ';
            }
            if (full.trim()) {
              askLiveSpeechTextRef.current = full.trim();
              setLiveSpokenQuestion(full.trim());
            }
          };
          rec.start();
          askSpeechRecRef.current = rec;
        } catch {}
      }

      askTimerRef.current = window.setInterval(() => {
        setAskRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (err: any) {
      let msg =
        'Microphone is blocked. Allow microphone access in your browser settings or type your question below.';
      if (err.name === 'NotFoundError') {
        msg = 'No microphone was detected on this device. Type your question below.';
      }
      setAskError(msg);
      setShowTypeQuestion(true);
      setAskPhase('idle');
      cleanupAskRecording();
    }
  };

  const stopAskVoiceQuestion = () => {
    if (askRecorderRef.current && askRecorderRef.current.state !== 'inactive') {
      try {
        askRecorderRef.current.requestData();
      } catch {}
      askRecorderRef.current.stop();
    }
  };

  const playStepAudio = (stepIndex: number) => {
    stopAskVoice();
    stopAudio();
    setPlayingStep(stepIndex);
    setIsPlayingAudio(true);

    let textToSpeak = '';
    if (stepIndex === -1) {
      textToSpeak = `Lecture summary. ${analysis.summary}`;
    } else if (stepIndex >= 0 && stepIndex < totalConcepts) {
      const c = analysis.concepts[stepIndex];
      textToSpeak = `${c.term}. ${c.explanation}`;
    } else {
      setIsPlayingAudio(false);
      setPlayingStep(null);
      return;
    }

    // Prefetch the next concept in the background while the current section plays
    const nextIdx = stepIndex + 1;
    if (nextIdx >= 0 && nextIdx < totalConcepts) {
      const nextConcept = analysis.concepts[nextIdx];
      prefetchSpokenVoice([`${nextConcept.term}. ${nextConcept.explanation}`], language);
    }

    const controller = playSpokenVoice(textToSpeak, language, null, () => {
      if (stepIndex + 1 < totalConcepts) {
        playStepAudio(stepIndex + 1);
      } else {
        setIsPlayingAudio(false);
        setPlayingStep(null);
      }
    });
    voiceControllerRef.current = controller;
  };

  const handleTogglePlayAll = () => {
    if (isPlayingAudio) {
      stopAudio();
    } else {
      playStepAudio(playingStep !== null ? playingStep : -1);
    }
  };

  const handlePrevStep = () => {
    const cur = playingStep ?? -1;
    if (cur > -1) {
      playStepAudio(cur - 1);
    }
  };

  const handleNextStep = () => {
    const cur = playingStep ?? -1;
    if (cur + 1 < totalConcepts) {
      playStepAudio(cur + 1);
    }
  };

  const activeStepTitle =
    playingStep === -1
      ? 'Reading lecture summary'
      : playingStep !== null && analysis.concepts[playingStep]
      ? `Reading concept ${playingStep + 1} of ${totalConcepts}: ${analysis.concepts[playingStep].term}`
      : 'Listen to summary and key concepts';

  const suggestedQuestions = [
    ...(analysis.concepts.slice(0, 2).map((c) => `What did sir say about ${c.term}?`)),
    'Did this lecture cover quantum computing?',
  ];

  return (
    <div className="space-y-8 pb-8">
      {/* Sticky Reachable Audio Playback Bar — stays reachable while scrolling notes */}
      <div
        role="region"
        aria-label="Audio explanation player"
        className="sticky top-14 z-20 bg-white/95 backdrop-blur-xs border-y sm:border border-[#1B365D]/25 sm:rounded-md px-3.5 py-2.5 shadow-2xs flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <button
            type="button"
            onClick={handleTogglePlayAll}
            aria-label={isPlayingAudio ? 'Pause audio explanation' : 'Read notes aloud'}
            className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md font-display-ui font-semibold text-xs sm:text-sm flex items-center gap-2 shrink-0 cursor-pointer"
          >
            {isPlayingAudio ? (
              <>
                <Pause className="w-4 h-4 fill-white" aria-hidden="true" />
                <span>Pause audio</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" aria-hidden="true" />
                <span>Read notes aloud</span>
              </>
            )}
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handlePrevStep}
              disabled={playingStep === null || playingStep <= -1}
              aria-label="Previous section"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] disabled:opacity-40 cursor-pointer"
            >
              <SkipBack className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleNextStep}
              disabled={playingStep !== null && playingStep >= totalConcepts - 1}
              aria-label="Next section"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] disabled:opacity-40 cursor-pointer"
            >
              <SkipForward className="w-4 h-4" aria-hidden="true" />
            </button>
            {playingStep !== null && (
              <button
                type="button"
                onClick={() => playStepAudio(-1)}
                aria-label="Restart from summary"
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <span className="text-xs font-display-ui text-[#2C353E] truncate hidden sm:inline">
            {activeStepTitle}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {weakTopics.length > 0 && onStartWeakTopicRevision && (
            <button
              type="button"
              onClick={() => {
                stopAudio();
                stopAskVoice();
                onStartWeakTopicRevision();
              }}
              className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#B83A3A] border border-[#B83A3A] rounded-md text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
            >
              Revise {weakTopics.length} weak {weakTopics.length === 1 ? 'topic' : 'topics'}
            </button>
          )}
          {onSaveLecture && (
            <button
              type="button"
              onClick={onSaveLecture}
              className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#1B365D] border border-[#D8E0E8] rounded-md text-xs sm:text-sm font-display-ui font-medium flex items-center gap-1.5 cursor-pointer"
            >
              {isSavedFeedback ? (
                <>
                  <Check className="w-4 h-4 text-[#1B365D]" aria-hidden="true" />
                  <span>Lecture saved</span>
                </>
              ) : (
                <span>Save lecture</span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              stopAudio();
              stopAskVoice();
              onStartQuiz();
            }}
            className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
          >
            Start quiz
          </button>
        </div>
      </div>

      {/* FEATURE 1: Ask your lecture (Strictly grounded in lecture transcript) */}
      <section
        aria-labelledby="ask-your-lecture-heading"
        className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden"
      >
        <div className="p-5 sm:p-6 border-b border-[#D8E0E8] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1 max-w-[66ch]">
            <h2
              id="ask-your-lecture-heading"
              className="font-display-ui font-bold text-base sm:text-lg text-[#1B365D]"
            >
              Ask your lecture
            </h2>
            <p className="text-xs sm:text-sm text-[#2C353E]/80">
              Ask aloud to recall a detail from class — like "What did sir say about learning rate?" — and get a spoken answer strictly from this lecture's transcript.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {askPhase !== 'listening' ? (
              <button
                type="button"
                onClick={startAskVoiceQuestion}
                disabled={askPhase === 'checking'}
                className="min-h-[44px] px-4 py-2.5 bg-[#1B365D] hover:bg-[#142947] disabled:opacity-50 text-white rounded-md text-xs sm:text-sm font-display-ui font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Mic className="w-4 h-4" aria-hidden="true" />
                <span>Ask question by voice</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={stopAskVoiceQuestion}
                className="min-h-[44px] px-4 py-2.5 bg-[#B83A3A] hover:bg-[#9E2F2F] text-white rounded-md text-xs sm:text-sm font-display-ui font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-white" aria-hidden="true" />
                <span>Stop and ask lecture ({formatTime(askRecordSeconds)})</span>
              </button>
            )}
          </div>
        </div>

        <div className="p-5 sm:p-6 space-y-4">
          {/* Quick sample questions from this lecture for 1-tap classroom demo */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-display-ui text-[#2C353E]/70">
              Try asking:
            </span>
            {suggestedQuestions.map((sq, idx) => (
              <button
                key={idx}
                type="button"
                disabled={askPhase === 'listening' || askPhase === 'checking'}
                onClick={() => submitQuestionToLecture(sq)}
                className="min-h-[36px] px-3 py-1 bg-[#F7F6F2] hover:bg-[#D8E0E8]/45 border border-[#D8E0E8] rounded-md text-xs font-display-ui text-[#1B365D] cursor-pointer disabled:opacity-50"
              >
                "{sq}"
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowTypeQuestion((prev) => !prev)}
              className="min-h-[36px] px-2.5 py-1 text-xs font-display-ui font-medium text-[#1B365D] underline cursor-pointer"
            >
              {showTypeQuestion ? 'Hide text box' : 'Type question instead'}
            </button>
          </div>

          {/* Optional Typed Question Box */}
          {showTypeQuestion && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (typedQuestion.trim()) {
                  submitQuestionToLecture(typedQuestion);
                  setTypedQuestion('');
                }
              }}
              className="flex flex-col sm:flex-row gap-2.5 pt-1"
            >
              <label htmlFor="ask-lecture-typed-input" className="sr-only">
                Type a question about this lecture
              </label>
              <input
                id="ask-lecture-typed-input"
                type="text"
                value={typedQuestion}
                onChange={(e) => setTypedQuestion(e.target.value)}
                placeholder="e.g. What did sir say about learning rate?"
                className="flex-1 min-h-[44px] px-3.5 py-2 text-sm bg-[#F7F6F2] border border-[#D8E0E8] rounded-md text-[#2C353E] focus:border-[#1B365D]"
              />
              <button
                type="submit"
                disabled={!typedQuestion.trim() || askPhase === 'checking'}
                className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] disabled:opacity-50 text-white text-xs sm:text-sm font-display-ui font-semibold rounded-md cursor-pointer shrink-0"
              >
                Ask lecture
              </button>
            </form>
          )}

          {/* Actionable Error Notice */}
          {askError && (
            <div
              role="alert"
              className="p-3.5 bg-white border border-[#B83A3A] rounded-md text-xs sm:text-sm text-[#2C353E] flex items-start justify-between gap-3"
            >
              <span>{askError}</span>
              <button
                type="button"
                aria-label="Dismiss notice"
                onClick={() => setAskError(null)}
                className="min-h-[44px] min-w-[44px] -m-2 flex items-center justify-center text-[#2C353E]/70 hover:text-[#2C353E] cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Listening State */}
          {askPhase === 'listening' && (
            <div
              role="status"
              aria-live="polite"
              className="p-4 bg-[#F7F6F2] border border-[#B83A3A] rounded-md space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-display-ui font-semibold text-sm text-[#B83A3A]">
                  Listening to your question...
                </span>
                <span className="font-display-ui font-bold text-sm text-[#1B365D] tabular-nums">
                  {formatTime(askRecordSeconds)}
                </span>
              </div>
              <p className="text-sm text-[#2C353E] font-prose-indic">
                {liveSpokenQuestion || 'Ask aloud, e.g. "What did sir say about this topic?"'}
              </p>
            </div>
          )}

          {/* Checking State */}
          {askPhase === 'checking' && (
            <div
              role="status"
              aria-live="polite"
              className="p-4 bg-[#F7F6F2] border border-[#D8E0E8] rounded-md space-y-2.5"
            >
              <div className="flex items-center justify-between text-xs sm:text-sm font-display-ui">
                <span className="font-semibold text-[#1B365D]">
                  {askCheckingStep === 'transcribing'
                    ? 'Step 1 of 2: Transcribing your question with Gnani Prisma...'
                    : 'Step 2 of 2: Checking the lecture transcript for the answer...'}
                </span>
                <span className="tabular-nums text-[#2C353E]/75">
                  {askCheckingStep === 'transcribing' ? '50%' : '90%'}
                </span>
              </div>
              <div className="w-full h-2 bg-white border border-[#D8E0E8] rounded-xs overflow-hidden">
                <div
                  className="h-full bg-[#1B365D] transition-all duration-300"
                  style={{ width: askCheckingStep === 'transcribing' ? '50%' : '90%' }}
                />
              </div>
            </div>
          )}

          {/* Grounded Answer Display */}
          {askPhase === 'answered' && askResult && (
            <div
              role="region"
              aria-label="Answer from lecture transcript"
              className={`p-4 sm:p-5 rounded-md border space-y-3 ${
                askResult.covered_in_lecture
                  ? 'bg-[#F7F6F2] border-[#1B365D]'
                  : 'bg-white border-[#B83A3A]'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <span
                    className={`text-xs font-display-ui font-semibold ${
                      askResult.covered_in_lecture ? 'text-[#1B365D]' : 'text-[#B83A3A]'
                    }`}
                  >
                    {askResult.covered_in_lecture
                      ? 'Answered strictly from this lecture transcript'
                      : 'Topic not covered in this lecture'}
                  </span>
                  <p className="text-xs sm:text-sm text-[#2C353E] font-display-ui">
                    <strong>You asked: </strong>"{askResult.english_question}"
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (isAskAnswerSpeaking) {
                      stopAskVoice();
                    } else {
                      speakAskAnswer(askResult.answer);
                    }
                  }}
                  className={`min-h-[44px] px-3 py-1.5 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer ${
                    isAskAnswerSpeaking
                      ? 'bg-[#1B365D] text-white border-[#1B365D]'
                      : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
                  }`}
                >
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  <span>{isAskAnswerSpeaking ? 'Stop reading' : 'Read answer aloud'}</span>
                </button>
              </div>

              <p className="text-sm sm:text-[15px] text-[#2C353E] font-prose-indic max-w-[70ch]">
                {askResult.answer}
              </p>

              {askResult.covered_in_lecture && askResult.transcript_quote && (
                <div className="pt-2.5 border-t border-[#D8E0E8] text-xs sm:text-sm text-[#2C353E]/80 font-prose-indic max-w-[70ch]">
                  <strong className="font-display-ui font-semibold text-[#1B365D]">
                    From the lecture transcript:{' '}
                  </strong>
                  "{askResult.transcript_quote}"
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* SECTION 1: Lecture Summary (Editorial structure, no card-in-card clutter) */}
      <section
        aria-labelledby="summary-heading"
        className={`bg-white border rounded-md p-5 sm:p-6 transition-colors ${
          playingStep === -1 && isPlayingAudio ? 'border-[#1B365D]' : 'border-[#D8E0E8]'
        }`}
      >
        <div className="flex items-center justify-between gap-4 pb-3 mb-3 border-b border-[#D8E0E8]">
          <h2
            id="summary-heading"
            className="font-display-ui font-bold text-base sm:text-lg text-[#1B365D]"
          >
            Lecture summary
          </h2>
          <button
            type="button"
            onClick={() => {
              if (playingStep === -1 && isPlayingAudio) {
                stopAudio();
              } else {
                playStepAudio(-1);
              }
            }}
            className={`min-h-[44px] px-3 py-1.5 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer ${
              playingStep === -1 && isPlayingAudio
                ? 'bg-[#1B365D] text-white border-[#1B365D]'
                : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
            }`}
          >
            <Volume2 className="w-4 h-4" aria-hidden="true" />
            <span>{playingStep === -1 && isPlayingAudio ? 'Stop reading' : 'Read summary aloud'}</span>
          </button>
        </div>
        <p className="text-[15px] sm:text-base text-[#2C353E] font-prose-indic max-w-[70ch]">
          {analysis.summary}
        </p>
      </section>

      {/* SECTION 2: Key Concepts (Structured Ruled Definition List, NOT identical cards in a grid) */}
      <section aria-labelledby="concepts-heading" className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden">
        <div className="px-5 py-4 bg-[#F7F6F2]/60 border-b border-[#D8E0E8] flex items-center justify-between gap-3">
          <div>
            <h2
              id="concepts-heading"
              className="font-display-ui font-bold text-base sm:text-lg text-[#1B365D]"
            >
              Key concepts from the lecture
            </h2>
            <p className="text-xs text-[#2C353E]/75 mt-0.5">
              Tap the speaker button beside any term to hear the explanation aloud.
            </p>
          </div>
          <span className="text-xs font-display-ui text-[#2C353E]/75 tabular-nums shrink-0">
            {totalConcepts} concepts
          </span>
        </div>

        <dl className="divide-y divide-[#D8E0E8]">
          {analysis.concepts.map((concept, idx) => {
            const isSpeakingThis = playingStep === idx && isPlayingAudio;
            return (
              <div
                key={idx}
                className={`p-4 sm:px-6 sm:py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3 transition-colors ${
                  isSpeakingThis ? 'bg-[#F7F6F2]' : 'bg-white'
                }`}
              >
                <div className="space-y-1 max-w-[68ch]">
                  <dt className="font-display-ui font-semibold text-sm sm:text-base text-[#1B365D]">
                    {concept.term}
                  </dt>
                  <dd className="text-sm sm:text-[15px] text-[#2C353E] font-prose-indic">
                    {concept.explanation}
                  </dd>
                </div>

                <button
                  type="button"
                  aria-label={`Read explanation for ${concept.term}`}
                  onClick={() => {
                    if (isSpeakingThis) {
                      stopAudio();
                    } else {
                      playStepAudio(idx);
                    }
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 shrink-0 self-start cursor-pointer ${
                    isSpeakingThis
                      ? 'bg-[#1B365D] text-white border-[#1B365D]'
                      : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
                  }`}
                >
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  <span>{isSpeakingThis ? 'Stop' : 'Listen'}</span>
                </button>
              </div>
            );
          })}
        </dl>
      </section>

      {/* SECTION 3: Cleaned vs Raw Transcript Comparison */}
      <section aria-labelledby="transcript-comparison-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="transcript-comparison-heading"
            className="font-display-ui font-bold text-base text-[#1B365D]"
          >
            Lecture transcript
          </h2>
          <div className="flex items-center gap-1 bg-[#D8E0E8]/45 p-1 rounded-md border border-[#D8E0E8]">
            <button
              type="button"
              onClick={() => setTranscriptTab('clean')}
              className={`min-h-[40px] px-3 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer ${
                transcriptTab === 'clean'
                  ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                  : 'text-[#2C353E]'
              }`}
            >
              Cleaned transcript
            </button>
            <button
              type="button"
              onClick={() => setTranscriptTab('raw')}
              className={`min-h-[40px] px-3 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer ${
                transcriptTab === 'raw'
                  ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                  : 'text-[#2C353E]'
              }`}
            >
              Original speech transcript
            </button>
          </div>
        </div>

        <div className="bg-white border border-[#D8E0E8] rounded-md p-4 sm:p-5 text-sm sm:text-[15px] text-[#2C353E] font-prose-indic max-w-[72ch] whitespace-pre-wrap">
          {transcriptTab === 'clean'
            ? analysis.clean_transcript || rawTranscript
            : rawTranscript || analysis.clean_transcript}
        </div>
      </section>

      {/* SECTION 4: Quiz Questions Preview & Launch */}
      <section aria-labelledby="quiz-preview-heading" className="border-t border-[#D8E0E8] pt-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="quiz-preview-heading"
              className="font-display-ui font-bold text-base sm:text-lg text-[#1B365D]"
            >
              Practice questions ({analysis.questions.length})
            </h2>
            <p className="text-xs text-[#2C353E]/75 mt-0.5">
              Answer these questions aloud in Quiz mode to test your understanding.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {weakTopics.length > 0 && onStartWeakTopicRevision && (
              <button
                type="button"
                onClick={() => {
                  stopAudio();
                  stopAskVoice();
                  onStartWeakTopicRevision();
                }}
                className="min-h-[44px] px-4 py-2.5 bg-white hover:bg-[#F7F6F2] text-[#B83A3A] border border-[#B83A3A] rounded-md text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
              >
                Revise {weakTopics.length} weak {weakTopics.length === 1 ? 'topic' : 'topics'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                stopAudio();
                stopAskVoice();
                onStartQuiz();
              }}
              className="min-h-[44px] px-5 py-2.5 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
            >
              Start quiz
            </button>
          </div>
        </div>

        <ol className="list-decimal list-inside space-y-3 text-sm text-[#2C353E]">
          {analysis.questions.map((q, idx) => (
            <li
              key={idx}
              className="p-3.5 bg-white border border-[#D8E0E8] rounded-md font-display-ui font-medium text-[#1B365D]"
            >
              <span>{q.q}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};
