import { LectureAnalysis, QuizEvaluation, TestCase, SupportedLanguage } from '../types';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

export async function transcribeAudioChunk(
  audioBlob: Blob | File,
  language: SupportedLanguage,
  chunkIndex: number = 0,
  totalChunks: number = 1
): Promise<{ transcript: string; is_final: boolean; source?: string; notice?: string; model?: string }> {
  const fileName = audioBlob instanceof File && audioBlob.name ? audioBlob.name : 'lecture.webm';

  // Materialize the Blob into an in-memory ArrayBuffer immediately so stopping MediaStream tracks
  // never invalidates the underlying browser Blob reference during upload.
  const arrayBuffer = await audioBlob.arrayBuffer();

  // For recordings and files <= 15 MB, send as JSON base64 first to avoid browser multipart stream resets
  if (arrayBuffer.byteLength <= 15 * 1024 * 1024) {
    try {
      const audioBase64 = arrayBufferToBase64(arrayBuffer);
      const jsonResponse = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_base64: audioBase64,
          filename: fileName,
          language,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
        }),
      });

      if (!jsonResponse.ok) {
        const err = await jsonResponse.json().catch(() => ({ error: 'Transcription request failed' }));
        throw new Error(err.error || `Server error (${jsonResponse.status}) during transcription`);
      }

      return await jsonResponse.json();
    } catch (jsonErr: any) {
      // If it was an explicit 4xx/5xx error message from our server, rethrow it
      if (jsonErr?.message && !jsonErr.message.toLowerCase().includes('failed to fetch')) {
        throw jsonErr;
      }
      // Otherwise fall through to multipart FormData upload
    }
  }

  const inMemoryBlob = new Blob([arrayBuffer], { type: audioBlob.type || 'audio/webm' });
  const formData = new FormData();
  formData.append('audio', inMemoryBlob, fileName);
  formData.append('language', language);
  formData.append('chunk_index', chunkIndex.toString());
  formData.append('total_chunks', totalChunks.toString());

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Transcription request failed' }));
    throw new Error(err.error || `Server error (${response.status}) during transcription`);
  }

  return response.json();
}

export async function analyzeLecture(
  transcript: string,
  language: SupportedLanguage
): Promise<LectureAnalysis> {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, language }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Analysis failed' }));
    throw new Error(err.error || `Server error (${response.status}) during lecture analysis`);
  }

  return response.json();
}

// -------------------------------------------------------------
// Low-Latency Client TTS Cache, Sentence Chunker & Prefetcher
// -------------------------------------------------------------
const MAX_CLIENT_TTS_CACHE = 120;
const clientTtsBlobCache = new Map<string, Blob>();
const clientInFlightTts = new Map<string, Promise<Blob>>();

export function splitIntoSpeakableChunks(text: string): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= 75) return [clean];

  const rawSentences = clean
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawSentences.length <= 1) {
    return [clean];
  }

  const chunks: string[] = [];
  let current = '';

  for (let i = 0; i < rawSentences.length; i++) {
    const sentence = rawSentences[i];
    if (!current) {
      current = sentence;
      continue;
    }

    // Merge tiny leading prefixes like "Question 1." or "Lecture summary." (< 20 chars) with the next sentence,
    // but keep the first full sentence standalone so chunk 0 synthesizes in ~350-500ms.
    const isTinyLabel = current.length < 20;
    const canMergeSubsequent = chunks.length > 0 && current.length + 1 + sentence.length <= 150;

    if ((isTinyLabel && current.length + 1 + sentence.length <= 140) || canMergeSubsequent) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export async function synthesizeAudio(
  text: string,
  language: SupportedLanguage = 'en',
  voice: 'female' | 'male' = 'female',
  prefetch: boolean = false
): Promise<Blob> {
  const normalizedText = (text || '').replace(/\s+/g, ' ').trim();
  const cacheKey = `${language}:${voice}:${normalizedText}`;

  const cachedBlob = clientTtsBlobCache.get(cacheKey);
  if (cachedBlob && cachedBlob.size > 1000) {
    clientTtsBlobCache.delete(cacheKey);
    clientTtsBlobCache.set(cacheKey, cachedBlob);
    return cachedBlob;
  }

  const existingInFlight = clientInFlightTts.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async (): Promise<Blob> => {
    try {
      const response = await fetch('/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: normalizedText,
          language,
          voice,
          prefetch: Boolean(prefetch),
        }),
      });

      if (!response.ok) {
        throw new Error(`Text-to-speech error (${response.status})`);
      }

      const blob = await response.blob();
      if (blob && blob.size > 1000) {
        if (clientTtsBlobCache.size >= MAX_CLIENT_TTS_CACHE) {
          const oldestKey = clientTtsBlobCache.keys().next().value;
          if (oldestKey) clientTtsBlobCache.delete(oldestKey);
        }
        clientTtsBlobCache.set(cacheKey, blob);
      }
      return blob;
    } finally {
      clientInFlightTts.delete(cacheKey);
    }
  })();

  clientInFlightTts.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Proactively pre-synthesizes and caches the opening chunk of upcoming spoken items
 * sequentially at low priority so active user clicks always get immediate priority.
 */
export function prefetchSpokenVoice(
  texts: string[],
  language: SupportedLanguage = 'en'
): void {
  if (!Array.isArray(texts) || texts.length === 0) return;

  const firstChunks: string[] = [];
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    const chunks = splitIntoSpeakableChunks(t);
    if (chunks.length > 0 && chunks[0] && !firstChunks.includes(chunks[0])) {
      firstChunks.push(chunks[0]);
    }
    if (firstChunks.length >= 2) break;
  }

  void (async () => {
    for (const chunk of firstChunks) {
      try {
        await synthesizeAudio(chunk, language, 'female', true);
      } catch {
        // Ignore background prefetch errors
      }
    }
  })();
}

export async function evaluateQuizAnswer(
  question: string,
  model_answer: string,
  user_answer: string,
  language: SupportedLanguage = 'en'
): Promise<QuizEvaluation> {
  const response = await fetch('/api/quiz/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, model_answer, user_answer, language }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Quiz evaluation failed' }));
    throw new Error(err.error || `Server error (${response.status}) during answer evaluation`);
  }

  return response.json();
}

export async function askLectureQuestion(params: {
  transcript: string;
  clean_transcript: string;
  concepts: Array<{ term: string; explanation: string }>;
  question: string;
  language?: SupportedLanguage;
}): Promise<{
  english_question: string;
  covered_in_lecture: boolean;
  answer: string;
  transcript_quote?: string;
}> {
  const response = await fetch('/api/lecture/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Failed to answer question from lecture' }));
    throw new Error(err.error || `Server error (${response.status}) while checking lecture transcript`);
  }

  return response.json();
}

export async function fetchTestCases(): Promise<TestCase[]> {
  try {
    const response = await fetch('/api/test-cases');
    if (response.ok) {
      return await response.json();
    }
  } catch (err) {
    console.warn('Failed to load test cases from /api/test-cases:', err);
  }
  return [];
}

export async function checkSystemHealth(): Promise<{
  status: string;
  gnani_configured: boolean;
  gemini_configured: boolean;
}> {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // ignore
  }
  return { status: 'offline', gnani_configured: false, gemini_configured: false };
}

/**
 * Universal low-latency voice playback helper:
 * Splits multi-sentence text into speakable chunks, fetches the first sentence immediately
 * while prefetching remaining sentences in parallel, and plays them seamlessly back-to-back.
 * Falls back to window.speechSynthesis only if audio synthesis or playback is unavailable.
 */
export function playSpokenVoice(
  text: string,
  language: SupportedLanguage,
  audioBlob?: Blob | null,
  onEnd?: () => void
): { stop: () => void } {
  let isStopped = false;
  let audioElement: HTMLAudioElement | null = null;
  let activeObjectUrl: string | null = null;

  const cleanupCurrentAudio = () => {
    if (audioElement) {
      audioElement.onended = null;
      audioElement.onerror = null;
      audioElement.pause();
      audioElement.currentTime = 0;
      audioElement = null;
    }
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  };

  const playWithSpeechSynthesis = (fallbackText: string) => {
    if (isStopped) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      if (onEnd) onEnd();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(fallbackText);
    utterance.rate = 1.0;
    utterance.pitch = 1.05;

    const voices = window.speechSynthesis.getVoices();
    if (language.startsWith('hi')) {
      const hiVoice = voices.find((v) => v.lang.startsWith('hi') || v.name.includes('Hindi'));
      if (hiVoice) utterance.voice = hiVoice;
      utterance.lang = 'hi-IN';
    } else if (language.startsWith('ta')) {
      const taVoice = voices.find((v) => v.lang.startsWith('ta') || v.name.includes('Tamil'));
      if (taVoice) utterance.voice = taVoice;
      utterance.lang = 'ta-IN';
    } else {
      const enInVoice = voices.find((v) => v.lang.includes('en-IN') || v.name.includes('India'));
      if (enInVoice) utterance.voice = enInVoice;
      utterance.lang = 'en-IN';
    }

    utterance.onend = () => {
      if (!isStopped && onEnd) onEnd();
    };

    utterance.onerror = () => {
      if (!isStopped && onEnd) onEnd();
    };

    window.speechSynthesis.speak(utterance);
  };

  const playSingleBlob = (blob: Blob, onChunkFinished: () => void, onChunkFailed: () => void) => {
    if (isStopped) return;
    cleanupCurrentAudio();
    try {
      const url = URL.createObjectURL(blob);
      activeObjectUrl = url;
      const audio = new Audio(url);
      audioElement = audio;

      audio.onended = () => {
        cleanupCurrentAudio();
        if (!isStopped) onChunkFinished();
      };
      audio.onerror = () => {
        cleanupCurrentAudio();
        if (!isStopped) onChunkFailed();
      };
      audio.play().catch(() => {
        cleanupCurrentAudio();
        if (!isStopped) onChunkFailed();
      });
    } catch {
      cleanupCurrentAudio();
      if (!isStopped) onChunkFailed();
    }
  };

  if (audioBlob && audioBlob.size > 1000) {
    playSingleBlob(
      audioBlob,
      () => {
        if (!isStopped && onEnd) onEnd();
      },
      () => {
        playWithSpeechSynthesis(text);
      }
    );
  } else {
    const chunks = splitIntoSpeakableChunks(text);
    if (chunks.length === 0) {
      if (onEnd) onEnd();
    } else {
      // Pipeline synthesis one chunk at a time: fetch chunk 0 immediately at high priority,
      // and as soon as chunk i finishes downloading (while chunk i plays aloud), start fetching chunk i+1.
      const chunkPromises: Array<Promise<Blob> | null> = new Array(chunks.length).fill(null);
      const getChunkPromise = (idx: number): Promise<Blob> => {
        if (!chunkPromises[idx]) {
          chunkPromises[idx] = synthesizeAudio(chunks[idx], language, 'female', false);
        }
        return chunkPromises[idx]!;
      };

      const playChunkAtIndex = (index: number) => {
        if (isStopped) return;
        if (index >= chunks.length) {
          if (onEnd) onEnd();
          return;
        }

        getChunkPromise(index)
          .then((synthesizedBlob) => {
            if (isStopped) return;
            // Start synthesizing the next sentence while the current sentence is playing aloud
            if (index + 1 < chunks.length) {
              void getChunkPromise(index + 1).catch(() => {});
            }

            if (synthesizedBlob && synthesizedBlob.size > 1000) {
              playSingleBlob(
                synthesizedBlob,
                () => playChunkAtIndex(index + 1),
                () => playWithSpeechSynthesis(chunks.slice(index).join(' '))
              );
            } else {
              playWithSpeechSynthesis(chunks.slice(index).join(' '));
            }
          })
          .catch(() => {
            if (!isStopped) {
              playWithSpeechSynthesis(chunks.slice(index).join(' '));
            }
          });
      };

      playChunkAtIndex(0);
    }
  }

  return {
    stop: () => {
      isStopped = true;
      cleanupCurrentAudio();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
  };
}
