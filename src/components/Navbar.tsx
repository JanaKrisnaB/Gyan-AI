import React, { useState, useRef, useEffect } from 'react';
import { SupportedLanguage, TestCase } from '../types';
import { FolderOpen, Plus, ChevronDown } from 'lucide-react';

interface NavbarProps {
  language: SupportedLanguage;
  onLanguageChange: (lang: SupportedLanguage) => void;
  testCases: TestCase[];
  onSelectTestCase: (tc: TestCase) => void;
  systemHealth: { status: string; gnani_configured: boolean; gemini_configured: boolean };
  savedLecturesCount: number;
  onOpenMyLectures: () => void;
  onNewLecture?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  language,
  onLanguageChange,
  testCases,
  onSelectTestCase,
  savedLecturesCount,
  onOpenMyLectures,
  onNewLecture,
}) => {
  const [samplesOpen, setSamplesOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setSamplesOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-30 bg-[#F7F6F2]/95 backdrop-blur-xs border-b border-[#D8E0E8]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-3">
        {/* Zone 1: Brand Title */}
        <div className="flex items-center gap-3 shrink-0">
          <a
            href="#main-workspace"
            onClick={(e) => {
              e.preventDefault();
              if (onNewLecture) onNewLecture();
            }}
            className="font-display-ui font-bold text-lg sm:text-xl tracking-tight text-[#1B365D] whitespace-nowrap shrink-0"
          >
            Gyan AI
          </a>
        </div>

        {/* Zone 2: Language Selector & Sample Lectures */}
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2">
            <label
              htmlFor="lecture-language-select"
              className="sr-only sm:not-sr-only text-xs font-medium text-[#2C353E] whitespace-nowrap"
            >
              Lecture language
            </label>
            <select
              id="lecture-language-select"
              value={language}
              onChange={(e) => onLanguageChange(e.target.value as SupportedLanguage)}
              className="min-h-[44px] px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] bg-white border border-[#D8E0E8] rounded-md focus:border-[#1B365D] cursor-pointer"
            >
              <option value="hi">Hindi-English (Hinglish)</option>
              <option value="ta">Tamil-English (Tanglish)</option>
              <option value="en">English (Indian)</option>
              <option value="auto">Auto detect</option>
            </select>
          </div>

          {testCases.length > 0 && (
            <div className="relative hidden md:block" ref={dropdownRef}>
              <button
                type="button"
                aria-expanded={samplesOpen}
                aria-haspopup="listbox"
                onClick={() => setSamplesOpen((prev) => !prev)}
                className="min-h-[44px] px-3 py-1.5 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] bg-white hover:bg-[#F7F6F2] border border-[#D8E0E8] rounded-md flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
              >
                <span>Load sample lecture</span>
                <ChevronDown className="w-4 h-4 text-[#1B365D]" aria-hidden="true" />
              </button>

              {samplesOpen && (
                <div
                  role="menu"
                  aria-label="Sample lectures"
                  className="absolute right-0 mt-1 w-80 bg-white border border-[#D8E0E8] rounded-md shadow-sm py-1 z-50"
                >
                  {testCases.map((tc) => (
                    <button
                      key={tc.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSamplesOpen(false);
                        onSelectTestCase(tc);
                      }}
                      className="w-full text-left px-3.5 py-2.5 text-xs sm:text-sm hover:bg-[#F7F6F2] border-b border-[#D8E0E8]/60 last:border-none flex flex-col gap-0.5 cursor-pointer"
                    >
                      <span className="font-display-ui font-semibold text-[#1B365D]">
                        {tc.title}
                      </span>
                      <span className="text-xs text-[#2C353E]/75">{tc.language}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Zone 3: Desktop My Lectures & New Lecture Actions */}
        <div className="hidden lg:flex items-center gap-2.5 shrink-0">
          {onNewLecture && (
            <button
              type="button"
              onClick={onNewLecture}
              className="min-h-[44px] px-3.5 py-2 text-xs sm:text-sm font-display-ui font-medium text-[#2C353E] bg-white hover:bg-[#F7F6F2] border border-[#D8E0E8] rounded-md flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4 text-[#1B365D]" aria-hidden="true" />
              <span>New lecture</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenMyLectures}
            className="min-h-[44px] px-3.5 py-2 text-xs sm:text-sm font-display-ui font-semibold text-white bg-[#1B365D] hover:bg-[#142947] rounded-md flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0"
          >
            <FolderOpen className="w-4 h-4" aria-hidden="true" />
            <span>My lectures ({savedLecturesCount})</span>
          </button>
        </div>
      </div>
    </header>
  );
};
