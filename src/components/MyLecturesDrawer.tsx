import React, { useState } from 'react';
import { SavedLecture, SupportedLanguage } from '../types';
import {
  X,
  Search,
  Trash2,
  Download,
  RotateCcw,
  Plus,
} from 'lucide-react';

interface MyLecturesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  savedLectures: SavedLecture[];
  onOpenLecture: (lecture: SavedLecture, targetTab?: 'analysis' | 'quiz' | 'explain' | 'revise') => void;
  onDeleteLecture: (id: string) => void;
  onRestoreDemos: () => void;
  onClearAll: () => void;
  onNewLecture: () => void;
}

export const MyLecturesDrawer: React.FC<MyLecturesDrawerProps> = ({
  isOpen,
  onClose,
  savedLectures,
  onOpenLecture,
  onDeleteLecture,
  onRestoreDemos,
  onClearAll,
  onNewLecture,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLang, setSelectedLang] = useState<string>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState<boolean>(false);

  if (!isOpen) return null;

  const filteredLectures = savedLectures.filter((l) => {
    const matchesSearch =
      l.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.analysis.summary.toLowerCase().includes(searchTerm.toLowerCase()) ||
      l.analysis.concepts.some((c) => c.term.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesLang =
      selectedLang === 'all' ||
      (selectedLang === 'hi' && l.language === 'hi') ||
      (selectedLang === 'ta' && l.language === 'ta') ||
      (selectedLang === 'en' && l.language === 'en');

    return matchesSearch && matchesLang;
  });

  const getLangName = (lang: SupportedLanguage) => {
    switch (lang) {
      case 'hi':
        return 'Hindi-English';
      case 'ta':
        return 'Tamil-English';
      case 'en':
        return 'Indian English';
      default:
        return 'Auto detect';
    }
  };

  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return 'Saved recently';
    }
  };

  const handleExportJson = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(savedLectures, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute(
      'download',
      `gyan_ai_lectures_${new Date().toISOString().slice(0, 10)}.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="my-lectures-title"
      className="fixed inset-0 z-50 overflow-hidden flex justify-end"
    >
      <div
        className="fixed inset-0 bg-[#2C353E]/40 transition-opacity"
        onClick={onClose}
      />

      <div className="relative w-full max-w-xl bg-[#F7F6F2] h-dvh flex flex-col z-10 border-l border-[#D8E0E8]">
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-[#D8E0E8] bg-white flex items-center justify-between gap-3">
          <div>
            <h2 id="my-lectures-title" className="font-display-ui font-bold text-lg text-[#1B365D]">
              My lectures ({savedLectures.length})
            </h2>
            <p className="text-xs text-[#2C353E]/75">
              Open saved lecture notes and practice quizzes offline
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onNewLecture();
              }}
              className="min-h-[44px] px-3.5 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs font-display-ui font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>New lecture</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close My lectures"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center text-[#2C353E] hover:bg-[#F7F6F2] rounded-md cursor-pointer"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Search & Language Filter */}
        <div className="p-4 bg-white border-b border-[#D8E0E8] space-y-3">
          <div className="relative">
            <label htmlFor="search-saved-lectures" className="sr-only">
              Search saved lectures
            </label>
            <Search
              className="w-4 h-4 text-[#2C353E]/50 absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              id="search-saved-lectures"
              type="search"
              placeholder="Search by topic or concept..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full min-h-[44px] pl-9 pr-3 py-2 text-xs sm:text-sm bg-[#F7F6F2] border border-[#D8E0E8] rounded-md text-[#2C353E] placeholder-[#2C353E]/50 focus:border-[#1B365D]"
            />
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1">
              {(['all', 'hi', 'ta', 'en'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setSelectedLang(lang)}
                  className={`min-h-[40px] px-3 py-1.5 rounded-md text-xs font-display-ui font-medium cursor-pointer ${
                    selectedLang === lang
                      ? 'bg-[#1B365D] text-white'
                      : 'bg-[#F7F6F2] text-[#2C353E] border border-[#D8E0E8]'
                  }`}
                >
                  {lang === 'all'
                    ? 'All languages'
                    : lang === 'hi'
                    ? 'Hinglish'
                    : lang === 'ta'
                    ? 'Tanglish'
                    : 'English'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onRestoreDemos}
              className="min-h-[40px] px-2.5 text-xs font-display-ui font-medium text-[#1B365D] hover:underline flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Load sample lectures</span>
            </button>
          </div>
        </div>

        {/* Lectures List or Action-Inviting Empty State */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredLectures.length === 0 ? (
            <div className="bg-white border border-[#D8E0E8] rounded-md p-6 space-y-4">
              <h3 className="font-display-ui font-bold text-base text-[#1B365D]">
                {searchTerm ? `No lectures match "${searchTerm}"` : 'Your notebook is empty'}
              </h3>
              <p className="text-xs sm:text-sm text-[#2C353E]/80 font-prose-indic">
                {searchTerm
                  ? 'Clear your search filter to see all saved lectures, or record a new class session.'
                  : 'Record a live classroom lecture or load the sample Tamil-English and Hindi-English sessions to begin revising.'}
              </p>
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onNewLecture();
                  }}
                  className="min-h-[44px] px-4 py-2 bg-[#1B365D] hover:bg-[#142947] text-white text-xs sm:text-sm font-display-ui font-semibold rounded-md cursor-pointer"
                >
                  Start recording a lecture
                </button>
                <button
                  type="button"
                  onClick={onRestoreDemos}
                  className="min-h-[44px] px-4 py-2 bg-white hover:bg-[#F7F6F2] text-[#1B365D] border border-[#D8E0E8] text-xs sm:text-sm font-display-ui font-medium rounded-md cursor-pointer"
                >
                  Load sample lectures
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-[#D8E0E8] rounded-md divide-y divide-[#D8E0E8]">
              {filteredLectures.map((lecture) => (
                <div key={lecture.id} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <h3 className="font-display-ui font-bold text-sm sm:text-base text-[#1B365D]">
                        {lecture.title}
                      </h3>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#2C353E]/70 font-display-ui tabular-nums">
                        <span>{getLangName(lecture.language)}</span>
                        <span>{lecture.analysis.concepts?.length || 0} concepts</span>
                        <span>{lecture.analysis.questions?.length || 0} questions</span>
                        {lecture.lastQuizScore !== undefined && (
                          <span className="font-semibold text-[#1B365D]">
                            Last quiz: {lecture.lastQuizScore}%
                          </span>
                        )}
                        {lecture.weakTopics && lecture.weakTopics.length > 0 && (
                          <span className="font-semibold text-[#B83A3A]">
                            {lecture.weakTopics.length} weak{' '}
                            {lecture.weakTopics.length === 1 ? 'topic' : 'topics'}
                          </span>
                        )}
                        <span>{formatDate(lecture.createdAt)}</span>
                      </div>
                    </div>

                    <div>
                      {confirmDeleteId === lecture.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              onDeleteLecture(lecture.id);
                              setConfirmDeleteId(null);
                            }}
                            className="min-h-[40px] px-2.5 py-1 text-xs font-display-ui font-semibold bg-[#B83A3A] text-white rounded-md cursor-pointer"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="min-h-[40px] px-2.5 py-1 text-xs font-display-ui text-[#2C353E] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Delete ${lecture.title}`}
                          onClick={() => setConfirmDeleteId(lecture.id)}
                          className="min-h-[44px] min-w-[44px] -m-1.5 flex items-center justify-center text-[#2C353E]/60 hover:text-[#B83A3A] cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-[#2C353E] line-clamp-2 font-prose-indic">
                    {lecture.analysis.summary}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => onOpenLecture(lecture, 'analysis')}
                      className="min-h-[44px] px-3.5 py-2 bg-[#1B365D] hover:bg-[#142947] text-white rounded-md text-xs font-display-ui font-semibold cursor-pointer"
                    >
                      Open notes
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenLecture(lecture, 'quiz')}
                      className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#1B365D] border border-[#D8E0E8] rounded-md text-xs font-display-ui font-medium cursor-pointer"
                    >
                      Start quiz
                    </button>
                    {lecture.weakTopics && lecture.weakTopics.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onOpenLecture(lecture, 'revise')}
                        className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#B83A3A] border border-[#B83A3A] rounded-md text-xs font-display-ui font-semibold cursor-pointer"
                      >
                        Revise {lecture.weakTopics.length} weak{' '}
                        {lecture.weakTopics.length === 1 ? 'topic' : 'topics'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenLecture(lecture, 'explain')}
                      className="min-h-[44px] px-3.5 py-2 bg-white hover:bg-[#F7F6F2] text-[#2C353E] border border-[#D8E0E8] rounded-md text-xs font-display-ui font-medium cursor-pointer"
                    >
                      Listen aloud
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[#D8E0E8] bg-white pb-safe flex items-center justify-between gap-3 text-xs font-display-ui text-[#2C353E]">
          <button
            type="button"
            onClick={handleExportJson}
            disabled={savedLectures.length === 0}
            className="min-h-[44px] px-3 py-2 border border-[#D8E0E8] rounded-md flex items-center gap-1.5 hover:bg-[#F7F6F2] disabled:opacity-40 cursor-pointer"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Export lectures (JSON)</span>
          </button>

          {savedLectures.length > 0 && (
            <div>
              {confirmClearAll ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClearAll();
                      setConfirmClearAll(false);
                    }}
                    className="min-h-[40px] px-3 py-1.5 bg-[#B83A3A] text-white rounded-md font-semibold cursor-pointer"
                  >
                    Confirm clear all
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearAll(false)}
                    className="min-h-[40px] px-2.5 py-1.5 text-[#2C353E] cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(true)}
                  className="min-h-[44px] px-3 py-2 text-[#B83A3A] hover:underline cursor-pointer"
                >
                  Clear all lectures
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
