# Gyan AI — The Code-Mixed Voice Lecture Tutor

**Gyan Ai** is an intelligent voice tutor that listens to teacher lectures, understands English, Hindi-English (Hinglish), and Tamil-English (Tanglish) code-mixed speech, and teaches the material back through conversational voice explanations and interactive voice quizzes.

---

## Architecture & Features

1. **Teacher Audio Ingestion**
   - **Live Recording**: Built-in browser `MediaRecorder` with live audio waveform meters, elapsed timers, and automatic 30–60 second chunking with progressive transcript stitching.
   - **Audio File Upload**: Upload audio recordings in WebM, Opus, MP3, WAV, or M4A format.
   - **ffmpeg Audio Conversion**: Automatically normalizes browser WebM/Opus audio to 16kHz 16-bit mono PCM WAV for the Gnani Prisma STT engine.

2. **Speech-to-Text (STT) via Gnani Prisma API**
   - Supports English (`en-IN`), Hindi-English code-mixed (`hi-IN`), and Tamil-English code-mixed (`ta-IN`).
   - Handles multi-chunk audio uploads and streams stitched partial transcripts as chunks finish.
   - Includes graceful fallback mocks and Gemini multi-modal speech transcription so the app runs seamlessly out of the box even before API keys are configured.

3. **LLM Engine: Gnani Evon (30B) & Multimodal Engine (`llm_client.py` & Server Engine)**
   - Powered by **Gnani Evon v3.3 30B** (`gnani/gnani-evon-v3.3-30B-A3B`), the open-weights 30B parameter foundation model on Hugging Face:
     ```python
     from transformers import pipeline

     pipe = pipeline("text-generation", model="gnani/gnani-evon-v3.3-30B-A3B")
     messages = [
         {"role": "user", "content": "Analyze lecture transcript..."},
     ]
     pipe(messages)
     ```
   - Supports local `transformers` pipeline, Hugging Face Inference API (`HF_TOKEN`), remote vLLM endpoints (`EVON_API_URL`), and Gemini AI.
   - Turns raw speech into structured output adhering to the exact required JSON schema:
     - `clean_transcript`: Polished, readable text correcting filler and ASR artifacts while preserving domain terms.
     - `summary`: 2–4 sentence high-level executive summary.
     - `concepts`: 5 to 8 key concepts with clear one-line explanations.
     - `questions`: 5 targeted quiz questions with model answers.
   - Automatic 1-retry mechanism with corrective prompts if invalid JSON is received.

4. **Text-to-Speech (TTS) via Gnani Timbre API ("Explain Mode")**
   - Reads the executive summary and key concepts aloud with synchronized highlight tracking.
   - Pause, resume, and voice pitch/speed controls.

5. **Interactive Voice Quiz Loop ("Quiz Mode")**
   - Gyan Ai speaks each question aloud using Timbre TTS.
   - Student clicks the mic to speak their answer in real-time.
   - Gnani Prisma transcribes the spoken response.
   - The LLM judges the answer (`correct`, `partial`, or `wrong`) and produces 2–3 sentences explaining the gap in an encouraging spoken tone.
   - Timbre reads the feedback aloud to the student.
   - Displays real-time progress, correct count, and a final score summary with review notes.

6. **"My Lectures" Session Library & Offline Demo Pre-loading**
   - Automatic local persistence in browser `localStorage` under `gyan_ai_saved_lectures`.
   - Every recorded lecture, clean transcript, concept summary, and quiz is saved with timestamps, word counts, and language metadata.
   - Pre-seeds 3 high-quality code-mixed demo lectures on initial load so you can present complete end-to-end demos without relying on external network or API availability.
   - Search by topic or concept, filter by language (Hinglish, Tanglish, English), export sessions as JSON, and jump straight into Voice Quiz or Concept study.

---

## Project Structure

```
├── .env.example              # Environment variables template
├── gnani_client.py           # Gnani Prisma STT & Timbre TTS client + ffmpeg conversion
├── llm_client.py             # LLM analysis & voice quiz judging with JSON validation
├── main.py                   # FastAPI backend implementation
├── requirements.txt          # Python dependencies (FastAPI, uvicorn, requests, google-genai)
├── server.ts                 # Full-stack Node/Express server with Vite middleware & APIs
├── test_cases.json           # 3 sample code-mixed lecture test cases
├── src/
│   ├── App.tsx               # Main voice tutor UI with Tabs, Audio recorder & Quiz
│   ├── components/           # AudioRecorder, ExplainMode, QuizMode, TestCases, Navbar
│   ├── types.ts              # TypeScript interfaces for Analysis, Quiz, Audio state
│   └── main.tsx              # React entry point
└── package.json              # Web dependencies
```

---

## Prerequisites

1. **ffmpeg**: Required to convert browser WebM/Opus audio to 16kHz PCM WAV.
   - **Ubuntu/Debian**: `sudo apt update && sudo apt install -y ffmpeg`
   - **macOS**: `brew install ffmpeg`
   - **Windows**: `winget install Gyan.FFmpeg` or download from [ffmpeg.org](https://ffmpeg.org).
2. **Node.js** (v18+) & **Python** (3.10+).

---

## Configuration (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your credentials:

```ini
# Gnani.ai Single API Key for Prisma STT and Timbre TTS
GNANI_API_KEY="your-gnani-api-key"
GNANI_STT_URL="https://asr.gnani.ai/v1/recognize"
GNANI_TTS_URL="https://tts.gnani.ai/v1/synthesize"

# Gnani Evon 30B LLM (gnani/gnani-evon-v3.3-30B-A3B)
HF_TOKEN="your-huggingface-token"
EVON_API_URL="" # Optional vLLM or HF inference endpoint
USE_LOCAL_EVON="false"

# Alternative / Fallback Cloud LLM Key
GEMINI_API_KEY="your-gemini-api-key"

PORT=3000
```

> **Note on Fallback**: If `GNANI_API_KEY` or `LLM_API_KEY` is not provided, Gyan Ai uses intelligent fallback mocks and pre-loaded test case engines so that you can test every button and screen immediately.

---

## Running the Application

### Option 1: Integrated Full-Stack Server (Recommended for Preview & Local)

This runs the Express API server and mounts the Vite frontend on port 3000:

```bash
# 1. Install dependencies
npm install

# 2. Start full-stack server
npm run dev
```

Open your browser to: `http://localhost:3000`

### Option 2: Standalone FastAPI Backend + Frontend

1. **Start the Python FastAPI backend:**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
   ```

2. **Start the Frontend:**
   ```bash
   npm run dev
   ```

---

## Microphone Security Note

> **CRITICAL**: Modern browsers only grant microphone access (`navigator.mediaDevices.getUserMedia`) on **`localhost`** or **HTTPS** origins. If accessing over a remote IP address without HTTPS, audio file upload can still be used.

---

## Verification Pipeline: 4-Stage Test Plan

The system has been designed and tested across four sequential milestones:

1. **Stage 1: Record / Upload → Prisma STT Transcript**
   - Click **Record Live Lecture** or upload an audio file.
   - Choose language: **Hindi-English**, **Tamil-English**, or **English**.
   - Notice real-time chunking indicator (30–60s slices) and stitched transcript output.
2. **Stage 2: LLM Analysis**
   - Click **Analyze Lecture**.
   - Verifies generation of: `clean_transcript`, `summary`, 5–8 `concepts`, and 5 `questions`.
3. **Stage 3: Timbre Readout ("Explain Mode")**
   - Click **Explain Mode**.
   - Timbre TTS plays the lecture summary and cycles through each key concept with active line highlighting.
4. **Stage 4: Voice Quiz Loop ("Quiz Mode")**
   - Click **Quiz Mode**.
   - Gyan Ai vocalizes Question 1.
   - Student clicks **Tap to Speak Answer**.
   - Answer is transcribed, LLM evaluates verdict (`correct`, `partial`, `wrong`), provides a 2–3 sentence gap explanation, and speaks it aloud.
   - Once all 5 questions are answered, student receives their final score and performance report.

---

## 3 Sample Test Cases Included

If you do not have a microphone available, load any of the 3 pre-built code-mixed test lectures from the top bar:
1. **Operating Systems: Process Synchronization** (Hindi-English / Hinglish)
2. **Machine Learning: Gradient Descent** (Tamil-English / Tanglish)
3. **Data Structures: Contiguous Memory & Big-O** (Indian English)
