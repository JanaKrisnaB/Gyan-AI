export type SupportedLanguage = 'en' | 'hi' | 'ta' | 'auto';

export interface Concept {
  term: string;
  explanation: string;
}

export interface QuizQuestion {
  q: string;
  model_answer: string;
}

export interface LectureAnalysis {
  title?: string;
  clean_transcript: string;
  summary: string;
  concepts: Concept[];
  questions: QuizQuestion[];
}

export type Verdict = 'correct' | 'partial' | 'wrong';

export interface QuizEvaluation {
  verdict: Verdict;
  feedback: string;
  english_user_answer?: string;
}

export interface QuizAnswerRecord {
  questionIndex: number;
  question: string;
  modelAnswer: string;
  userAnswer: string;
  verdict: Verdict;
  feedback: string;
}

export interface LectureAskResponse {
  english_question: string;
  covered_in_lecture: boolean;
  answer: string;
  transcript_quote?: string;
}

export interface WeakTopicItem {
  id: string;
  term: string;
  explanation: string;
  question: string;
  model_answer: string;
  lastVerdict: 'partial' | 'wrong';
  updatedAt: string;
}

export interface TestCase {
  id: string;
  title: string;
  language: string;
  langCode: SupportedLanguage;
  raw_transcript: string;
  clean_transcript: string;
  summary: string;
  concepts: Concept[];
  questions: QuizQuestion[];
  sample_student_answers?: Array<{
    question_index: number;
    input: string;
    expected_verdict: Verdict;
  }>;
}

export interface SavedLecture {
  id: string;
  title: string;
  createdAt: string; // ISO string
  language: SupportedLanguage;
  rawTranscript: string;
  analysis: LectureAnalysis;
  isDemo?: boolean;
  wordCount?: number;
  weakTopics?: WeakTopicItem[];
  lastQuizScore?: number;
}

export type AppState = 'idle' | 'recording' | 'transcribing' | 'analyzing' | 'ready' | 'error';
