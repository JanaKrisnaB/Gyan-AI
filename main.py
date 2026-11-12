"""
FastAPI backend for Gyan Ai.
Provides voice tutor REST APIs:
- POST /api/transcribe: Speech-to-Text via Gnani Prisma (supports chunked stitching)
- POST /api/analyze: LLM clean transcript, summary, 5-8 concepts, 5 quiz questions
- POST /api/synthesize: Text-to-Speech via Gnani Timbre
- POST /api/quiz/evaluate: LLM verdict & spoken feedback explanation
- GET /api/test-cases: 3 sample code-mixed test lectures
- GET /api/health: System status
"""

import os
import json
import logging
from typing import Optional, List
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import gnani_client
import llm_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gyan_ai_fastapi")

app = FastAPI(
    title="Gyan Ai Voice Tutor API",
    description="Backend API for lecture transcription, analysis, voice explanation, and quiz evaluation.",
    version="1.0.0"
)

# CORS setup for local and cross-origin access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request Models
class AnalyzeRequest(BaseModel):
    transcript: str
    language: Optional[str] = "en"

class SynthesizeRequest(BaseModel):
    text: str
    language: Optional[str] = "en"
    voice: Optional[str] = "female"

class QuizEvaluateRequest(BaseModel):
    question: str
    model_answer: str
    user_answer: str
    language: Optional[str] = "en"


@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "gnani_configured": bool(os.getenv("GNANI_API_KEY")),
        "hf_evon_configured": bool(os.getenv("HF_TOKEN") or os.getenv("EVON_API_URL")),
        "llm_configured": bool(os.getenv("HF_TOKEN") or os.getenv("LLM_API_KEY") or os.getenv("GEMINI_API_KEY")),
        "stt_endpoint": os.getenv("GNANI_STT_URL", "https://api.vachana.ai/stt/v3"),
        "tts_endpoint": os.getenv("GNANI_TTS_URL", "https://api.vachana.ai/api/v1/tts/inference")
    }


@app.post("/api/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = Form("en"),
    chunk_index: Optional[int] = Form(0),
    total_chunks: Optional[int] = Form(1)
):
    """
    Transcribes uploaded or recorded audio using Gnani Prisma STT.
    Converts input audio with ffmpeg to 16kHz mono WAV.
    Supports single full recordings or multi-chunk uploads.
    """
    try:
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file provided.")

        logger.info(f"Received audio ({len(audio_bytes)} bytes), language={language}, chunk={chunk_index+1}/{total_chunks}")
        transcript_text = gnani_client.transcribe(audio_bytes, language=language)

        return {
            "transcript": transcript_text,
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            "is_final": (chunk_index + 1 >= total_chunks)
        }
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/analyze")
def analyze_lecture_endpoint(req: AnalyzeRequest):
    """
    Turns lecture transcript into:
    - Cleaned transcript
    - Short summary
    - 5-8 key concepts
    - 5 quiz questions with model answers
    """
    try:
        result = llm_client.analyze_lecture(req.transcript, language=req.language or "en")
        return result
    except Exception as e:
        logger.error(f"Analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/synthesize")
def synthesize_speech_endpoint(req: SynthesizeRequest):
    """
    Text-to-speech via Gnani Timbre API.
    Returns audio/wav binary stream.
    """
    try:
        audio_bytes = gnani_client.synthesize(req.text, language=req.language or "en", voice=req.voice or "female")
        return Response(content=audio_bytes, media_type="audio/wav")
    except Exception as e:
        logger.error(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/quiz/evaluate")
def evaluate_quiz_endpoint(req: QuizEvaluateRequest):
    """
    Evaluates student's spoken answer and returns verdict and explanation feedback.
    """
    try:
        result = llm_client.evaluate_quiz_answer(
            question=req.question,
            model_answer=req.model_answer,
            user_answer=req.user_answer
        )
        return result
    except Exception as e:
        logger.error(f"Evaluation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/test-cases")
def get_test_cases():
    """Returns sample test cases for demonstration and testing."""
    test_cases_file = os.path.join(os.path.dirname(__file__), "test_cases.json")
    if os.path.exists(test_cases_file):
        with open(test_cases_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
