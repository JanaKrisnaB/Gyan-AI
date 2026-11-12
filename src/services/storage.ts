import {
  SavedLecture,
  LectureAnalysis,
  SupportedLanguage,
  TestCase,
  QuizAnswerRecord,
  WeakTopicItem,
} from '../types';

const STORAGE_KEY = 'gyan_ai_saved_lectures';

/**
 * Retrieve all saved lectures from localStorage
 */
export function getSavedLectures(): SavedLecture[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.warn('Failed to parse saved lectures from localStorage:', err);
  }
  return [];
}

/**
 * Save or update a lecture in localStorage
 */
export function saveLecture(
  lecture: {
    id?: string;
    title?: string;
    createdAt?: string;
    language: SupportedLanguage;
    rawTranscript: string;
    analysis: LectureAnalysis;
    isDemo?: boolean;
    wordCount?: number;
    weakTopics?: WeakTopicItem[];
    lastQuizScore?: number;
  }
): SavedLecture {
  const lectures = getSavedLectures();
  const id = lecture.id || `lec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const existingIndex = lectures.findIndex((l) => l.id === id);
  const existingLecture = existingIndex >= 0 ? lectures[existingIndex] : undefined;
  const createdAt = lecture.createdAt || existingLecture?.createdAt || new Date().toISOString();

  // Generate a clean title if not provided, prioritizing LLM-generated analysis.title
  let title = lecture.title?.trim() || lecture.analysis.title?.trim() || existingLecture?.title;
  if (!title) {
    if (lecture.analysis.concepts && lecture.analysis.concepts.length > 0) {
      title = `${lecture.analysis.concepts[0].term}`;
    } else if (lecture.analysis.summary) {
      title = lecture.analysis.summary.slice(0, 45).replace(/\.+$/, '');
    } else {
      title = `Lecture (${new Date(createdAt).toLocaleDateString()})`;
    }
  }

  const wordCount =
    lecture.wordCount || lecture.rawTranscript.trim().split(/\s+/).filter(Boolean).length;

  const newLecture: SavedLecture = {
    id,
    title,
    createdAt,
    language: lecture.language,
    rawTranscript: lecture.rawTranscript,
    analysis: lecture.analysis,
    isDemo: lecture.isDemo !== undefined ? Boolean(lecture.isDemo) : Boolean(existingLecture?.isDemo),
    wordCount,
    weakTopics: lecture.weakTopics !== undefined ? lecture.weakTopics : existingLecture?.weakTopics || [],
    lastQuizScore:
      lecture.lastQuizScore !== undefined ? lecture.lastQuizScore : existingLecture?.lastQuizScore,
  };

  if (existingIndex >= 0) {
    lectures[existingIndex] = newLecture;
  } else {
    lectures.unshift(newLecture);
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lectures));
  } catch (err) {
    console.error('Failed to save lecture to localStorage:', err);
  }

  return newLecture;
}

/**
 * Match a quiz question to the most relevant concept in the lecture analysis
 */
function findMatchingConceptForQuestion(
  question: string,
  modelAnswer: string,
  questionIndex: number,
  analysis: LectureAnalysis
): { term: string; explanation: string } {
  const concepts = analysis.concepts || [];
  if (concepts.length === 0) {
    return {
      term: `Topic ${questionIndex + 1}`,
      explanation: modelAnswer,
    };
  }

  const combinedLower = `${question} ${modelAnswer}`.toLowerCase();
  for (const c of concepts) {
    if (c.term && combinedLower.includes(c.term.toLowerCase())) {
      return c;
    }
  }

  // Secondary match: check word overlap with concept term
  let bestConcept = concepts[questionIndex % concepts.length];
  let bestScore = -1;
  for (const c of concepts) {
    const termWords = (c.term || '').toLowerCase().match(/\w+/g) || [];
    let score = 0;
    for (const w of termWords) {
      if (w.length > 2 && combinedLower.includes(w)) {
        score += 2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestConcept = c;
    }
  }

  return bestConcept;
}

/**
 * Update weak topics for a lecture after a quiz or targeted weak-topic re-quiz.
 * - Questions answered 'wrong' or 'partial' are added/updated in weakTopics.
 * - Questions answered 'correct' are removed from weakTopics (mastered!).
 */
export function updateLectureWeakTopics(
  lectureId: string | null,
  answers: QuizAnswerRecord[],
  analysis: LectureAnalysis
): { updatedWeakTopics: WeakTopicItem[]; updatedLectures: SavedLecture[] } {
  const lectures = getSavedLectures();
  const existingLecture = lectureId ? lectures.find((l) => l.id === lectureId) : undefined;
  const weakMap = new Map<string, WeakTopicItem>();

  // Seed with existing weak topics for this lecture
  if (existingLecture?.weakTopics) {
    for (const wt of existingLecture.weakTopics) {
      weakMap.set(wt.question.trim().toLowerCase(), wt);
    }
  }

  for (const ans of answers) {
    const key = ans.question.trim().toLowerCase();
    if (ans.verdict === 'correct') {
      // Student mastered this topic — remove from weak topics
      weakMap.delete(key);
    } else {
      const matchedConcept = findMatchingConceptForQuestion(
        ans.question,
        ans.modelAnswer,
        ans.questionIndex,
        analysis
      );
      weakMap.set(key, {
        id: `wt_${ans.questionIndex}_${key.slice(0, 24).replace(/\W+/g, '_')}`,
        term: matchedConcept.term,
        explanation: matchedConcept.explanation,
        question: ans.question,
        model_answer: ans.modelAnswer,
        lastVerdict: ans.verdict,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const updatedWeakTopics = Array.from(weakMap.values());
  const correctCount = answers.filter((a) => a.verdict === 'correct').length;
  const scorePercent =
    answers.length > 0 ? Math.round((correctCount / answers.length) * 100) : undefined;

  if (existingLecture) {
    existingLecture.weakTopics = updatedWeakTopics;
    if (scorePercent !== undefined) {
      existingLecture.lastQuizScore = scorePercent;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lectures));
    } catch (err) {
      console.error('Failed to persist weak topics to localStorage:', err);
    }
  }

  return { updatedWeakTopics, updatedLectures: lectures };
}

/**
 * Delete a lecture by ID
 */
export function deleteLecture(id: string): SavedLecture[] {
  const lectures = getSavedLectures();
  const updated = lectures.filter((l) => l.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to update localStorage after delete:', err);
  }
  return updated;
}

/**
 * Clear all saved lectures
 */
export function clearAllSavedLectures(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Failed to clear localStorage:', err);
  }
}

/**
 * Pre-seed demo lectures from test cases if storage is empty or on user request
 */
export function seedDemoLectures(testCases: TestCase[], force: boolean = false): SavedLecture[] {
  const current = getSavedLectures();
  if (!force && current.length > 0) {
    return current;
  }

  const demoLectures: SavedLecture[] = testCases.map((tc, index) => {
    const wordCount = tc.raw_transcript.split(/\s+/).filter(Boolean).length;
    return {
      id: `demo_${tc.id}`,
      title: tc.title,
      createdAt: new Date(Date.now() - (index * 86400000 + 3600000)).toISOString(),
      language: tc.langCode,
      rawTranscript: tc.raw_transcript,
      analysis: {
        clean_transcript: tc.clean_transcript,
        summary: tc.summary,
        concepts: tc.concepts,
        questions: tc.questions,
      },
      isDemo: true,
      wordCount,
    };
  });

  const merged = force ? demoLectures : [...current, ...demoLectures];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch (err) {
    console.error('Failed to seed demo lectures:', err);
  }
  return merged;
}

/**
 * Export saved lectures as a JSON string
 */
export function exportLecturesJson(): string {
  const lectures = getSavedLectures();
  return JSON.stringify(lectures, null, 2);
}

/**
 * Import lectures from a JSON string
 */
export function importLecturesJson(jsonStr: string): SavedLecture[] | null {
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      const validLectures: SavedLecture[] = parsed.filter(
        (l) => l && l.id && l.analysis && l.rawTranscript
      );
      if (validLectures.length > 0) {
        const existing = getSavedLectures();
        const existingIds = new Set(existing.map((l) => l.id));
        const merged = [...existing];
        
        validLectures.forEach((vl) => {
          if (!existingIds.has(vl.id)) {
            merged.push(vl);
            existingIds.add(vl.id);
          }
        });

        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        return merged;
      }
    }
  } catch (err) {
    console.error('Failed to import lectures JSON:', err);
  }
  return null;
}
