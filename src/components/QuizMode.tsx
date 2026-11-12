import React, { useState, useRef, useEffect } from 'react';
import {
  QuizQuestion,
  QuizAnswerRecord,
  SupportedLanguage,
  Verdict,
  WeakTopicItem,
} from '../types';
import {
  Mic,
  Square,
  Volume2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RotateCcw,
  ArrowLeft,
  X,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import {
  transcribeAudioChunk,
  evaluateQuizAnswer,
  playSpokenVoice,
  prefetchSpokenVoice,
} from '../services/api';

interface QuizModeProps {
  questions: QuizQuestion[];
  language: SupportedLanguage;
  weakTopics?: WeakTopicItem[];
  initialRevisionMode?: boolean;
  onQuizCompleted?: (answers: QuizAnswerRecord[]) => WeakTopicItem[];
  onBack: () => void;
  onRetake: () => void;
}

export const QuizMode: React.FC<QuizModeProps> = ({
  questions,
  language,
  weakTopics = [],
  initialRevisionMode = false,
  onQuizCompleted,
  onBack,
}) => {
  const [activeQuestions, setActiveQuestions] = useState<QuizQuestion[]>(questions);
  const [isTargetedRequiz, setIsTargetedRequiz] = useState<boolean>(false);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [answers, setAnswers] = useState<QuizAnswerRecord[]>([]);
  const [quizPhase, setQuizPhase] = useState<'idle' | 'listening' | 'checking' | 'feedback'>('idle');
  const [checkingStep, setCheckingStep] = useState<'transcribing' | 'evaluating'>('transcribing');
  const [isQuestionSpeaking, setIsQuestionSpeaking] = useState<boolean>(false);
  const [isFeedbackSpeaking, setIsFeedbackSpeaking] = useState<boolean>(false);

  const [spokenTranscript, setSpokenTranscript] = useState<string>('');
  const [currentFeedback, setCurrentFeedback] = useState<{ verdict: Verdict; feedback: string } | null>(null);
  const [recordSeconds, setRecordSeconds] = useState<number>(0);
  const [textInputFallback, setTextInputFallback] = useState<string>('');
  const [showTextInput, setShowTextInput] = useState<boolean>(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // Weak-topic revision state
  const [localWeakTopics, setLocalWeakTopics] = useState<WeakTopicItem[]>(weakTopics);
  const [isExplainingWeakTopics, setIsExplainingWeakTopics] = useState<boolean>(
    Boolean(initialRevisionMode && weakTopics.length > 0)
  );
  const [revisionIndex, setRevisionIndex] = useState<number>(0);
  const [isRevisionSpeaking, setIsRevisionSpeaking] = useState<boolean>(false);
  const persistedQuizRunRef = useRef<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const voiceControllerRef = useRef<{ stop: () => void } | null>(null);
  const speechRecognitionRef = useRef<any>(null);
  const liveAnswerSpeechRef = useRef<string>('');

  const currentQuestion = activeQuestions[currentIndex];
  const isQuizFinished = currentIndex >= activeQuestions.length;

  useEffect(() => {
    setLocalWeakTopics(weakTopics);
  }, [weakTopics]);

  // Persist weak topics when quiz finishes
  useEffect(() => {
    if (isQuizFinished && answers.length > 0 && !persistedQuizRunRef.current) {
      persistedQuizRunRef.current = true;
      if (onQuizCompleted) {
        const updated = onQuizCompleted(answers);
        setLocalWeakTopics(updated);
      } else {
        const fallbackWeak: WeakTopicItem[] = answers
          .filter((a) => a.verdict !== 'correct')
          .map((a, idx) => ({
            id: `wt_${idx}`,
            term: `Question ${a.questionIndex + 1}`,
            explanation: a.modelAnswer,
            question: a.question,
            model_answer: a.modelAnswer,
            lastVerdict: a.verdict === 'partial' ? 'partial' : 'wrong',
            updatedAt: new Date().toISOString(),
          }));
        setLocalWeakTopics(fallbackWeak);
      }
    }
  }, [isQuizFinished, answers]);

  // Speak question and prefetch next questions in standard/re-quiz mode
  useEffect(() => {
    if (!isExplainingWeakTopics && !isQuizFinished && currentQuestion) {
      speakQuestion(currentQuestion.q);

      const upcomingQuestions: string[] = [];
      if (activeQuestions[currentIndex + 1]) {
        upcomingQuestions.push(
          `Question ${currentIndex + 2}. ${activeQuestions[currentIndex + 1].q}`
        );
      }
      if (activeQuestions[currentIndex + 2]) {
        upcomingQuestions.push(
          `Question ${currentIndex + 3}. ${activeQuestions[currentIndex + 2].q}`
        );
      }
      if (upcomingQuestions.length > 0) {
        prefetchSpokenVoice(upcomingQuestions, language);
      }
    }
    return () => {
      stopVoice();
      stopRecordingCleanup();
    };
  }, [currentIndex, isExplainingWeakTopics, activeQuestions]);

  // Speak weak-topic explanation when in Weak-Topic Revision mode
  useEffect(() => {
    if (isExplainingWeakTopics && localWeakTopics[revisionIndex]) {
      const item = localWeakTopics[revisionIndex];
      speakWeakTopicExplanation(item, revisionIndex);

      const nextItem = localWeakTopics[revisionIndex + 1];
      if (nextItem) {
        prefetchSpokenVoice(
          [
            `Weak topic ${revisionIndex + 2}: ${nextItem.term}. ${nextItem.explanation} Key point to remember: ${nextItem.model_answer}`,
          ],
          language
        );
      }
    }
    return () => {
      if (isExplainingWeakTopics) {
        stopVoice();
      }
    };
  }, [isExplainingWeakTopics, revisionIndex]);

  const stopVoice = () => {
    if (voiceControllerRef.current) {
      voiceControllerRef.current.stop();
      voiceControllerRef.current = null;
    }
    setIsQuestionSpeaking(false);
    setIsFeedbackSpeaking(false);
    setIsRevisionSpeaking(false);
  };

  const stopRecordingCleanup = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
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
  };

  const speakQuestion = (qText: string) => {
    stopVoice();
    setIsQuestionSpeaking(true);
    const controller = playSpokenVoice(
      `Question ${currentIndex + 1}. ${qText}`,
      language,
      null,
      () => {
        setIsQuestionSpeaking(false);
      }
    );
    voiceControllerRef.current = controller;
  };

  const speakFeedback = (fbText: string) => {
    stopVoice();
    setIsFeedbackSpeaking(true);
    const controller = playSpokenVoice(fbText, language, null, () => {
      setIsFeedbackSpeaking(false);
    });
    voiceControllerRef.current = controller;
  };

  const speakWeakTopicExplanation = (item: WeakTopicItem, idx: number) => {
    stopVoice();
    setIsRevisionSpeaking(true);
    const textToSpeak = `Weak topic ${idx + 1}: ${item.term}. ${item.explanation} Key point to remember: ${item.model_answer}`;
    const controller = playSpokenVoice(textToSpeak, language, null, () => {
      setIsRevisionSpeaking(false);
    });
    voiceControllerRef.current = controller;
  };

  const handleStartWeakTopicVoiceRevision = () => {
    if (localWeakTopics.length === 0) return;
    stopVoice();
    setRevisionIndex(0);
    setIsExplainingWeakTopics(true);
  };

  const handleStartTargetedWeakQuiz = () => {
    if (localWeakTopics.length === 0) return;
    stopVoice();
    const weakQuizQuestions: QuizQuestion[] = localWeakTopics.map((wt) => ({
      q: wt.question,
      model_answer: wt.model_answer,
    }));
    persistedQuizRunRef.current = false;
    setIsExplainingWeakTopics(false);
    setIsTargetedRequiz(true);
    setActiveQuestions(weakQuizQuestions);
    setAnswers([]);
    setCurrentIndex(0);
    setCurrentFeedback(null);
    setSpokenTranscript('');
    setQuizPhase('idle');
  };

  const handleStartFullRetake = () => {
    stopVoice();
    persistedQuizRunRef.current = false;
    setIsExplainingWeakTopics(false);
    setIsTargetedRequiz(false);
    setActiveQuestions(questions);
    setAnswers([]);
    setCurrentIndex(0);
    setCurrentFeedback(null);
    setSpokenTranscript('');
    setQuizPhase('idle');
  };

  const formatTime = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const startVoiceAnswer = async () => {
    stopVoice();
    setErrorNotice(null);
    setSpokenTranscript('');
    setRecordSeconds(0);
    setCurrentFeedback(null);
    liveAnswerSpeechRef.current = '';
    recordedChunksRef.current = [];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Microphone access requires HTTPS or localhost. Use the text box below to type your answer.'
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      streamRef.current = stream;

      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        // Materialize recorded chunks into an in-memory Blob BEFORE stopping MediaStream tracks
        const rawBlob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        let detachedBlob = rawBlob;
        try {
          const buf = await rawBlob.arrayBuffer();
          detachedBlob = new Blob([buf], { type: rawBlob.type || 'audio/webm' });
        } catch {}

        stopRecordingCleanup();

        setQuizPhase('checking');
        setCheckingStep('transcribing');

        try {
          let answerText = '';

          if (detachedBlob.size > 0) {
            try {
              // Always transcribe quiz answers using English ('en' -> 'en-IN')
              const sttRes = await transcribeAudioChunk(detachedBlob, 'en', 0, 1);
              if (sttRes?.transcript?.trim()) {
                answerText = sttRes.transcript.trim();
              }
            } catch (sttErr: any) {
              // If Gnani STT fails, fall back to live Web Speech transcript if available
              if (liveAnswerSpeechRef.current && liveAnswerSpeechRef.current.trim().length > 0) {
                answerText = liveAnswerSpeechRef.current.trim();
              } else {
                throw sttErr;
              }
            }
          }

          if (!answerText && liveAnswerSpeechRef.current && liveAnswerSpeechRef.current.trim().length > 0) {
            answerText = liveAnswerSpeechRef.current.trim();
          }

          if (!answerText) {
            throw new Error(
              'No spoken answer was detected. Please speak clearly into your microphone or use "Write answer instead".'
            );
          }

          setCheckingStep('evaluating');

          const evalRes = await evaluateQuizAnswer(
            currentQuestion.q,
            currentQuestion.model_answer,
            answerText,
            'en'
          );

          const englishAnswer = evalRes.english_user_answer?.trim() || answerText;
          setSpokenTranscript(englishAnswer);
          setCurrentFeedback(evalRes);
          setQuizPhase('feedback');

          setAnswers((prev) => [
            ...prev,
            {
              questionIndex: currentIndex,
              question: currentQuestion.q,
              modelAnswer: currentQuestion.model_answer,
              userAnswer: englishAnswer,
              verdict: evalRes.verdict,
              feedback: evalRes.feedback,
            },
          ]);

          speakFeedback(evalRes.feedback);
        } catch (err: any) {
          setErrorNotice(
            err.message ||
              'Could not transcribe or evaluate your spoken answer. Try speaking again or type your answer below.'
          );
          setQuizPhase('idle');
        }
      };

      recorder.start(500);
      setQuizPhase('listening');

      // Live browser speech capture in English alongside MediaRecorder
      if (typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        try {
          const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
              liveAnswerSpeechRef.current = full.trim();
              setSpokenTranscript(full.trim());
            }
          };
          rec.start();
          speechRecognitionRef.current = rec;
        } catch {}
      }

      timerIntervalRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);
    } catch (err: any) {
      let msg = 'Microphone is blocked. Allow microphone access in your browser settings or type your answer below.';
      if (err.name === 'NotFoundError') {
        msg = 'No microphone was detected on this device. Type your answer in the box below.';
      }
      setErrorNotice(msg);
      setShowTextInput(true);
      setQuizPhase('idle');
      stopRecordingCleanup();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.requestData();
      } catch {}
      mediaRecorderRef.current.stop();
    }
  };

  const handleTextAnswerSubmit = async () => {
    if (!textInputFallback.trim()) return;
    stopVoice();
    setQuizPhase('checking');
    setCheckingStep('evaluating');
    setErrorNotice(null);

    try {
      const evalRes = await evaluateQuizAnswer(
        currentQuestion.q,
        currentQuestion.model_answer,
        textInputFallback,
        'en'
      );

      const englishAnswer = evalRes.english_user_answer?.trim() || textInputFallback;
      setSpokenTranscript(englishAnswer);
      setCurrentFeedback(evalRes);
      setQuizPhase('feedback');

      setAnswers((prev) => [
        ...prev,
        {
          questionIndex: currentIndex,
          question: currentQuestion.q,
          modelAnswer: currentQuestion.model_answer,
          userAnswer: englishAnswer,
          verdict: evalRes.verdict,
          feedback: evalRes.feedback,
        },
      ]);

      setTextInputFallback('');
      speakFeedback(evalRes.feedback);
    } catch (err: any) {
      setErrorNotice(err.message || 'Could not check your written answer. Check your connection and try again.');
      setQuizPhase('idle');
    }
  };

  const handleNextQuestion = () => {
    stopVoice();
    setSpokenTranscript('');
    setCurrentFeedback(null);
    setQuizPhase('idle');
    setCurrentIndex((i) => i + 1);
  };

  const correctCount = answers.filter((a) => a.verdict === 'correct').length;
  const partialCount = answers.filter((a) => a.verdict === 'partial').length;
  const scorePercent =
    activeQuestions.length > 0 ? Math.round((correctCount / activeQuestions.length) * 100) : 0;

  // -------------------------------------------------------------
  // RENDER: Weak-Topic Voice Revision Screen
  // -------------------------------------------------------------
  if (isExplainingWeakTopics && localWeakTopics.length > 0) {
    const currentWeakItem = localWeakTopics[revisionIndex] || localWeakTopics[0];
    return (
      <section aria-label="Weak-topic voice revision" className="space-y-5 pb-24 lg:pb-8">
        <div className="flex items-center justify-between gap-4 pb-3 border-b border-[#D8E0E8]">
          <button
            type="button"
            onClick={() => {
              stopVoice();
              setIsExplainingWeakTopics(false);
            }}
            className="min-h-[44px] px-2.5 py-1.5 flex items-center gap-1.5 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] hover:text-[#1B365D] cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Back to quiz</span>
          </button>

          <div className="flex items-center gap-3">
            <span className="text-xs sm:text-sm font-display-ui font-semibold text-[#B83A3A] tabular-nums">
              Weak topic {revisionIndex + 1} of {localWeakTopics.length}
            </span>
            <div className="w-24 sm:w-32 h-2 bg-white border border-[#D8E0E8] rounded-xs overflow-hidden">
              <div
                className="h-full bg-[#B83A3A] transition-all duration-300"
                style={{ width: `${((revisionIndex + 1) / localWeakTopics.length) * 100}%` }}
              />
            </div>
          </div>
        </div>

        <div className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden">
          <div className="p-5 sm:p-6 border-b border-[#D8E0E8] flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 max-w-[65ch]">
              <span className="text-xs font-display-ui font-semibold text-[#B83A3A]">
                Weak-topic voice revision ({currentWeakItem.lastVerdict === 'partial' ? 'Partially correct earlier' : 'Missed earlier'})
              </span>
              <h2 className="font-display-ui font-bold text-lg sm:text-xl text-[#1B365D]">
                {currentWeakItem.term}
              </h2>
            </div>

            <button
              type="button"
              onClick={() => {
                if (isRevisionSpeaking) {
                  stopVoice();
                } else {
                  speakWeakTopicExplanation(currentWeakItem, revisionIndex);
                }
              }}
              className={`min-h-[44px] px-3.5 py-2 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer ${
                isRevisionSpeaking
                  ? 'bg-[#1B365D] text-white border-[#1B365D]'
                  : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
              }`}
            >
              <Volume2 className="w-4 h-4" aria-hidden="true" />
              <span>{isRevisionSpeaking ? 'Stop reading' : 'Read explanation aloud'}</span>
            </button>
          </div>

          <div className="p-5 sm:p-6 space-y-5">
            <div className="space-y-1.5">
              <h3 className="text-xs font-display-ui font-semibold text-[#1B365D]">
                Concept explanation from lecture
              </h3>
              <p className="text-sm sm:text-base text-[#2C353E] font-prose-indic max-w-[70ch]">
                {currentWeakItem.explanation}
              </p>
            </div>

            <div className="p-4 bg-[#F7F6F2] border border-[#D8E0E8] rounded-md space-y-2">
              <p className="text-xs sm:text-sm font-display-ui font-semibold text-[#1B365D]">
                Practice question: {currentWeakItem.question}
              </p>
              <p className="text-xs sm:text-sm text-[#2C353E] font-prose-indic max-w-[70ch]">
                <strong className="font-display-ui font-semibold text-[#2C353E]">
                  Key point to remember:{' '}
                </strong>
                {currentWeakItem.model_answer}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={revisionIndex <= 0}
                  onClick={() => setRevisionIndex((i) => Math.max(0, i - 1))}
                  className="min-h-[44px] px-3.5 py-2 rounded-md border border-[#D8E0E8] bg-white hover:bg-[#F7F6F2] disabled:opacity-40 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] flex items-center gap-1.5 cursor-pointer"
                >
                  <SkipBack className="w-4 h-4" aria-hidden="true" />
                  <span>Previous topic</span>
                </button>
                <button
                  type="button"
                  disabled={revisionIndex >= localWeakTopics.length - 1}
                  onClick={() =>
                    setRevisionIndex((i) => Math.min(localWeakTopics.length - 1, i + 1))
                  }
                  className="min-h-[44px] px-3.5 py-2 rounded-md border border-[#D8E0E8] bg-white hover:bg-[#F7F6F2] disabled:opacity-40 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Next weak topic</span>
                  <SkipForward className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleStartTargetedWeakQuiz}
                className="min-h-[44px] px-5 py-2.5 rounded-md bg-[#1B365D] hover:bg-[#142947] text-white text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
              >
                Re-quiz {localWeakTopics.length} weak{' '}
                {localWeakTopics.length === 1 ? 'topic' : 'topics'} now
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // -------------------------------------------------------------
  // RENDER: Final Quiz Results + Weak-Topic Revision Loop
  // -------------------------------------------------------------
  if (isQuizFinished) {
    return (
      <section aria-labelledby="quiz-results-heading" className="space-y-6 pb-12">
        <div className="bg-white border border-[#D8E0E8] rounded-md p-6 sm:p-8 space-y-6">
          <div className="border-b border-[#D8E0E8] pb-4 flex flex-wrap items-baseline justify-between gap-4">
            <div>
              <h2 id="quiz-results-heading" className="font-display-ui font-bold text-xl text-[#1B365D]">
                {isTargetedRequiz ? 'Weak-topic re-quiz results' : 'Quiz results'}
              </h2>
              <p className="text-xs sm:text-sm text-[#2C353E]/80 mt-1">
                Completed {activeQuestions.length}{' '}
                {isTargetedRequiz ? 'weak-topic revision' : 'lecture'} questions.
              </p>
            </div>
            <div className="font-display-ui text-2xl sm:text-3xl font-bold text-[#1B365D] tabular-nums">
              {scorePercent}% ({correctCount} of {activeQuestions.length} correct)
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-xs sm:text-sm font-display-ui text-[#2C353E] tabular-nums">
            <span>Correct answers: {correctCount}</span>
            <span>Partial answers: {partialCount}</span>
            <span>Needs review: {activeQuestions.length - correctCount - partialCount}</span>
          </div>

          {/* FEATURE 2: Weak-Topic Revision Callout */}
          {localWeakTopics.length > 0 ? (
            <div className="p-4 sm:p-5 bg-[#F7F6F2] border border-[#B83A3A] rounded-md space-y-3">
              <div className="space-y-1">
                <h3 className="font-display-ui font-bold text-sm sm:text-base text-[#B83A3A]">
                  Revise your {localWeakTopics.length} weak{' '}
                  {localWeakTopics.length === 1 ? 'topic' : 'topics'}
                </h3>
                <p className="text-xs sm:text-sm text-[#2C353E] font-prose-indic">
                  Listen to a focused voice explanation of the concepts you missed (
                  {localWeakTopics.map((w) => w.term).join(', ')}) and re-quiz only those questions until you master them.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={handleStartWeakTopicVoiceRevision}
                  className="min-h-[44px] px-4 py-2.5 rounded-md bg-[#B83A3A] hover:bg-[#9E2F2F] text-white text-xs sm:text-sm font-display-ui font-semibold flex items-center gap-2 cursor-pointer"
                >
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  <span>
                    Revise {localWeakTopics.length} weak{' '}
                    {localWeakTopics.length === 1 ? 'topic' : 'topics'} by voice
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleStartTargetedWeakQuiz}
                  className="min-h-[44px] px-4 py-2.5 rounded-md bg-white hover:bg-[#F7F6F2] text-[#1B365D] border border-[#D8E0E8] text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
                >
                  Re-quiz weak topics only
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-[#F7F6F2] border border-[#1B365D] rounded-md flex items-center gap-2.5 text-xs sm:text-sm font-display-ui font-semibold text-[#1B365D]">
              <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span>All concepts from this lecture are mastered. Zero weak topics remaining!</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onBack}
              className="min-h-[44px] px-4 py-2.5 rounded-md border border-[#D8E0E8] bg-white hover:bg-[#F7F6F2] text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] cursor-pointer"
            >
              Back to notes
            </button>
            <button
              type="button"
              onClick={handleStartFullRetake}
              className="min-h-[44px] px-5 py-2.5 rounded-md bg-[#1B365D] hover:bg-[#142947] text-white text-xs sm:text-sm font-display-ui font-semibold flex items-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Retake full quiz ({questions.length} questions)</span>
            </button>
          </div>
        </div>

        {/* Question-by-Question Review */}
        <div className="bg-white border border-[#D8E0E8] rounded-md divide-y divide-[#D8E0E8]">
          {answers.map((ans, idx) => (
            <div key={idx} className="p-4 sm:p-5 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-display-ui font-semibold text-sm sm:text-base text-[#1B365D]">
                  {idx + 1}. {ans.question}
                </h3>
                <span
                  className={`text-xs font-display-ui font-semibold shrink-0 ${
                    ans.verdict === 'correct'
                      ? 'text-[#1B365D]'
                      : ans.verdict === 'partial'
                      ? 'text-[#2C353E]'
                      : 'text-[#B83A3A]'
                  }`}
                >
                  {ans.verdict === 'correct'
                    ? 'Correct'
                    : ans.verdict === 'partial'
                    ? 'Partially correct'
                    : 'Incorrect'}
                </span>
              </div>

              <div className="space-y-1.5 text-xs sm:text-sm text-[#2C353E] font-prose-indic max-w-[70ch]">
                <p>
                  <strong className="font-display-ui font-semibold text-[#2C353E]">Your answer: </strong>
                  {ans.userAnswer || 'No spoken response recorded'}
                </p>
                <p>
                  <strong className="font-display-ui font-semibold text-[#1B365D]">Feedback: </strong>
                  {ans.feedback}
                </p>
                <p className="text-[#2C353E]/75">
                  <strong className="font-display-ui font-medium">Expected answer: </strong>
                  {ans.modelAnswer}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // -------------------------------------------------------------
  // RENDER: Focused Single-Question Screen
  // -------------------------------------------------------------
  return (
    <section aria-label="Voice quiz question" className="space-y-5 pb-24 lg:pb-8">
      {/* Top Progress Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-[#D8E0E8]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              stopVoice();
              stopRecordingCleanup();
              onBack();
            }}
            className="min-h-[44px] px-2.5 py-1.5 flex items-center gap-1.5 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] hover:text-[#1B365D] cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Back to notes</span>
          </button>

          {localWeakTopics.length > 0 && !isTargetedRequiz && (
            <button
              type="button"
              onClick={handleStartWeakTopicVoiceRevision}
              className="min-h-[38px] px-3 py-1 rounded-md border border-[#B83A3A] bg-white hover:bg-[#F7F6F2] text-xs font-display-ui font-semibold text-[#B83A3A] cursor-pointer"
            >
              Revise {localWeakTopics.length} weak {localWeakTopics.length === 1 ? 'topic' : 'topics'}
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs sm:text-sm font-display-ui font-semibold text-[#1B365D] tabular-nums">
            {isTargetedRequiz ? 'Weak-topic re-quiz: ' : ''}Question {currentIndex + 1} of{' '}
            {activeQuestions.length}
          </span>
          <div className="w-24 sm:w-32 h-2 bg-white border border-[#D8E0E8] rounded-xs overflow-hidden">
            <div
              className="h-full bg-[#1B365D] transition-all duration-300"
              style={{ width: `${((currentIndex + 1) / activeQuestions.length) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Focused Single-Question Notebook Sheet */}
      <div className="bg-white border border-[#D8E0E8] rounded-md overflow-hidden">
        {/* Question Header */}
        <div className="p-5 sm:p-6 border-b border-[#D8E0E8] flex items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-[68ch]">
            <span className="text-xs font-display-ui font-medium text-[#2C353E]/70">
              State: {quizPhase === 'listening' ? 'Listening to your answer' : quizPhase === 'checking' ? 'Checking your answer' : quizPhase === 'feedback' ? 'Answer reviewed' : 'Ready for your answer'}
            </span>
            <h2 className="font-display-ui font-bold text-lg sm:text-xl text-[#1B365D] leading-snug">
              {currentQuestion.q}
            </h2>
          </div>

          <button
            type="button"
            onClick={() => speakQuestion(currentQuestion.q)}
            aria-label="Read question aloud"
            className={`min-h-[44px] px-3 py-2 rounded-md border text-xs font-display-ui font-medium flex items-center gap-1.5 shrink-0 cursor-pointer ${
              isQuestionSpeaking
                ? 'bg-[#1B365D] text-white border-[#1B365D]'
                : 'bg-white text-[#2C353E] border-[#D8E0E8] hover:bg-[#F7F6F2]'
            }`}
          >
            <Volume2 className="w-4 h-4" aria-hidden="true" />
            <span>{isQuestionSpeaking ? 'Reading' : 'Read question'}</span>
          </button>
        </div>

        {/* Actionable Error Message */}
        {errorNotice && (
          <div
            role="alert"
            className="mx-5 mt-4 p-3.5 bg-white border border-[#B83A3A] rounded-md text-xs sm:text-sm text-[#2C353E] flex items-start justify-between gap-3"
          >
            <span>{errorNotice}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => setErrorNotice(null)}
              className="min-h-[44px] min-w-[44px] -m-2 flex items-center justify-center text-[#2C353E]/70 hover:text-[#2C353E] cursor-pointer"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Answer Area on Ruled Lines */}
        <div className="p-5 sm:p-6 space-y-5">
          {/* State 1: Listening */}
          {quizPhase === 'listening' && (
            <div
              role="status"
              aria-live="polite"
              className="p-5 bg-[#F7F6F2] border border-[#B83A3A] rounded-md space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-display-ui font-semibold text-sm sm:text-base text-[#B83A3A]">
                  Listening to your spoken answer
                </span>
                <span className="font-display-ui font-bold text-base text-[#1B365D] tabular-nums">
                  {formatTime(recordSeconds)}
                </span>
              </div>
              <p className="text-sm text-[#2C353E] font-prose-indic min-h-[32px]">
                {spokenTranscript || 'Speak clearly into your microphone...'}
              </p>
            </div>
          )}

          {/* State 2: Checking (Real progress steps) */}
          {quizPhase === 'checking' && (
            <div
              role="status"
              aria-live="polite"
              className="p-5 bg-[#F7F6F2] border border-[#D8E0E8] rounded-md space-y-3"
            >
              <div className="flex items-center justify-between text-xs sm:text-sm font-display-ui">
                <span className="font-semibold text-[#1B365D]">
                  {checkingStep === 'transcribing'
                    ? 'Step 1 of 2: Transcribing your spoken answer with Gnani Prisma...'
                    : 'Step 2 of 2: Checking your answer against the lecture concepts...'}
                </span>
                <span className="tabular-nums text-[#2C353E]/75">
                  {checkingStep === 'transcribing' ? '50%' : '90%'}
                </span>
              </div>
              <div className="w-full h-2 bg-white border border-[#D8E0E8] rounded-xs overflow-hidden">
                <div
                  className="h-full bg-[#1B365D] transition-all duration-300"
                  style={{ width: checkingStep === 'transcribing' ? '50%' : '90%' }}
                />
              </div>
            </div>
          )}

          {/* State 3: Feedback */}
          {quizPhase === 'feedback' && currentFeedback && (
            <div
              role="region"
              aria-label="Answer feedback"
              className="space-y-4"
            >
              <div
                className={`p-4 sm:p-5 rounded-md border space-y-2.5 ${
                  currentFeedback.verdict === 'correct'
                    ? 'bg-[#F7F6F2] border-[#1B365D]'
                    : currentFeedback.verdict === 'partial'
                    ? 'bg-[#F7F6F2] border-[#2C353E]'
                    : 'bg-white border-[#B83A3A]'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {currentFeedback.verdict === 'correct' && (
                      <CheckCircle2 className="w-5 h-5 text-[#1B365D] shrink-0" aria-hidden="true" />
                    )}
                    {currentFeedback.verdict === 'partial' && (
                      <AlertTriangle className="w-5 h-5 text-[#2C353E] shrink-0" aria-hidden="true" />
                    )}
                    {currentFeedback.verdict === 'wrong' && (
                      <XCircle className="w-5 h-5 text-[#B83A3A] shrink-0" aria-hidden="true" />
                    )}
                    <span className="font-display-ui font-bold text-sm sm:text-base text-[#1B365D]">
                      {currentFeedback.verdict === 'correct'
                        ? 'Correct answer'
                        : currentFeedback.verdict === 'partial'
                        ? 'Partially correct'
                        : 'Needs review'}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => speakFeedback(currentFeedback.feedback)}
                    className="min-h-[44px] px-3 py-1.5 rounded-md border border-[#D8E0E8] bg-white hover:bg-[#F7F6F2] text-xs font-display-ui font-medium text-[#2C353E] flex items-center gap-1.5 cursor-pointer"
                  >
                    <Volume2 className="w-4 h-4" aria-hidden="true" />
                    <span>{isFeedbackSpeaking ? 'Speaking feedback' : 'Read feedback aloud'}</span>
                  </button>
                </div>

                {spokenTranscript && (
                  <p className="text-xs sm:text-sm text-[#2C353E]/85 font-prose-indic">
                    <strong className="font-display-ui font-semibold">Your answer: </strong>
                    "{spokenTranscript}"
                  </p>
                )}

                <p className="text-sm sm:text-[15px] text-[#2C353E] font-prose-indic max-w-[70ch]">
                  {currentFeedback.feedback}
                </p>

                <p className="text-xs sm:text-sm text-[#2C353E]/75 pt-2 border-t border-[#D8E0E8] font-prose-indic max-w-[70ch]">
                  <strong className="font-display-ui font-semibold text-[#1B365D]">Model answer: </strong>
                  {currentQuestion.model_answer}
                </p>
              </div>
            </div>
          )}

          {/* Optional Written Answer Box */}
          {quizPhase === 'idle' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#2C353E]/80">
                  Press "Start recording" to speak your answer, or type your answer below.
                </span>
                <button
                  type="button"
                  onClick={() => setShowTextInput((prev) => !prev)}
                  className="min-h-[44px] px-2.5 text-xs font-display-ui font-medium text-[#1B365D] underline cursor-pointer"
                >
                  {showTextInput ? 'Hide written answer box' : 'Write answer instead'}
                </button>
              </div>

              {showTextInput && (
                <div className="space-y-2.5 pt-1">
                  <label htmlFor="quiz-written-answer" className="sr-only">
                    Type your answer
                  </label>
                  <textarea
                    id="quiz-written-answer"
                    value={textInputFallback}
                    onChange={(e) => setTextInputFallback(e.target.value)}
                    placeholder="Write your answer on these lines..."
                    rows={3}
                    className="w-full p-3 text-sm bg-[#F7F6F2] border border-[#D8E0E8] rounded-md text-[#2C353E] font-prose-indic focus:border-[#1B365D]"
                  />
                  <button
                    type="button"
                    onClick={handleTextAnswerSubmit}
                    disabled={!textInputFallback.trim()}
                    className="min-h-[44px] px-5 py-2.5 bg-[#1B365D] hover:bg-[#142947] disabled:opacity-50 text-white text-xs sm:text-sm font-display-ui font-semibold rounded-md cursor-pointer"
                  >
                    Check written answer
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* THUMB-ZONE PRIMARY QUIZ CONTROL (Docked at bottom on mobile, inline on desktop) */}
      <div className="fixed bottom-16 left-0 right-0 z-20 px-3 py-2.5 bg-[#F7F6F2]/95 backdrop-blur-xs border-t border-[#D8E0E8] lg:static lg:p-0 lg:bg-transparent lg:border-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          {quizPhase === 'idle' && (
            <button
              type="button"
              onClick={startVoiceAnswer}
              className="w-full lg:w-auto min-h-[48px] px-6 py-3 bg-[#1B365D] hover:bg-[#142947] text-white font-display-ui font-semibold text-sm sm:text-base rounded-md flex items-center justify-center gap-2.5 cursor-pointer shadow-xs"
            >
              <Mic className="w-5 h-5" aria-hidden="true" />
              <span>Start recording answer</span>
            </button>
          )}

          {quizPhase === 'listening' && (
            <button
              type="button"
              onClick={stopRecording}
              className="w-full lg:w-auto min-h-[48px] px-6 py-3 bg-[#B83A3A] hover:bg-[#9E2F2F] text-white font-display-ui font-semibold text-sm sm:text-base rounded-md flex items-center justify-center gap-2.5 cursor-pointer shadow-xs"
            >
              <Square className="w-4 h-4 fill-white" aria-hidden="true" />
              <span>Stop and check answer ({formatTime(recordSeconds)})</span>
            </button>
          )}

          {quizPhase === 'feedback' && (
            <button
              type="button"
              onClick={handleNextQuestion}
              className="w-full lg:w-auto min-h-[48px] px-6 py-3 bg-[#1B365D] hover:bg-[#142947] text-white font-display-ui font-semibold text-sm sm:text-base rounded-md flex items-center justify-center gap-2.5 cursor-pointer shadow-xs"
            >
              <span>
                {currentIndex + 1 < activeQuestions.length
                  ? 'Next question'
                  : 'Finish quiz and view score'}
              </span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
