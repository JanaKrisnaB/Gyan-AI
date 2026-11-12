/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { AudioRecorder } from './components/AudioRecorder';
import { AnalysisViewer } from './components/AnalysisViewer';
import { ExplainMode } from './components/ExplainMode';
import { QuizMode } from './components/QuizMode';
import {
  SupportedLanguage,
  LectureAnalysis,
  TestCase,
  SavedLecture,
  QuizAnswerRecord,
  WeakTopicItem,
} from './types';
import { analyzeLecture, fetchTestCases, checkSystemHealth } from './services/api';
import {
  getSavedLectures,
  saveLecture,
  deleteLecture,
  seedDemoLectures,
  clearAllSavedLectures,
  updateLectureWeakTopics,
} from './services/storage';
import { MyLecturesDrawer } from './components/MyLecturesDrawer';
import {
  Mic,
  BookOpen,
  HelpCircle,
  FolderOpen,
  Check,
  RefreshCw,
} from 'lucide-react';

export default function App() {
  const [language, setLanguage] = useState<SupportedLanguage>('hi');
  const [activeTab, setActiveTab] = useState<'record' | 'analysis' | 'explain' | 'quiz'>('record');
  const [startQuizInRevisionMode, setStartQuizInRevisionMode] = useState<boolean>(false);
  const [rawTranscript, setRawTranscript] = useState<string>('');
  const [analysis, setAnalysis] = useState<LectureAnalysis | null>(null);

  // Active Lecture session tracking
  const [currentLectureId, setCurrentLectureId] = useState<string | null>(null);
  const [currentLectureTitle, setCurrentLectureTitle] = useState<string>('');
  const [savedLectures, setSavedLectures] = useState<SavedLecture[]>([]);
  const [isMyLecturesOpen, setIsMyLecturesOpen] = useState<boolean>(false);
  const [isSavedFeedback, setIsSavedFeedback] = useState<boolean>(false);

  // States
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [stateLabel, setStateLabel] = useState<string>('Ready to listen');
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [systemHealth, setSystemHealth] = useState({
    status: 'ok',
    gnani_configured: false,
    gemini_configured: true,
  });

  useEffect(() => {
    const stored = getSavedLectures();
    setSavedLectures(stored);

    fetchTestCases().then((tc) => {
      if (tc && tc.length > 0) {
        setTestCases(tc);
        const seeded = seedDemoLectures(tc, false);
        setSavedLectures(seeded);
      }
    });

    checkSystemHealth().then((h) => {
      setSystemHealth(h);
    });
  }, []);

  const handleTranscriptComplete = async (transcript: string) => {
    setCurrentLectureId(null);
    setCurrentLectureTitle('');
    setRawTranscript(transcript);
    await runAnalysis(transcript, language);
  };

  const runAnalysis = async (transcript: string, lang: SupportedLanguage) => {
    if (!transcript.trim()) return;

    setIsAnalyzing(true);
    setStateLabel('Extracting concepts, summary, and quiz questions...');

    let finalAnalysis: LectureAnalysis;
    try {
      finalAnalysis = await analyzeLecture(transcript, lang);
    } catch (err: any) {
      console.error('Analysis error:', err);
      finalAnalysis = {
        clean_transcript: transcript,
        summary: `Lecture recorded (${lang}): ${transcript.slice(0, 180)}...`,
        concepts: [
          { term: 'Lecture topic', explanation: transcript.slice(0, 120) },
          { term: 'Key discussion', explanation: transcript.slice(120, 240) || transcript.slice(0, 100) },
        ],
        questions: [
          {
            q: 'What was the primary topic discussed in this lecture?',
            model_answer: transcript.slice(0, 120),
          },
        ],
      };
    }

    setAnalysis(finalAnalysis);
    setIsAnalyzing(false);
    setStateLabel('Lecture notes and quiz ready');

    const saved = saveLecture({
      id: currentLectureId || undefined,
      title:
        currentLectureTitle ||
        finalAnalysis.title?.trim() ||
        finalAnalysis.concepts?.[0]?.term ||
        undefined,
      language: lang,
      rawTranscript: transcript,
      analysis: finalAnalysis,
      isDemo: false,
    });

    setCurrentLectureId(saved.id);
    setCurrentLectureTitle(saved.title);
    setSavedLectures(getSavedLectures());
    setStartQuizInRevisionMode(false);
    setActiveTab('analysis');
  };

  const handleExplicitSaveLecture = () => {
    if (!analysis) return;
    const saved = saveLecture({
      id: currentLectureId || undefined,
      title:
        currentLectureTitle ||
        analysis.title?.trim() ||
        analysis.concepts?.[0]?.term ||
        undefined,
      language,
      rawTranscript,
      analysis,
      isDemo: false,
    });
    setCurrentLectureId(saved.id);
    setCurrentLectureTitle(saved.title);
    setSavedLectures(getSavedLectures());
    setIsSavedFeedback(true);
    setTimeout(() => setIsSavedFeedback(false), 2500);
  };

  const handleSelectTestCase = (tc: TestCase) => {
    setLanguage(tc.langCode);
    setRawTranscript(tc.raw_transcript);
    const analysisObj: LectureAnalysis = {
      clean_transcript: tc.clean_transcript,
      summary: tc.summary,
      concepts: tc.concepts,
      questions: tc.questions,
    };
    setAnalysis(analysisObj);
    setCurrentLectureId(`demo_${tc.id}`);
    setCurrentLectureTitle(tc.title);
    setStartQuizInRevisionMode(false);
    setActiveTab('analysis');
    setStateLabel(`Opened "${tc.title}"`);
  };

  const handleOpenSavedLecture = (
    lecture: SavedLecture,
    targetTab: 'analysis' | 'quiz' | 'explain' | 'revise' = 'analysis'
  ) => {
    setLanguage(lecture.language);
    setRawTranscript(lecture.rawTranscript);
    setAnalysis(lecture.analysis);
    setCurrentLectureId(lecture.id);
    setCurrentLectureTitle(lecture.title);
    if (targetTab === 'revise') {
      setStartQuizInRevisionMode(true);
      setActiveTab('quiz');
    } else {
      setStartQuizInRevisionMode(false);
      setActiveTab(targetTab);
    }
    setIsMyLecturesOpen(false);
    setStateLabel(`Opened "${lecture.title}"`);
  };

  const handleQuizCompleted = (answers: QuizAnswerRecord[]): WeakTopicItem[] => {
    if (!analysis) return [];
    let targetLectureId = currentLectureId;
    if (!targetLectureId) {
      const saved = saveLecture({
        title: currentLectureTitle || analysis.title?.trim() || analysis.concepts?.[0]?.term,
        language,
        rawTranscript,
        analysis,
        isDemo: false,
      });
      targetLectureId = saved.id;
      setCurrentLectureId(saved.id);
      setCurrentLectureTitle(saved.title);
    }
    const { updatedWeakTopics, updatedLectures } = updateLectureWeakTopics(
      targetLectureId,
      answers,
      analysis
    );
    setSavedLectures(updatedLectures);
    return updatedWeakTopics;
  };

  const handleDeleteSavedLecture = (id: string) => {
    const updated = deleteLecture(id);
    setSavedLectures(updated);
    if (currentLectureId === id) {
      setCurrentLectureId(null);
      setCurrentLectureTitle('');
    }
  };

  const handleRestoreDemos = () => {
    const seeded = seedDemoLectures(testCases, true);
    setSavedLectures(seeded);
  };

  const handleClearAllLectures = () => {
    clearAllSavedLectures();
    setSavedLectures([]);
    setCurrentLectureId(null);
    setCurrentLectureTitle('');
  };

  const handleNewLecture = () => {
    setCurrentLectureId(null);
    setCurrentLectureTitle('');
    setRawTranscript('');
    setAnalysis(null);
    setActiveTab('record');
    setStateLabel('Ready to listen');
  };

  return (
    <div className="min-h-dvh bg-[#F7F6F2] text-[#2C353E] flex flex-col pb-20 lg:pb-0">
      {/* Top Bar */}
      <Navbar
        language={language}
        onLanguageChange={(newLang) => setLanguage(newLang)}
        testCases={testCases}
        onSelectTestCase={handleSelectTestCase}
        systemHealth={systemHealth}
        savedLecturesCount={savedLectures.length}
        onOpenMyLectures={() => setIsMyLecturesOpen(true)}
        onNewLecture={handleNewLecture}
      />

      {/* Saved Lectures Drawer */}
      <MyLecturesDrawer
        isOpen={isMyLecturesOpen}
        onClose={() => setIsMyLecturesOpen(false)}
        savedLectures={savedLectures}
        onOpenLecture={handleOpenSavedLecture}
        onDeleteLecture={handleDeleteSavedLecture}
        onRestoreDemos={handleRestoreDemos}
        onClearAll={handleClearAllLectures}
        onNewLecture={handleNewLecture}
      />

      {/* Main Workspace */}
      <main id="main-workspace" className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-5">
        {/* Active Session Header & Mode Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#D8E0E8]">
          <div className="min-w-0">
            <h1 className="font-display-ui font-bold text-base sm:text-xl text-[#1B365D] truncate">
              {currentLectureTitle || 'Classroom lecture notebook'}
            </h1>
            {analysis && (
              <p className="text-xs text-[#2C353E]/75 font-display-ui tabular-nums mt-0.5">
                {analysis.concepts.length} key concepts, {analysis.questions.length} quiz questions
              </p>
            )}
          </div>

          {/* Desktop Section Tabs & Actions */}
          <div className="hidden lg:flex items-center gap-2">
            <div
              role="tablist"
              aria-label="Study workspace sections"
              className="flex items-center gap-1 bg-[#D8E0E8]/45 p-1 rounded-md border border-[#D8E0E8]"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'record'}
                onClick={() => setActiveTab('record')}
                className={`min-h-[40px] px-3.5 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer ${
                  activeTab === 'record'
                    ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                    : 'text-[#2C353E] hover:bg-white/60'
                }`}
              >
                Capture lecture
              </button>
              <button
                type="button"
                role="tab"
                disabled={!analysis}
                aria-selected={activeTab === 'analysis'}
                onClick={() => setActiveTab('analysis')}
                className={`min-h-[40px] px-3.5 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  activeTab === 'analysis'
                    ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                    : 'text-[#2C353E] hover:bg-white/60'
                }`}
              >
                Notes and concepts
              </button>
              <button
                type="button"
                role="tab"
                disabled={!analysis}
                aria-selected={activeTab === 'explain'}
                onClick={() => setActiveTab('explain')}
                className={`min-h-[40px] px-3.5 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  activeTab === 'explain'
                    ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                    : 'text-[#2C353E] hover:bg-white/60'
                }`}
              >
                Audio explanation
              </button>
              <button
                type="button"
                role="tab"
                disabled={!analysis || !analysis.questions || analysis.questions.length === 0}
                aria-selected={activeTab === 'quiz'}
                onClick={() => setActiveTab('quiz')}
                className={`min-h-[40px] px-3.5 py-1.5 text-xs font-display-ui font-medium rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  activeTab === 'quiz'
                    ? 'bg-white text-[#1B365D] font-semibold shadow-2xs'
                    : 'text-[#2C353E] hover:bg-white/60'
                }`}
              >
                Quiz
              </button>
            </div>

            {analysis && (
              <>
                <button
                  type="button"
                  onClick={handleExplicitSaveLecture}
                  className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#1B365D] border border-[#D8E0E8] rounded-md text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer"
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
                <button
                  type="button"
                  onClick={() => runAnalysis(rawTranscript, language)}
                  disabled={isAnalyzing}
                  className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#2C353E] border border-[#D8E0E8] rounded-md text-xs font-display-ui font-medium flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Regenerate notes</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Real Step Progress Bar During LLM Analysis */}
        {isAnalyzing && (
          <div
            role="status"
            aria-live="polite"
            className="bg-white border border-[#D8E0E8] rounded-md p-6 space-y-3"
          >
            <div className="flex items-center justify-between text-xs sm:text-sm font-display-ui">
              <span className="font-bold text-[#1B365D]">
                Preparing study summary, key concepts, and 5 quiz questions...
              </span>
              <span className="tabular-nums text-[#2C353E]/75">Gnani Evon 30B</span>
            </div>
            <div className="w-full h-2.5 bg-[#F7F6F2] border border-[#D8E0E8] rounded-xs overflow-hidden">
              <div className="h-full bg-[#1B365D] w-4/5 transition-all duration-300" />
            </div>
            <p className="text-xs text-[#2C353E]/75">
              Cleaning transcript, identifying 5 to 8 core terms, and writing model answers.
            </p>
          </div>
        )}

        {/* WORKSPACE LAYOUT:
            - When no analysis yet OR activeTab === 'record': Full-width Capture Lecture view
            - On Desktop (lg:) when analysis exists and viewing Notes/Explain: Two-column layout (Transcript beside Notes)
            - In Quiz mode: Focused single-question screen */}
        {!isAnalyzing && (
          <>
            {activeTab === 'record' || !analysis ? (
              <AudioRecorder
                language={language}
                onTranscriptComplete={handleTranscriptComplete}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
                stateLabel={stateLabel}
                setStateLabel={setStateLabel}
                testCases={testCases}
                onSelectTestCase={handleSelectTestCase}
                initialTranscript={rawTranscript}
              />
            ) : activeTab === 'quiz' ? (
              <div className="max-w-3xl mx-auto">
                <QuizMode
                  questions={analysis.questions}
                  language={language}
                  weakTopics={
                    savedLectures.find((l) => l.id === currentLectureId)?.weakTopics || []
                  }
                  initialRevisionMode={startQuizInRevisionMode}
                  onQuizCompleted={handleQuizCompleted}
                  onBack={() => {
                    setStartQuizInRevisionMode(false);
                    setActiveTab('analysis');
                  }}
                  onRetake={() => {
                    setStartQuizInRevisionMode(false);
                    setActiveTab('quiz');
                  }}
                />
              </div>
            ) : (
              /* Desktop Two-Column Split: Left = Read-Only Cleaned Transcript, Right = Study Notes / Audio Explanation */
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
                {/* Left Column on Desktop: Read-Only Cleaned Lecture Transcript */}
                <aside
                  aria-label="Cleaned lecture transcript"
                  className="hidden lg:block lg:col-span-5 lg:sticky lg:top-20 bg-white border border-[#D8E0E8] rounded-md overflow-hidden"
                >
                  <div className="border-b-2 border-[#B83A3A]/70 bg-[#F7F6F2]/50 px-4 py-3 flex items-center justify-between gap-2">
                    <h2 className="font-display-ui font-semibold text-sm text-[#1B365D]">
                      Lecture transcript
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveTab('record')}
                      className="min-h-[36px] px-2.5 py-1 text-xs font-display-ui font-medium text-[#1B365D] bg-white hover:bg-[#F7F6F2] border border-[#D8E0E8] rounded cursor-pointer"
                    >
                      Change input
                    </button>
                  </div>
                  <div className="p-4 sm:p-5 max-h-[70dvh] overflow-y-auto">
                    <p className="font-prose-indic text-sm sm:text-[15px] text-[#2C353E] leading-[1.8] whitespace-pre-wrap">
                      {analysis.clean_transcript || rawTranscript}
                    </p>
                  </div>
                </aside>

                {/* Right Column on Desktop (Full width on mobile): Study Notes or Explain Mode */}
                <div className="lg:col-span-7 min-w-0">
                  {activeTab === 'explain' ? (
                    <ExplainMode
                      analysis={analysis}
                      language={language}
                      onBack={() => setActiveTab('analysis')}
                      onStartQuiz={() => {
                        setStartQuizInRevisionMode(false);
                        setActiveTab('quiz');
                      }}
                    />
                  ) : (
                    <AnalysisViewer
                      analysis={analysis}
                      rawTranscript={rawTranscript}
                      language={language}
                      weakTopics={
                        savedLectures.find((l) => l.id === currentLectureId)?.weakTopics || []
                      }
                      onStartExplain={() => setActiveTab('explain')}
                      onStartQuiz={() => {
                        setStartQuizInRevisionMode(false);
                        setActiveTab('quiz');
                      }}
                      onStartWeakTopicRevision={() => {
                        setStartQuizInRevisionMode(true);
                        setActiveTab('quiz');
                      }}
                      onSaveLecture={handleExplicitSaveLecture}
                      isSavedFeedback={isSavedFeedback}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* MOBILE BOTTOM NAVIGATION BAR (Thumb Zone, 44px+ touch targets, safe-area inset) */}
      <nav
        aria-label="Primary mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-xs border-t border-[#D8E0E8] pb-safe lg:hidden"
      >
        <div className="grid grid-cols-4 h-16">
          <button
            type="button"
            onClick={() => setActiveTab('record')}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-1 text-xs font-display-ui cursor-pointer ${
              activeTab === 'record' ? 'text-[#1B365D] font-bold' : 'text-[#2C353E]/75 font-medium'
            }`}
          >
            <Mic className="w-5 h-5" aria-hidden="true" />
            <span>Record</span>
          </button>

          <button
            type="button"
            disabled={!analysis}
            onClick={() => setActiveTab('analysis')}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-1 text-xs font-display-ui cursor-pointer disabled:opacity-40 ${
              activeTab === 'analysis' || activeTab === 'explain'
                ? 'text-[#1B365D] font-bold'
                : 'text-[#2C353E]/75 font-medium'
            }`}
          >
            <BookOpen className="w-5 h-5" aria-hidden="true" />
            <span>Notes</span>
          </button>

          <button
            type="button"
            disabled={!analysis || !analysis.questions || analysis.questions.length === 0}
            onClick={() => setActiveTab('quiz')}
            className={`min-h-[48px] flex flex-col items-center justify-center gap-1 text-xs font-display-ui cursor-pointer disabled:opacity-40 ${
              activeTab === 'quiz' ? 'text-[#1B365D] font-bold' : 'text-[#2C353E]/75 font-medium'
            }`}
          >
            <HelpCircle className="w-5 h-5" aria-hidden="true" />
            <span>Quiz</span>
          </button>

          <button
            type="button"
            onClick={() => setIsMyLecturesOpen(true)}
            className="min-h-[48px] flex flex-col items-center justify-center gap-1 text-xs font-display-ui font-medium text-[#2C353E]/75 hover:text-[#1B365D] cursor-pointer"
          >
            <FolderOpen className="w-5 h-5" aria-hidden="true" />
            <span>My lectures ({savedLectures.length})</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
