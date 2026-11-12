import React, { useState, useEffect, useRef } from 'react';
import { LectureAnalysis, SupportedLanguage } from '../types';
import { Play, Pause, RotateCcw, SkipForward, SkipBack, ArrowLeft } from 'lucide-react';
import { playSpokenVoice, prefetchSpokenVoice } from '../services/api';

interface ExplainModeProps {
  analysis: LectureAnalysis;
  language: SupportedLanguage;
  onBack: () => void;
  onStartQuiz: () => void;
}

export const ExplainMode: React.FC<ExplainModeProps> = ({
  analysis,
  language,
  onBack,
  onStartQuiz,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const activeControllerRef = useRef<{ stop: () => void } | null>(null);

  const totalSteps = analysis.concepts.length;

  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, []);

  const stopPlayback = () => {
    if (activeControllerRef.current) {
      activeControllerRef.current.stop();
      activeControllerRef.current = null;
    }
    setIsPlaying(false);
  };

  const playStep = (stepIndex: number) => {
    stopPlayback();
    setCurrentStep(stepIndex);
    setIsPlaying(true);

    let textToSpeak = '';
    if (stepIndex === -1) {
      textToSpeak = `Lecture summary. ${analysis.summary}`;
    } else if (stepIndex >= 0 && stepIndex < analysis.concepts.length) {
      const c = analysis.concepts[stepIndex];
      textToSpeak = `Concept ${stepIndex + 1}: ${c.term}. ${c.explanation}`;
    } else {
      setIsPlaying(false);
      return;
    }

    const nextIdx = stepIndex + 1;
    if (nextIdx >= 0 && nextIdx < analysis.concepts.length) {
      const nextC = analysis.concepts[nextIdx];
      prefetchSpokenVoice([`Concept ${nextIdx + 1}: ${nextC.term}. ${nextC.explanation}`], language);
    }

    const controller = playSpokenVoice(textToSpeak, language, null, () => {
      if (stepIndex + 1 < analysis.concepts.length) {
        playStep(stepIndex + 1);
      } else {
        setIsPlaying(false);
      }
    });
    activeControllerRef.current = controller;
  };

  const handleTogglePlay = () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      playStep(currentStep === -1 ? -1 : currentStep);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <div className="flex items-center justify-between pb-3 border-b border-[#D8E0E8]">
        <button
          type="button"
          onClick={() => {
            stopPlayback();
            onBack();
          }}
          className="min-h-[44px] px-3 py-2 flex items-center gap-1.5 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] hover:text-[#1B365D] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Back to notes</span>
        </button>

        <button
          type="button"
          onClick={() => {
            stopPlayback();
            onStartQuiz();
          }}
          className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs sm:text-sm font-display-ui font-semibold cursor-pointer"
        >
          Start quiz
        </button>
      </div>

      {/* Sticky Audio Controls */}
      <div className="sticky top-14 z-20 bg-white border border-[#D8E0E8] rounded-md p-4 flex flex-wrap items-center justify-between gap-4 shadow-2xs">
        <div>
          <h2 className="font-display-ui font-bold text-base text-[#1B365D]">
            {currentStep === -1
              ? 'Lecture summary'
              : `Concept ${currentStep + 1} of ${totalSteps}: ${analysis.concepts[currentStep]?.term}`}
          </h2>
          <p className="text-xs text-[#2C353E]/75">
            Spoken aloud via Gnani Timbre v3.0 (Yashraj)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => playStep(-1)}
            aria-label="Restart from summary"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => currentStep > -1 && playStep(currentStep - 1)}
            disabled={currentStep <= -1}
            aria-label="Previous concept"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] disabled:opacity-40 cursor-pointer"
          >
            <SkipBack className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleTogglePlay}
            className="min-h-[44px] px-5 py-2.5 rounded-md bg-[#1B365D] hover:bg-[#142947] text-white font-display-ui font-semibold text-xs sm:text-sm flex items-center gap-2 cursor-pointer"
          >
            {isPlaying ? (
              <>
                <Pause className="w-4 h-4 fill-white" aria-hidden="true" />
                <span>Pause audio</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" aria-hidden="true" />
                <span>Read aloud</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => currentStep + 1 < totalSteps && playStep(currentStep + 1)}
            disabled={currentStep >= totalSteps - 1}
            aria-label="Next concept"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md border border-[#D8E0E8] text-[#2C353E] hover:bg-[#F7F6F2] disabled:opacity-40 cursor-pointer"
          >
            <SkipForward className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Ordered sequence of chapters */}
      <div className="bg-white border border-[#D8E0E8] rounded-md divide-y divide-[#D8E0E8]">
        <button
          type="button"
          onClick={() => playStep(-1)}
          className={`w-full text-left p-4 sm:p-5 transition-colors cursor-pointer ${
            currentStep === -1 ? 'bg-[#F7F6F2]' : 'bg-white hover:bg-[#F7F6F2]/50'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-display-ui font-semibold text-sm text-[#1B365D]">
              Summary
            </span>
            {currentStep === -1 && isPlaying && (
              <span className="text-xs font-display-ui font-semibold text-[#1B365D]">
                Reading aloud
              </span>
            )}
          </div>
          <p className="text-sm text-[#2C353E] font-prose-indic max-w-[70ch]">
            {analysis.summary}
          </p>
        </button>

        {analysis.concepts.map((concept, idx) => {
          const isActive = currentStep === idx;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => playStep(idx)}
              className={`w-full text-left p-4 sm:p-5 transition-colors cursor-pointer ${
                isActive ? 'bg-[#F7F6F2]' : 'bg-white hover:bg-[#F7F6F2]/50'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-display-ui font-semibold text-sm text-[#1B365D]">
                  {idx + 1}. {concept.term}
                </span>
                {isActive && isPlaying && (
                  <span className="text-xs font-display-ui font-semibold text-[#1B365D]">
                    Reading aloud
                  </span>
                )}
              </div>
              <p className="text-sm text-[#2C353E] font-prose-indic max-w-[70ch]">
                {concept.explanation}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};
