# Gyan AI

**Record your lecture. Revise it by voice. Quiz yourself out loud.**

## The problem

> "Vanakkam pa, inaiku Machine Learning session la Gradient Descent pathi clear ah paakalam."

That is one sentence from one lecture: Tamil grammar, English terms, no pause between them. Indian classrooms work this way every day. Students keep up for a while, the teacher speeds up, and the notes stop. Revising later means rereading half-finished notes in a half-remembered mix of languages. Most note-taking and transcription tools assume one clean language, so these students do the work by hand.

## The solution

Gyan AI turns a recorded lecture into something you can revise by ear: a transcript, study notes, and a quiz you answer out loud, with spoken feedback that explains what you missed.

## Features

- **Capture:** record in the browser with Start and Stop, upload audio (WAV, MP3, WebM, M4A, FLAC), or paste notes. Sample lectures are built in.
- **Language choice:** Hindi-English, Tamil-English or English.
- **Two transcripts:** the original from Prisma and a version corrected by the LLM using context. Both are kept.
- **Study notes:** a summary, key concepts and a five-question quiz.
- **Listen:** hear the full notes, the summary or any single concept read aloud.
- **Voice quiz:** the question is spoken, you answer by voice (or type), and the answer is checked and explained aloud.
- **Saved lectures:** stored on your device, searchable by topic or concept, filterable by language, exportable as JSON.
- **Mobile friendly:** designed for phones, where students actually record.

## How Gnani's models do the work

- **Prisma (speech to text):** transcribes code-mixed lecture audio and your spoken quiz answers. Prisma v3.0 covers nine Indian languages plus English; this version offers Hindi-English, Tamil-English and English.
- **Timbre (text to speech):** reads the summary and each concept aloud, speaks the quiz questions and gives the feedback.
- **Gemini:** writes the summary, concepts and quiz, corrects the transcript and checks answers.

Voice is the whole loop, speech in and speech out, not a feature added on top. You can revise without looking at a screen.

## What I built and tested

A working app, tested on real recorded lectures: Noisy Tamil-English lecture, Hindi-english lecture, Tamil Lectures, English, Telugu, Hindi . I also added an LLM correction pass that uses context to repair errors, and the app keeps the original transcript next to the corrected one. API keys stay on the server, and saved lectures stay on the student's own device.

Early feedback from classmates who tried it: it is really useful before exams for revising one particular concept, instead of skimming entire slide decks.

## Who it's for

Students from school to college whose lessons mix English with Hindi, Tamil or another language, and who understand better in that mix than in a textbook's clean English. A school student revising a chapter before a test and a college student preparing for exams get the same thing from one recording: notes, listening and self-testing.

## What's next

Teachers publish a lecture to a class code so one recording helps every student. Ask the lecture a question by voice and hear an answer drawn only from what was taught. Revise weak quiz topics automatically.
