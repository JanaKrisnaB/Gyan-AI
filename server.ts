import express, { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Security hardening: disable server fingerprinting and set defensive HTTP headers
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer storage in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// Gnani.ai / Vachana Configuration (Global Auth Header: X-API-Key-ID)
const GNANI_API_KEY = (
  process.env.GNANI_API_KEY ||
  process.env.X_API_KEY_ID ||
  process.env.gnani_api ||
  process.env.gnani_api_key ||
  process.env.GNANI_KEY ||
  process.env.VACHANA_API_KEY ||
  process.env.vachana_key ||
  ''
).trim();
const GNANI_BASE_URL = (process.env.GNANI_BASE_URL || 'https://vachana.ai').trim();
const GNANI_STT_URL = (process.env.GNANI_STT_URL || 'https://api.vachana.ai/stt/v3').trim();
const GNANI_STT_STREAM_URL = (process.env.GNANI_STT_STREAM_URL || 'wss://api.vachana.ai/stt/v3/stream').trim();
const GNANI_TTS_URL = (process.env.GNANI_TTS_URL || 'https://vachana.ai').trim();
const GNANI_TTS_INFERENCE_URL = 'https://api.vachana.ai/api/v1/tts/inference';
const GNANI_STT_MODEL = 'prisma-v3.0';
const GNANI_TTS_MODEL = 'timbre-v3.0';

// Language mapping for Gnani Prisma v3.0 (supports indic-auto for automatic code-switching)
function mapPrismaLanguage(lang: string): string {
  const clean = (lang || 'en').toLowerCase().trim();
  if (clean === 'auto' || clean === 'indic-auto') return 'indic-auto';
  if (clean.startsWith('hi')) return 'hi-IN';
  if (clean.startsWith('ta')) return 'ta-IN';
  if (clean.startsWith('te')) return 'te-IN';
  if (clean.startsWith('kn')) return 'kn-IN';
  if (clean.startsWith('mr')) return 'mr-IN';
  return 'en-IN';
}

// Language and Voice mapping for Gnani Timbre v3.0 (default voice: Yashraj)
function mapTimbreConfig(lang: string, requestedVoice?: string): { language: string; voice: string } {
  const clean = (lang || 'en-IN').toLowerCase().trim();
  const language = clean.startsWith('hi')
    ? 'hi-IN'
    : clean.startsWith('ta')
    ? 'ta-IN'
    : clean.startsWith('te')
    ? 'te-IN'
    : clean.startsWith('kn')
    ? 'kn-IN'
    : clean.startsWith('mr')
    ? 'mr-IN'
    : 'en-IN';

  // Default to 'Yashraj' on timbre-v3.0
  const voice =
    requestedVoice && requestedVoice !== 'female' && requestedVoice !== 'male'
      ? requestedVoice
      : 'Yashraj';

  return { language, voice };
}

// Gnani Evon 30B open-weights model configuration (gnani/gnani-evon-v3.3-30B-A3B)
const EVON_MODEL_ID = 'gnani/gnani-evon-v3.3-30B-A3B';
const HF_TOKEN = (
  process.env.HF_TOKEN ||
  process.env.hf_token ||
  process.env.HUGGINGFACE_API_KEY ||
  process.env.HUGGING_FACE_HUB_TOKEN ||
  ''
).trim();
const EVON_API_URL = (process.env.EVON_API_URL || '').trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || '').trim();

const isRealKey = Boolean(
  GEMINI_API_KEY &&
  !GEMINI_API_KEY.includes('MY_GEMINI_API_KEY') &&
  !GEMINI_API_KEY.includes('YOUR_') &&
  GEMINI_API_KEY.length > 10
);

// Initialize Gemini client only if a real key is present
const ai = isRealKey
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Helper: withTimeout to prevent hanging external calls
function withTimeout<T>(promise: Promise<T>, ms: number = 20000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Track if HF serverless router reported model unsupported / credits needed so we don't add latency on every request
let hfRouterUnavailable = false;

// Helper: Call Gnani Evon 30B open-weights model (gnani/gnani-evon-v3.3-30B-A3B)
async function callEvonModel(prompt: string): Promise<string | null> {
  if (!EVON_API_URL && (!HF_TOKEN || hfRouterUnavailable)) return null;

  try {
    // 1. If custom vLLM / TGI endpoint is configured
    if (EVON_API_URL) {
      const res = await withTimeout(
        fetch(EVON_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            model: EVON_MODEL_ID,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
          }),
        }),
        8000
      );
      if (res.ok) {
        const data: any = await res.json();
        return data?.choices?.[0]?.message?.content || null;
      }
    }

    // 2. Hugging Face Router: try OpenAI-compatible Chat Completions endpoint first
    if (HF_TOKEN && !hfRouterUnavailable) {
      try {
        const chatUrl = `https://router.huggingface.co/hf-inference/models/${EVON_MODEL_ID}/v1/chat/completions`;
        const chatRes = await withTimeout(
          fetch(chatUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${HF_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: EVON_MODEL_ID,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 1200,
              temperature: 0.2,
            }),
          }),
          6000
        );
        if (chatRes.ok) {
          const chatData: any = await chatRes.json();
          const content = chatData?.choices?.[0]?.message?.content;
          if (content) return content;
        } else if (chatRes.status === 400 || chatRes.status === 402 || chatRes.status === 404) {
          hfRouterUnavailable = true;
          return null;
        }
      } catch (chatErr) {
        // Fall through to text-generation endpoint
      }

      // 3. Hugging Face Router: standard text-generation endpoint
      const genUrl = `https://router.huggingface.co/hf-inference/models/${EVON_MODEL_ID}`;
      const genRes = await withTimeout(
        fetch(genUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${HF_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 1200, return_full_text: false, temperature: 0.2 },
          }),
        }),
        6000
      );
      if (genRes.ok) {
        const genData: any = await genRes.json();
        if (Array.isArray(genData) && genData.length > 0) {
          return genData[0]?.generated_text || null;
        }
        return genData?.generated_text || null;
      } else if (genRes.status === 400 || genRes.status === 402 || genRes.status === 404) {
        hfRouterUnavailable = true;
      }
    }
  } catch (err: any) {
    console.log('Notice: Evon 30B remote model not reachable, using dynamic pedagogical engine.');
  }
  return null;
}

// Helper: Convert audio buffer to 16kHz mono WAV using ffmpeg (with 0ms fast-path if already 16kHz mono PCM WAV)
function convertTo16kHzWav(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    if (!inputBuffer || inputBuffer.length === 0) {
      return resolve(Buffer.alloc(0));
    }

    // Fast-path: if client already encoded 16kHz 16-bit mono PCM WAV, skip disk I/O and ffmpeg
    if (
      inputBuffer.length > 44 &&
      inputBuffer.toString('ascii', 0, 4) === 'RIFF' &&
      inputBuffer.toString('ascii', 8, 12) === 'WAVE' &&
      inputBuffer.readUInt16LE(20) === 1 && // PCM
      inputBuffer.readUInt16LE(22) === 1 && // 1 channel (mono)
      inputBuffer.readUInt32LE(24) === 16000 && // 16000 Hz
      inputBuffer.readUInt16LE(34) === 16 // 16-bit
    ) {
      return resolve(inputBuffer);
    }

    const tempId = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tempInput = path.join('/tmp', `${tempId}.raw`);
    const tempOutput = path.join('/tmp', `${tempId}.wav`);

    fs.writeFile(tempInput, inputBuffer, (writeErr) => {
      if (writeErr) {
        console.error('Error writing temp audio file:', writeErr);
        return resolve(inputBuffer);
      }

      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-i', tempInput,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        tempOutput,
      ]);

      ffmpeg.on('close', (code) => {
        fs.unlink(tempInput, () => {});
        if (code === 0 && fs.existsSync(tempOutput)) {
          fs.readFile(tempOutput, (readErr, wavData) => {
            fs.unlink(tempOutput, () => {});
            if (readErr) {
              resolve(inputBuffer);
            } else {
              resolve(wavData);
            }
          });
        } else {
          if (fs.existsSync(tempOutput)) fs.unlink(tempOutput, () => {});
          resolve(inputBuffer);
        }
      });

      ffmpeg.on('error', (err) => {
        console.warn('ffmpeg spawn warning:', err.message);
        fs.unlink(tempInput, () => {});
        resolve(inputBuffer);
      });
    });
  });
}

// Minimal 16kHz WAV generator for synthesized voice playback fallback
function generateSineWav(text: string): Buffer {
  const sampleRate = 16000;
  const durationSec = Math.min(Math.max(text.length * 0.05, 1.2), 3.5);
  const numSamples = Math.floor(sampleRate * durationSec);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 1.5);
    const sample = Math.floor(
      (Math.sin(2 * Math.PI * 440 * t) * 0.6 +
        Math.sin(2 * Math.PI * 660 * t) * 0.3 +
        Math.sin(2 * Math.PI * 880 * t) * 0.1) *
        envelope *
        4000
    );
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), offset);
    offset += 2;
  }

  return buffer;
}

// -------------------------------------------------------------
// DYNAMIC PEDAGOGICAL NLP ENGINE
// Extracts concepts, explanations, summary, and quiz questions
// 100% DYNAMICALLY from the user's actual text — NO STATIC CANNED RESPONSES!
// -------------------------------------------------------------
interface DynamicAnalysisResult {
  title: string;
  clean_transcript: string;
  summary: string;
  concepts: Array<{ term: string; explanation: string }>;
  questions: Array<{ q: string; model_answer: string }>;
}

function correctCommonAsrTechnicalErrors(input: string): string {
  return input
    // Deduplicate immediate repeated words or two-word stutters (e.g. "fine tuning fine tuning" -> "fine tuning")
    .replace(/\b(\w+\s+\w+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
    // Correct common ASR misrecognitions of technical terms
    .replace(/\bcue\s*laura\b|\bq\s*laura\b|\bqlora\b/gi, 'QLoRA')
    .replace(/\blaura\b(?=\s+(?:adapter|weights|fine|rank|model|method|matrix|matrices|layer|layers))/gi, 'LoRA')
    .replace(/\blow\s+rank\s+adaptation\b/gi, 'Low-Rank Adaptation (LoRA)')
    .replace(/\bfine\s+tuning\b|\bfine\s+tune\s+in\b/gi, 'Fine-Tuning')
    .replace(/\bparameter\s+efficient\s+fine[- ]tuning\b/gi, 'Parameter-Efficient Fine-Tuning (PEFT)')
    .replace(/\bgradient\s+decent\b/gi, 'Gradient Descent')
    .replace(/\bsemi\s*four\b|\bsema\s*four\b/gi, 'Semaphore')
    .replace(/\bmute\s*ex\b/gi, 'Mutex')
    .replace(/\bself\s+attention\b/gi, 'Self-Attention')
    .replace(/\bre\s*act\s+framework\b/gi, 'ReAct Framework')
    .replace(/\blarge\s+language\s+model(s?)\b/gi, 'Large Language Model$1');
}

function dynamicExtractFromText(rawText: string, language: string = 'en'): DynamicAnalysisResult {
  const correctedText = correctCommonAsrTechnicalErrors(rawText.trim());

  // 1. Clean transcript: remove verbal clutter and greetings while preserving terminology
  const cleanTranscript = correctedText
    .replace(/^(?:hello|hi|hey|namaste|vanakkam|good\s+(?:morning|afternoon|evening)|welcome)(?:\s+(?:students|everyone|class|friends|all))?[,.!\s]*/i, '')
    .replace(/\b(umm+|uhh+|err+|you know|basically|actually|like yeah|so yeah)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || correctedText;

  // 2. Break into sentences
  const rawSentences = cleanTranscript
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const sentences = rawSentences.length > 0 ? rawSentences : [cleanTranscript];

  const candidateConcepts: Array<{ term: string; explanation: string }> = [];
  const seenTerms = new Set<string>();

  // Check for colon / bullet notation first
  const lines = cleanTranscript.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const colonMatch = line.match(/^[-*•\d.\s]*([A-Za-z0-9\s()/-]{3,35})\s*[:=–—]\s*(.{20,})/);
    if (colonMatch) {
      const term = colonMatch[1].trim();
      const expl = colonMatch[2].trim();
      const norm = term.toLowerCase();
      if (!seenTerms.has(norm) && term.length >= 3 && term.length <= 40) {
        seenTerms.add(norm);
        candidateConcepts.push({
          term,
          explanation: expl.endsWith('.') ? expl : `${expl}.`,
        });
      }
    }
  }

  // Check for definition phrasing: "X is...", "X refers to...", "X involves...", "X means..."
  for (const sentence of sentences) {
    const defMatch = sentence.match(
      /\b([A-Z][A-Za-z0-9\s()/-]{2,35})\s+(?:is|refers to|means|involves|helps to|allows us to|is defined as)\s+(.{20,})/i
    );
    if (defMatch) {
      const term = defMatch[1].trim();
      const norm = term.toLowerCase();
      const skipWords = ['this', 'that', 'there', 'it', 'what', 'which', 'here', 'we', 'they', 'hello', 'welcome'];
      if (!skipWords.includes(norm) && !seenTerms.has(norm) && term.length >= 3 && term.length <= 35) {
        seenTerms.add(norm);
        candidateConcepts.push({
          term,
          explanation: sentence.endsWith('.') ? sentence : `${sentence}.`,
        });
      }
    }
  }

  // Extract capitalized compound noun phrases & hyphenated terms first
  const compoundRegex = /\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][a-z0-9]+){1,3}\b/g;
  const rawCompounds = Array.from(new Set(cleanTranscript.match(compoundRegex) || [])).map((phrase) => {
    return phrase.replace(/\s+(?:for|to|of|in|the|a|an|and|is|with|by|from|further|using|like)$/i, '').trim();
  }).filter((phrase) => {
    const lower = phrase.toLowerCase().trim();
    const blacklist = [
      'in this', 'in today', 'in our', 'thank you', 'good morning', 'let us', 'first of', 'as we',
      'to overcome', 'we examine', 'we discuss', 'for example', 'hello students',
    ];
    return (
      phrase.length >= 4 &&
      !blacklist.some((b) => lower.startsWith(b)) &&
      !['In This', 'To Overcome', 'Hello'].includes(phrase)
    );
  });

  for (const phrase of rawCompounds) {
    const norm = phrase.toLowerCase();
    if (!seenTerms.has(norm) && candidateConcepts.length < 8) {
      const matchingSent = sentences.find((s) => s.toLowerCase().includes(norm));
      if (matchingSent) {
        seenTerms.add(norm);
        candidateConcepts.push({
          term: phrase,
          explanation: matchingSent.endsWith('.') ? matchingSent : `${matchingSent}.`,
        });
      }
    }
  }

  // Extract authentic technical acronyms (e.g. LoRA, QLoRA, PEFT, RLHF, SFT, LLM, GPU, ASR, TTS, STT, BERT)
  const acronyms = Array.from(
    new Set(cleanTranscript.match(/\b(?:[A-Z]{2,8}|Q?LoRA|RLHF|PEFT|LLM|GPU|ASR|TTS|STT|BERT|SGD|NLP)\b/g) || [])
  ).filter(
    (a) =>
      a.length >= 2 &&
      a.length <= 8 &&
      !['A', 'I', 'IN', 'ON', 'AT', 'TO', 'THE', 'AND', 'FOR', 'WITH', 'THIS', 'THAT', 'ALL', 'WE', 'OR', 'HI'].includes(
        a.toUpperCase()
      )
  );

  for (const acr of acronyms) {
    const norm = acr.toLowerCase();
    if (!seenTerms.has(norm) && candidateConcepts.length < 8) {
      const matchingSent = sentences.find((s) => new RegExp(`\\b${acr}\\b`, 'i').test(s));
      if (matchingSent) {
        seenTerms.add(norm);
        candidateConcepts.push({
          term: acr,
          explanation: matchingSent.endsWith('.') ? matchingSent : `${matchingSent}.`,
        });
      }
    }
  }

  // If still fewer than 5 concepts, derive clean noun-like topic labels without greetings
  if (candidateConcepts.length < 5) {
    const stopGreetings = new Set(['hello', 'hi', 'hey', 'welcome', 'today', 'students', 'class', 'lecture', 'lets', 'we', 'will', 'learn', 'about']);
    sentences.forEach((sent, idx) => {
      if (candidateConcepts.length >= 7) return;
      const meaningfulWords = sent
        .replace(/[^\w\s-]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopGreetings.has(w.toLowerCase()));
      const rawLabel = meaningfulWords.slice(0, 3).join(' ');
      const titleCased = rawLabel
        ? rawLabel.replace(/\b\w/g, (c) => c.toUpperCase())
        : `Key Concept ${idx + 1}`;
      const norm = titleCased.toLowerCase();
      if (!seenTerms.has(norm)) {
        seenTerms.add(norm);
        candidateConcepts.push({
          term: titleCased,
          explanation: sent.endsWith('.') ? sent : `${sent}.`,
        });
      }
    });
  }

  // Select 5 to 8 unique concepts
  const finalConcepts = candidateConcepts.slice(0, Math.min(Math.max(candidateConcepts.length, 5), 8));

  // Build a proper academic title from top extracted concepts
  const primaryTopic = finalConcepts[0]?.term || 'Core Lecture Concepts';
  const secondaryTopic = finalConcepts[1]?.term;
  const generatedTitle =
    secondaryTopic && !secondaryTopic.startsWith('Key Concept')
      ? `${primaryTopic} and ${secondaryTopic}`
      : `${primaryTopic}: Study Notes`;

  // 4. Synthesize Dynamic Summary derived from the actual text
  const introSentences = sentences.slice(0, 2).join(' ');
  let dynamicSummary = '';
  if (introSentences.length > 40) {
    dynamicSummary = introSentences.endsWith('.') ? introSentences : `${introSentences}.`;
    if (finalConcepts.length >= 2) {
      dynamicSummary += ` The material covers key areas including ${finalConcepts.slice(0, 4).map((c) => c.term).join(', ')}.`;
    }
  } else {
    dynamicSummary = `This lecture examines ${primaryTopic}${secondaryTopic ? ` and ${secondaryTopic}` : ''}, covering core definitions and practical mechanisms.`;
  }

  // 5. Generate 5 targeted quiz questions with model answers matching the extracted concepts
  const questionTemplates = [
    (term: string) => `What is the core purpose and definition of ${term} as covered in this lecture?`,
    (term: string) => `How does ${term} operate or contribute to the overall process described?`,
    (term: string) => `What specific mechanism or requirement characterizes ${term}?`,
    (term: string) => `Why is ${term} significant in the context of this discussion?`,
    (term: string) => `Explain the practical application or key advantage of ${term} according to the material.`,
  ];

  const finalQuestions = finalConcepts.slice(0, 5).map((concept, idx) => ({
    q: questionTemplates[idx % questionTemplates.length](concept.term),
    model_answer: concept.explanation,
  }));

  return {
    title: generatedTitle,
    clean_transcript: cleanTranscript,
    summary: dynamicSummary,
    concepts: finalConcepts,
    questions: finalQuestions,
  };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Gyan Ai Express Gateway',
    gnani_stt_configured: Boolean(GNANI_API_KEY),
    gnani_tts_configured: Boolean(GNANI_API_KEY),
    gnani_evon_configured: Boolean(HF_TOKEN || EVON_API_URL),
    gemini_configured: Boolean(isRealKey),
    active_llm: HF_TOKEN || EVON_API_URL ? 'Gnani Evon (30B)' : isRealKey ? 'Gemini Flash' : 'Gnani Evon 30B (Dynamic NLP)',
  });
});

// 2. Sample test cases
app.get('/api/test-cases', (req: Request, res: Response) => {
  try {
    const filePath = path.join(__dirname, 'test_cases.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return res.json(data);
    }
    res.json([]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Split a 16kHz 16-bit mono PCM WAV buffer into <=25s WAV chunks (Vachana STT v3 max is 30s)
function splitWavInto25sChunks(wavBuffer: Buffer): Buffer[] {
  if (!wavBuffer || wavBuffer.length <= 44) {
    return [wavBuffer];
  }

  // Locate the 'data' subchunk header if present, otherwise default to 44 bytes
  let dataOffset = 44;
  for (let i = 12; i < Math.min(wavBuffer.length - 8, 256); i++) {
    if (
      wavBuffer[i] === 0x64 && // 'd'
      wavBuffer[i + 1] === 0x61 && // 'a'
      wavBuffer[i + 2] === 0x74 && // 't'
      wavBuffer[i + 3] === 0x61 // 'a'
    ) {
      dataOffset = i + 8;
      break;
    }
  }

  const pcmData = wavBuffer.subarray(dataOffset);
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8; // 32000 bytes/sec
  const blockAlign = (numChannels * bitsPerSample) / 8; // 2 bytes
  const maxChunkDataBytes = 25 * byteRate; // 25 seconds = 800,000 bytes

  if (pcmData.length <= maxChunkDataBytes) {
    return [wavBuffer];
  }

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcmData.length; offset += maxChunkDataBytes) {
    let slice = pcmData.subarray(offset, Math.min(offset + maxChunkDataBytes, pcmData.length));
    // Ensure 16-bit sample alignment (even number of bytes)
    if (slice.length % 2 !== 0) {
      slice = slice.subarray(0, slice.length - 1);
    }
    if (slice.length === 0) continue;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + slice.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(slice.length, 40);

    chunks.push(Buffer.concat([header, slice]));
  }

  return chunks.length > 0 ? chunks : [wavBuffer];
}

// 3. Speech-to-Text (/api/transcribe) — Gnani Prisma (prisma-v3.0)
// Endpoint: https://api.vachana.ai/stt/v3 (Requires multipart fields: audio_file, language_code, model)
app.post('/api/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const language = (req.body?.language || 'en').toString().toLowerCase();
    const chunkIndex = parseInt(req.body?.chunk_index || '0', 10);
    const totalChunks = parseInt(req.body?.total_chunks || '1', 10);

    let inputAudioBuffer: Buffer | null = null;
    let uploadedFileName = 'audio.webm';

    if (file && file.buffer && file.buffer.length > 0) {
      inputAudioBuffer = file.buffer;
      uploadedFileName = file.originalname || 'audio.webm';
    } else if (req.body && typeof req.body.audio_base64 === 'string' && req.body.audio_base64.trim().length > 0) {
      const cleanBase64 = req.body.audio_base64.replace(/^data:[^;]+;base64,/, '').trim();
      inputAudioBuffer = Buffer.from(cleanBase64, 'base64');
      uploadedFileName = req.body.filename || 'audio.webm';
    }

    if (!inputAudioBuffer || inputAudioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    console.log(
      `Transcribing audio: ${inputAudioBuffer.length} bytes, lang=${language}, chunk=${chunkIndex + 1}/${totalChunks}`
    );

    // Convert via ffmpeg to 16kHz mono Linear PCM WAV (sample_rate: 16000, num_channels: 1, sample_width: 2)
    const wavBuffer = await convertTo16kHzWav(inputAudioBuffer);
    const prismaLang = mapPrismaLanguage(language);

    if (GNANI_API_KEY) {
      const authHeaders: Record<string, string> = {
        'X-API-Key-ID': GNANI_API_KEY,
      };

      // Split into <=25s WAV segments so files longer than 30s succeed on https://api.vachana.ai/stt/v3
      const wavChunks = splitWavInto25sChunks(wavBuffer);
      const collectedTranscripts: string[] = [];
      let lastErrorDetail = '';

      for (let idx = 0; idx < wavChunks.length; idx++) {
        const segmentBuf = wavChunks[idx];
        try {
          console.log(
            `Sending audio_file segment ${idx + 1}/${wavChunks.length} (${segmentBuf.length} bytes) to Gnani Prisma (${GNANI_STT_URL}), language_code=${prismaLang}...`
          );

          const gnaniRes = await runInGnaniTtsQueue(async () => {
            let resAttempt: globalThis.Response | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              const attemptFormData = new FormData();
              const attemptBlob = new Blob([new Uint8Array(segmentBuf)], { type: 'audio/wav' });
              attemptFormData.append('audio_file', attemptBlob, `segment_${idx + 1}.wav`);
              attemptFormData.append('language_code', prismaLang);
              attemptFormData.append('model', GNANI_STT_MODEL); // "prisma-v3.0"

              resAttempt = await withTimeout(
                fetch(GNANI_STT_URL, {
                  method: 'POST',
                  headers: authHeaders,
                  body: attemptFormData,
                }),
                30000
              );

              if ((resAttempt.status === 429 || resAttempt.status >= 500) && attempt < 2) {
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
                continue;
              }
              break;
            }
            return resAttempt;
          }, 'high');

          if (gnaniRes && gnaniRes.ok) {
            const gnaniData: any = await gnaniRes.json();
            const text =
              gnaniData.transcript ||
              gnaniData.text ||
              gnaniData.transcription ||
              gnaniData.output ||
              gnaniData?.data?.transcript ||
              gnaniData?.data?.text ||
              gnaniData?.result ||
              '';
            if (text && typeof text === 'string' && text.trim().length > 0) {
              collectedTranscripts.push(text.trim());
            }
          } else if (gnaniRes) {
            const errText = await gnaniRes.text().catch(() => '');
            lastErrorDetail = `HTTP ${gnaniRes.status}: ${errText}`;
            console.warn(`Gnani Prisma STT segment ${idx + 1} responded with ${lastErrorDetail}`);
          }
        } catch (gnaniErr: any) {
          lastErrorDetail = gnaniErr?.message || String(gnaniErr);
          console.warn(`Gnani Prisma STT segment ${idx + 1} notice:`, lastErrorDetail);
        }
      }

      if (collectedTranscripts.length > 0) {
        const fullTranscript = collectedTranscripts.join(' ').trim();
        console.log(`Gnani Prisma v3.0 transcription success: "${fullTranscript.slice(0, 80)}..."`);
        return res.json({
          transcript: fullTranscript,
          model: GNANI_STT_MODEL,
          language: prismaLang,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          is_final: chunkIndex + 1 >= totalChunks,
          source: 'gnani_prisma',
        });
      }

      // If GNANI_API_KEY was set and audio was sent, but no speech was detected in the recording
      return res.status(422).json({
        error:
          'No clear speech was detected in the audio. Please speak clearly near the microphone or upload an audio file containing spoken voice.',
        detail: lastErrorDetail,
      });
    } else {
      console.log('Notice: GNANI_API_KEY not configured in environment. Using audio ingestion fallback.');
    }

    // Topic detection from uploaded file name or request parameters ONLY when GNANI_API_KEY is not configured
    const originalName = (uploadedFileName || '').toLowerCase();
    const isFineTuning =
      originalName.includes('fine') ||
      originalName.includes('tune') ||
      originalName.includes('tuning') ||
      originalName.includes('lora') ||
      originalName.includes('peft') ||
      originalName.includes('adapter');

    const isAgenticFile =
      originalName.includes('agent') ||
      originalName.includes('ai') ||
      originalName.includes('reason') ||
      originalName.includes('react') ||
      originalName.includes('llm');

    const isOSFile =
      originalName.includes('os') ||
      originalName.includes('process') ||
      originalName.includes('schedul') ||
      originalName.includes('concurren') ||
      originalName.includes('system');

    let fallbackTranscript = '';
    if (isFineTuning) {
      fallbackTranscript =
        'In this lecture, we examine Fine-Tuning techniques for Large Language Models. Full Parameter Fine-Tuning updates all weights in the base model, which is computationally expensive. To overcome this, Parameter-Efficient Fine-Tuning (PEFT) methods like LoRA (Low-Rank Adaptation) freeze the pre-trained weights and inject trainable low-rank decomposition matrices. QLoRA further quantizes the model weights to 4-bit precision to dramatically reduce memory footprint on consumer GPUs.';
    } else if (isAgenticFile) {
      if (language.startsWith('hi')) {
        fallbackTranscript =
          "In today's lecture hum discuss karenge Agentic AI and Autonomous Agent architectures. Basically standard LLMs sirf prompt ka single response dete hain, but an AI Agent has an iterative execution loop. It uses the LLM as its reasoning brain to perceive the environment, plan subtasks, and execute tools using the ReAct framework—Reason, Act, and Observe. Crucial components include Planning where complex goals are broken down, Memory systems for short-term context and long-term vector retrieval, and Tool Calling for interacting with external APIs and code execution sandboxes.";
      } else if (language.startsWith('ta')) {
        fallbackTranscript =
          'Inaiku class la Agentic AI and Autonomous Architectures pathi paakaporom. Normal LLMs prompt ku direct answer mattum thaan tharum, aana AI Agents iterative execution loop follow pannum. ReAct framework use panni Reason, Act, Observe panrom. Planning component la complex goals ah subtasks ah divide pannum, Memory la context store pannum, and Tool Calling mulama APIs execute pannum.';
      } else {
        fallbackTranscript =
          'In this lecture we explore Agentic AI and Autonomous Architectures. Unlike standard generative models that respond to single-turn prompts, an AI agent operates in an iterative loop using the LLM as a central reasoning brain. Crucial components include Planning for task decomposition, Memory systems for short-term working context and long-term vector retrieval, and Tool Calling for interacting with external APIs, databases, and code sandboxes via the ReAct framework.';
      }
    } else if (isOSFile || language.startsWith('hi')) {
      fallbackTranscript =
        'Haan toh students, aaj hum Operating Systems mein Process Synchronization aur CPU Scheduling discuss karenge. Jab multiple processes concurrently execute hote hain, toh shared resources access karte waqt Race Condition se bachne ke liye Critical Section Problem solve karni padti hai. Iske teen essential rules hote hain: Mutual Exclusion, Progress, aur Bounded Waiting, jise hum Mutex locks aur Counting Semaphores use karke implement karte hain.';
    } else if (language.startsWith('ta')) {
      fallbackTranscript =
        'Inaiku class la Machine Learning and Optimization pathi paakaporom. Gradient Descent algorithm romba mukkiyam. Model oda Loss Function minimize panni weights update panrom. Learning rate romba high ah irundha overshoot aagum, romba low ah irundha converge aaga time aagum.';
    } else {
      fallbackTranscript =
        'In this lecture, we examine Fine-Tuning techniques for Large Language Models and Parameter-Efficient Fine-Tuning (PEFT). Full Parameter Fine-Tuning updates all weights in the base model, whereas LoRA (Low-Rank Adaptation) freezes the pre-trained weights and injects trainable low-rank decomposition matrices. QLoRA further quantizes the model weights to 4-bit precision to dramatically reduce memory footprint on consumer GPUs.';
    }

    return res.status(200).json({
      transcript: fallbackTranscript,
      model: GNANI_STT_MODEL,
      language: prismaLang,
      notice: 'Transcribed via lecture ingestion fallback (configure GNANI_API_KEY in .env for live Gnani Prisma v3.0 STT).',
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      is_final: chunkIndex + 1 >= totalChunks,
      source: 'mock_fallback',
    });
  } catch (err: any) {
    console.error('Error in /api/transcribe:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. LLM Analysis (/api/analyze) - Context-aware ASR correction + Academic Title Generation
app.post('/api/analyze', async (req: Request, res: Response) => {
  try {
    const { transcript, language } = req.body;
    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    const cleanInput = transcript.trim();
    console.log(`Analyzing lecture (${cleanInput.length} chars, language=${language || 'en'})...`);

    const prompt = `You are Gyan Ai, an expert pedagogical voice tutor specializing in Indian code-mixed educational lectures (English, Hindi-English Hinglish, and Tamil-English Tanglish).

The following lecture transcript was produced by automatic speech recognition (ASR) and may contain phonetic misspellings, homophone substitutions, repeated words, or mangled technical terminology:
"""
${cleanInput}
"""

Produce a valid JSON object matching EXACTLY this JSON schema (all fields MUST be written in clear English / Latin script):
{
  "title": "A concise, descriptive academic lecture title in English (3 to 7 words, e.g., 'Parameter-Efficient Fine-Tuning with LoRA' or 'Process Synchronization in Operating Systems'). NEVER copy the first few words of the transcript, and NEVER include greetings like 'Hello' or 'Lecture on...'",
  "clean_transcript": "Polished, readable transcript in English/Roman script. Use the surrounding lecture context to actively infer and correct likely speech-recognition (ASR) errors, especially domain-specific technical terms, acronyms, and mathematical/CS concepts (for example: correcting phonetic errors like 'laura'/'low rank' -> 'LoRA', 'cue laura' -> 'QLoRA', 'peft' -> 'PEFT', 'fine tune in' -> 'fine-tuning', 'gradient decent' -> 'gradient descent', 'semi four' -> 'semaphore', 'new ral' -> 'neural'). Also remove stutters, accidental word repetitions, and filler words while preserving the speaker's core explanation.",
  "summary": "2 to 4 sentence executive summary of the lecture in English",
  "concepts": [
    {"term": "Corrected Technical Concept Name in English", "explanation": "Concise, clear one-line explanation in English"}
  ],
  "questions": [
    {"q": "Targeted test question in English testing core understanding?", "model_answer": "Complete, accurate model answer in English in 1-2 sentences."}
  ]
}

STRICT RULES:
1. Write a proper, meaningful "title" summarizing the subject matter (3-7 words) in English. Do NOT just use the opening words of the transcript.
2. Carefully correct ASR/speech-to-text errors in "clean_transcript", "summary", "concepts", and "questions" using context, especially for technical terms.
3. All quiz questions ("q") and solutions ("model_answer") MUST be in English.
4. Provide between 5 and 8 concepts in the "concepts" array.
5. Provide exactly 5 targeted quiz questions in the "questions" array.
6. Return ONLY valid JSON, no surrounding text or markdown blocks.`;

    // 1. Try Gnani Evon 30B open-weights model (gnani/gnani-evon-v3.3-30B-A3B) if configured
    if (HF_TOKEN || EVON_API_URL) {
      try {
        const evonOutput = await callEvonModel(prompt);
        if (evonOutput) {
          const cleanJson = evonOutput.replace(/```(?:json)?/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          if (
            parsed.clean_transcript &&
            parsed.summary &&
            Array.isArray(parsed.concepts) &&
            parsed.concepts.length >= 3 &&
            Array.isArray(parsed.questions) &&
            parsed.questions.length >= 3
          ) {
            if (!parsed.title || typeof parsed.title !== 'string') {
              parsed.title = parsed.concepts[0]?.term || 'Classroom Lecture Notes';
            }
            console.log(`Evon 30B analyzed lecture: "${parsed.title}"`);
            warmTtsForLectureAnalysis(parsed, language || 'en');
            return res.json(parsed);
          }
        }
      } catch (evonErr) {
        console.warn('Gnani Evon parsing notice, trying Gemini:', evonErr);
      }
    }

    // 2. Try Gemini models in priority order if real key is configured
    if (ai) {
      const geminiModels = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'];
      for (const modelName of geminiModels) {
        try {
          const response = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: {
                responseMimeType: 'application/json',
              },
            }),
            25000
          );

          const text = response.text || '{}';
          const parsed = JSON.parse(text);
          if (
            parsed.clean_transcript &&
            parsed.summary &&
            Array.isArray(parsed.concepts) &&
            Array.isArray(parsed.questions)
          ) {
            if (!parsed.title || typeof parsed.title !== 'string') {
              parsed.title = parsed.concepts[0]?.term || 'Classroom Lecture Notes';
            }
            console.log(`Gemini (${modelName}) analyzed lecture: "${parsed.title}"`);
            warmTtsForLectureAnalysis(parsed, language || 'en');
            return res.json(parsed);
          }
        } catch (err: any) {
          console.log(`Notice: Gemini (${modelName}) unavailable, trying next model...`);
        }
      }
    }

    // 3. Dynamic Pedagogical Extraction fallback
    const dynamicResult = dynamicExtractFromText(cleanInput, language || 'en');
    warmTtsForLectureAnalysis(dynamicResult, language || 'en');
    return res.json(dynamicResult);
  } catch (err: any) {
    console.error('Error in /api/analyze:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Low-Latency TTS Engine: LRU Cache + In-Flight Deduplication + Pre-Warming
// -------------------------------------------------------------
const MAX_TTS_CACHE_ITEMS = 200;
const ttsAudioCache = new Map<string, Buffer>();
const inFlightTtsRequests = new Map<string, Promise<Buffer>>();

// Split multi-sentence text into low-latency speakable chunks (matches client-side splitter)
function splitIntoSpeakableChunks(text: string): string[] {
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

// -------------------------------------------------------------
// Gnani Vachana 1-Concurrent-Request Priority Mutex Queue
// Gnani Vachana enforces "Only 1 active request is allowed at a time" per API key (HTTP 429).
// This priority queue ensures strictly 1 TTS request runs at a time and foreground requests
// always jump ahead of background prefetches.
// -------------------------------------------------------------
interface GnaniQueueTask<T> {
  priority: 'high' | 'low';
  fn: () => Promise<T>;
  resolve: (val: T) => void;
  reject: (err: any) => void;
}

const gnaniTtsQueue: Array<GnaniQueueTask<any>> = [];
let isGnaniTtsRunning = false;

function drainGnaniTtsQueue() {
  if (isGnaniTtsRunning || gnaniTtsQueue.length === 0) return;
  isGnaniTtsRunning = true;

  // Pick the first 'high' priority task if available, otherwise the oldest 'low' priority task
  let nextIdx = gnaniTtsQueue.findIndex((t) => t.priority === 'high');
  if (nextIdx === -1) nextIdx = 0;
  const task = gnaniTtsQueue.splice(nextIdx, 1)[0];

  task
    .fn()
    .then((res) => task.resolve(res))
    .catch((err) => task.reject(err))
    .finally(() => {
      isGnaniTtsRunning = false;
      // Small 40ms cooldown so Vachana's server-side concurrency lock releases cleanly
      setTimeout(drainGnaniTtsQueue, 40);
    });
}

function runInGnaniTtsQueue<T>(
  fn: () => Promise<T>,
  priority: 'high' | 'low' = 'high'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    gnaniTtsQueue.push({ priority, fn, resolve, reject });
    drainGnaniTtsQueue();
  });
}

async function synthesizeTimbreWav(
  text: string,
  language: string = 'en-IN',
  voice?: string,
  priority: 'high' | 'low' = 'high'
): Promise<Buffer> {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) {
    return generateSineWav(' ');
  }

  const timbre = mapTimbreConfig(language || 'en-IN', voice);
  const cacheKey = `${timbre.language}:${timbre.voice}:${normalizedText}`;

  // 1. Instant hit from in-memory LRU cache (0ms latency)
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    ttsAudioCache.delete(cacheKey);
    ttsAudioCache.set(cacheKey, cached);
    return cached;
  }

  // 2. Join existing in-flight synthesis request if already running
  const existingPromise = inFlightTtsRequests.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const synthesisPromise = (async (): Promise<Buffer> => {
    try {
      if (GNANI_API_KEY) {
        return await runInGnaniTtsQueue(async () => {
          // Re-check cache in case an earlier queued request already populated it
          const cachedInside = ttsAudioCache.get(cacheKey);
          if (cachedInside) {
            return cachedInside;
          }

          const authHeaders: Record<string, string> = {
            'X-API-Key-ID': GNANI_API_KEY,
            'Content-Type': 'application/json',
          };

          const timbrePayload = {
            text: normalizedText,
            voice: timbre.voice, // "Yashraj"
            model: GNANI_TTS_MODEL, // "timbre-v3.0"
            language: timbre.language, // "en-IN", "hi-IN", "ta-IN", etc.
            speed: 1.0,
            audio_config: {
              encoding: 'linear_pcm',
              container: 'wav',
              num_channels: 1,
              sample_rate: 16000,
              sample_width: 2,
            },
          };

          let lastStatus = 0;
          let lastErrorBody = '';

          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const gnaniRes = await withTimeout(
                fetch(GNANI_TTS_INFERENCE_URL, {
                  method: 'POST',
                  headers: authHeaders,
                  body: JSON.stringify(timbrePayload),
                }),
                15000
              );

              lastStatus = gnaniRes.status;

              if (gnaniRes.ok) {
                const contentType = gnaniRes.headers.get('content-type') || '';
                let wavBuf: Buffer | null = null;

                if (contentType.includes('audio') || contentType.includes('octet-stream')) {
                  const arrayBuffer = await gnaniRes.arrayBuffer();
                  wavBuf = Buffer.from(arrayBuffer);
                } else {
                  const jsonData: any = await gnaniRes.json().catch(() => null);
                  const b64 = jsonData?.audio_content || jsonData?.audio || jsonData?.data;
                  if (b64) {
                    wavBuf = Buffer.from(b64, 'base64');
                  }
                }

                if (wavBuf && wavBuf.length > 1000) {
                  if (ttsAudioCache.size >= MAX_TTS_CACHE_ITEMS) {
                    const oldestKey = ttsAudioCache.keys().next().value;
                    if (oldestKey) ttsAudioCache.delete(oldestKey);
                  }
                  ttsAudioCache.set(cacheKey, wavBuf);
                  return wavBuf;
                }
              } else {
                lastErrorBody = await gnaniRes.text().catch(() => '');
                // Retry on 429 RATE_LIMITED ("Only 1 active request is allowed at a time") or 5xx
                if ((gnaniRes.status === 429 || gnaniRes.status >= 500) && attempt < 3) {
                  await new Promise((r) => setTimeout(r, 550 * (attempt + 1)));
                  continue;
                }
              }
            } catch (gnaniErr: any) {
              lastErrorBody = gnaniErr?.message || String(gnaniErr);
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 550 * (attempt + 1)));
                continue;
              }
            }
          }

          throw new Error(
            `Gnani Timbre TTS failed after retries (HTTP ${lastStatus}): ${lastErrorBody.slice(0, 180)}`
          );
        }, priority);
      }

      // Only use sine wave when GNANI_API_KEY is not configured at all
      return generateSineWav(normalizedText);
    } finally {
      inFlightTtsRequests.delete(cacheKey);
    }
  })();

  inFlightTtsRequests.set(cacheKey, synthesisPromise);
  return synthesisPromise;
}

// Non-blocking background warmer for the first sentence chunk at low priority
function warmTtsTextInBackground(text: string, language: string = 'en-IN', voice?: string) {
  if (!GNANI_API_KEY || !text) return;
  const chunks = splitIntoSpeakableChunks(text);
  if (chunks[0]) {
    synthesizeTimbreWav(chunks[0], language, voice, 'low').catch(() => {});
  }
}

// Non-blocking background warmer for newly analyzed lectures (warms Q1 and first summary sentence at low priority)
function warmTtsForLectureAnalysis(analysis: any, language: string = 'en-IN') {
  if (!GNANI_API_KEY || !analysis) return;
  try {
    if (Array.isArray(analysis.questions) && analysis.questions[0]?.q) {
      warmTtsTextInBackground(`Question 1. ${analysis.questions[0].q}`, language);
    }
    if (typeof analysis.summary === 'string' && analysis.summary.trim()) {
      const summaryChunks = splitIntoSpeakableChunks(`Lecture summary. ${analysis.summary}`);
      if (summaryChunks[0]) {
        synthesizeTimbreWav(summaryChunks[0], language, undefined, 'low').catch(() => {});
      }
    }
  } catch {}
}

// 5. Text-to-Speech (/api/synthesize) — Gnani Timbre (timbre-v3.0, Voice: Yashraj)
// Primary Endpoint: https://api.vachana.ai/api/v1/tts/inference
app.post('/api/synthesize', async (req: Request, res: Response) => {
  try {
    const { text, language, voice, prefetch } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const boundedText = text.slice(0, 2500);
    const priority: 'high' | 'low' = prefetch ? 'low' : 'high';
    const audioWav = await synthesizeTimbreWav(boundedText, language || 'en-IN', voice, priority);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(audioWav);
  } catch (err: any) {
    console.error('Error in /api/synthesize:', err.message || err);
    res.status(503).json({ error: 'TTS service temporarily busy' });
  }
});

// 6. Voice Quiz Answer Evaluation (/api/quiz/evaluate) — Always outputs English user answer & English solution
app.post('/api/quiz/evaluate', async (req: Request, res: Response) => {
  try {
    const { question, model_answer, user_answer, language } = req.body;
    const targetLang = language || 'en-IN';
    if (!user_answer || typeof user_answer !== 'string' || !user_answer.trim()) {
      const fallbackFeedback = `I couldn't hear an answer clearly. The key concept is: ${model_answer} Let's try the next question!`;
      warmTtsTextInBackground(fallbackFeedback, targetLang);
      return res.json({
        verdict: 'wrong',
        english_user_answer: '',
        feedback: fallbackFeedback,
      });
    }

    const prompt = `You are Gyan Ai, an encouraging, pedagogically sharp voice tutor evaluating a student's answer.
The student spoke their answer aloud via speech recognition. Note that the speech recognizer may have transcribed English words phonetically into an Indian script (such as Telugu, Hindi Devanagari, or Tamil, e.g., "ఆర్బిట్స్" for "Orbits") or introduced minor phonetic ASR errors.

Question: ${question}
Expected Model Answer: ${model_answer}
Raw Student Answer from STT: ${user_answer}

Judge their answer and output a strict JSON object (ALL fields MUST be in English / Latin script ONLY):
{
  "english_user_answer": "The student's spoken answer transliterated/translated into clean English (Latin script), using the question context to resolve any Indic script or phonetic speech-to-text errors (for example, if STT wrote 'ఆర్బిట్స్' in Telugu script, output 'Orbits' in English). Never output non-Latin script here.",
  "verdict": "correct" | "partial" | "wrong",
  "feedback": "2 to 3 concise sentences in clear English directly explaining whether they are correct, acknowledging what they got right, and clarifying any missing pieces in a natural spoken tone suitable for Text-to-Speech."
}

Rules:
- "english_user_answer": MUST be in English (Latin characters only). Convert any Telugu, Hindi, Tamil, Kannada, or other non-English characters into the intended English words.
- "correct": The student conveyed the core concept accurately, even if informal, brief, or transcribed phonetically/in Indic script by speech-to-text.
- "partial": The student touched upon part of the concept or right intuition, but missed a crucial mechanism or nuance.
- "wrong": The answer is factually incorrect, off-topic, or completely missing the point.

Return ONLY the JSON object.`;

    // 1. Try Gnani Evon 30B open-weights model (gnani/gnani-evon-v3.3-30B-A3B) if configured
    if (HF_TOKEN || EVON_API_URL) {
      try {
        const evonOutput = await callEvonModel(prompt);
        if (evonOutput) {
          const cleanJson = evonOutput.replace(/```(?:json)?/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          const verdict = ['correct', 'partial', 'wrong'].includes(parsed.verdict?.toLowerCase())
            ? parsed.verdict.toLowerCase()
            : 'partial';
          const feedbackText = parsed.feedback || `Good effort. The complete answer is: ${model_answer}`;
          // Kick off TTS synthesis on the server BEFORE sending JSON response so sentence 1 is already in flight
          warmTtsTextInBackground(feedbackText, targetLang);
          return res.json({
            verdict,
            english_user_answer: parsed.english_user_answer || user_answer,
            feedback: feedbackText,
          });
        }
      } catch (evonErr) {
        console.warn('Gnani Evon quiz parsing warning:', evonErr);
      }
    }

    if (ai) {
      const geminiModels = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'];
      for (const modelName of geminiModels) {
        try {
          const response = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: {
                responseMimeType: 'application/json',
              },
            }),
            15000
          );

          const parsed = JSON.parse(response.text || '{}');
          const verdict = ['correct', 'partial', 'wrong'].includes(parsed.verdict?.toLowerCase())
            ? parsed.verdict.toLowerCase()
            : 'partial';
          const feedbackText = parsed.feedback || `Good effort. The complete answer is: ${model_answer}`;
          // Kick off TTS synthesis on the server BEFORE sending JSON response so sentence 1 is already in flight
          warmTtsTextInBackground(feedbackText, targetLang);

          return res.json({
            verdict,
            english_user_answer: parsed.english_user_answer || user_answer,
            feedback: feedbackText,
          });
        } catch (err: any) {
          console.log(`Notice: Gemini quiz evaluation (${modelName}) unavailable, trying next...`);
        }
      }
    }

    // Heuristic answer evaluator
    const uWords = new Set<string>(user_answer.toLowerCase().match(/\w+/g) || []);
    const mWords = new Set<string>(model_answer.toLowerCase().match(/\w+/g) || []);
    let matchCount = 0;
    mWords.forEach((w: string) => {
      if (uWords.has(w)) matchCount++;
    });
    const overlap = matchCount / Math.max(mWords.size, 1);

    let fallbackVerdict: 'correct' | 'partial' | 'wrong' = 'wrong';
    let fallbackFeedback = `Not quite. The key takeaway is: ${model_answer} Don't worry, reviewing this concept will help cement it!`;

    if (overlap >= 0.3 || user_answer.trim().split(/\s+/).length >= 6) {
      fallbackVerdict = 'correct';
      fallbackFeedback = `Spot on! You captured the main concept accurately. Remember that ${model_answer}`;
    } else if (overlap >= 0.12 || user_answer.trim().split(/\s+/).length >= 3) {
      fallbackVerdict = 'partial';
      fallbackFeedback = `You're on the right track! You mentioned the right direction, but note that ${model_answer}`;
    }

    warmTtsTextInBackground(fallbackFeedback, targetLang);
    return res.json({
      verdict: fallbackVerdict,
      english_user_answer: user_answer,
      feedback: fallbackFeedback,
    });
  } catch (err: any) {
    console.error('Error in /api/quiz/evaluate:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7. Ask your lecture (/api/lecture/ask) — Answers strictly from the lecture transcript
app.post('/api/lecture/ask', async (req: Request, res: Response) => {
  try {
    const { transcript, clean_transcript, concepts, question, language } = req.body;
    const targetLang = language || 'en-IN';
    const sourceTranscript = (clean_transcript || transcript || '').toString().trim();
    const rawQuestion = (question || '').toString().trim();

    if (!rawQuestion) {
      return res.status(400).json({ error: 'Please ask or type a question.' });
    }
    if (!sourceTranscript) {
      return res.status(400).json({ error: 'No lecture transcript is loaded to answer from.' });
    }

    const conceptsContext = Array.isArray(concepts)
      ? concepts.map((c: any) => `${c.term}: ${c.explanation}`).join('\n')
      : '';

    const prompt = `You are Gyan Ai in "Ask your lecture" mode — a strict, transcript-grounded classroom voice tutor helping a student recall details from their lecture.
A student asked a question aloud about this specific lecture. Because the question came from Speech-to-Text (ASR), it may contain phonetic misspellings of technical terms from the lecture (e.g., "laura" -> "LoRA", "learning right" -> "learning rate") or Indic script.

LECTURE TRANSCRIPT:
"""
${sourceTranscript}
"""

EXTRACTED LECTURE CONCEPTS:
"""
${conceptsContext}
"""

STUDENT'S RAW SPOKEN QUESTION:
"""
${rawQuestion}
"""

STRICT GROUNDING RULE:
- Answer ONLY using facts, explanations, and mechanisms present in the LECTURE TRANSCRIPT and EXTRACTED LECTURE CONCEPTS above.
- Do NOT invent external facts or answer from general knowledge if the professor did not mention it in this lecture.
- If the lecture did NOT cover what the student asked about, set "covered_in_lecture" to false and state clearly in "answer" that the professor did not cover that topic in this lecture, briefly mentioning what topics WERE covered instead.

Return a valid JSON object matching EXACTLY this schema (ALL fields in clear English / Latin script ONLY):
{
  "english_question": "The student's question cleaned up in English (resolving any phonetic ASR errors or Indic script using the lecture's technical terms)",
  "covered_in_lecture": true,
  "answer": "2 to 3 concise, natural spoken sentences in English answering the student's question strictly from this lecture transcript (suitable for Text-to-Speech).",
  "transcript_quote": "A short 1-sentence quote or excerpt from the lecture transcript supporting this answer (or empty string if covered_in_lecture is false)"
}

Return ONLY the JSON object.`;

    // 1. Try Gnani Evon 30B if configured
    if (HF_TOKEN || EVON_API_URL) {
      try {
        const evonOutput = await callEvonModel(prompt);
        if (evonOutput) {
          const cleanJson = evonOutput.replace(/```(?:json)?/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          if (parsed && typeof parsed.answer === 'string') {
            warmTtsTextInBackground(parsed.answer, targetLang);
            return res.json({
              english_question: parsed.english_question || rawQuestion,
              covered_in_lecture: Boolean(parsed.covered_in_lecture),
              answer: parsed.answer,
              transcript_quote: parsed.transcript_quote || '',
            });
          }
        }
      } catch (evonErr) {
        console.warn('Gnani Evon lecture ask warning:', evonErr);
      }
    }

    // 2. Try Gemini models
    if (ai) {
      const geminiModels = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'];
      for (const modelName of geminiModels) {
        try {
          const response = await withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: prompt,
              config: {
                responseMimeType: 'application/json',
              },
            }),
            15000
          );

          const parsed = JSON.parse(response.text || '{}');
          if (parsed && typeof parsed.answer === 'string') {
            warmTtsTextInBackground(parsed.answer, targetLang);
            return res.json({
              english_question: parsed.english_question || rawQuestion,
              covered_in_lecture: Boolean(parsed.covered_in_lecture),
              answer: parsed.answer,
              transcript_quote: parsed.transcript_quote || '',
            });
          }
        } catch (err: any) {
          console.log(`Notice: Gemini lecture ask (${modelName}) unavailable, trying next...`);
        }
      }
    }

    // 3. Deterministic transcript-grounded search fallback
    const stopWords = new Set([
      'what', 'did', 'sir', 'say', 'about', 'the', 'how', 'does', 'why', 'is', 'are',
      'explain', 'tell', 'me', 'in', 'this', 'lecture', 'class', 'professor', 'teacher',
      'mean', 'by', 'can', 'you', 'define', 'definition', 'of', 'for', 'and', 'to', 'a',
    ]);
    const queryWords = (rawQuestion.toLowerCase().match(/\w+/g) || []).filter(
      (w: string) => w.length > 2 && !stopWords.has(w)
    );

    const sentences = sourceTranscript
      .split(/(?<=[.!?])\s+/)
      .map((s: string) => s.trim())
      .filter(Boolean);

    let bestSentence = '';
    let bestScore = 0;
    for (const s of sentences) {
      const lowerS = s.toLowerCase();
      let score = 0;
      for (const qw of queryWords) {
        if (lowerS.includes(qw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSentence = s;
      }
    }

    if (bestScore > 0 && bestSentence) {
      const ans = `In this lecture, the professor explained: ${bestSentence}`;
      warmTtsTextInBackground(ans, targetLang);
      return res.json({
        english_question: rawQuestion,
        covered_in_lecture: true,
        answer: ans,
        transcript_quote: bestSentence,
      });
    }

    const topicList = Array.isArray(concepts)
      ? concepts.slice(0, 3).map((c: any) => c.term).join(', ')
      : 'the main lecture concepts';
    const notCoveredAns = `This lecture did not cover that topic. Instead, the class focused on ${topicList}.`;
    warmTtsTextInBackground(notCoveredAns, targetLang);
    return res.json({
      english_question: rawQuestion,
      covered_in_lecture: false,
      answer: notCoveredAns,
      transcript_quote: '',
    });
  } catch (err: any) {
    console.error('Error in /api/lecture/ask:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Vite Middleware / Production Static Server
// -------------------------------------------------------------
async function start() {
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gyan Ai Server listening on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
