import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const sessions = new Map();

// ========================
// FINAL RULES
// ========================
const INITIAL_MIN_QUESTIONS = 8;
const INITIAL_MAX_QUESTIONS = 13;

const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 8;

const MAX_CONSECUTIVE_GUESSES = 3;

// ========================
// HELPERS
// ========================
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know'
  };

  return map[String(answer || '').trim()] || 'dont_know';
}

function makeSystemPrompt(language = 'ar') {
  return `You are the final production-grade character guessing engine for a mobile app.

MISSION:
Identify the user's character through very short, high-value, contradiction-free questions.

STRICT FORMAT:
- Return STRICT JSON only.
- No markdown.
- No explanations.
- No commentary.
- No multiple options in one question.

ALLOWED ANSWERS:
yes, no, maybe, dont_know

ABSOLUTE QUESTION RULES:
- Ask only ONE question at a time.
- Arabic questions should usually be 2 to 5 words.
- English questions should usually be 2 to 7 words.
- Keep them sharp, natural, and easy.
- Never mention any person name during question mode.
- Never ask name-based questions.
- Never ask a double-choice question such as "male or female".
- Never ask generic weak questions like "Is this person famous?" unless there is absolutely no better discriminator.
- Never repeat a previous question or repeat the same meaning with different wording.
- Never contradict confirmed information.
- Never jump to an unrelated domain after a strong confirmation.
- Every question should eliminate many possibilities.

BEST QUESTION ORDER:
1. real vs fictional
2. male vs female
3. broad field
4. nationality / region
5. alive vs dead
6. narrower category
7. strong discriminator
8. move toward best guess

QUALITY EXAMPLES:
Good:
- "هل هو رجل؟"
- "هل هي خيالية؟"
- "هل هو رياضي؟"
- "هل هو عربي؟"
- "هل هو حي؟"
- "هل هو ممثل؟"

Bad:
- "هل هو ذكر أو أنثى؟"
- "هل تعرفه؟"
- "هل هذه الشخصية مشهورة؟"
- "Is it male or female?"
- "Do you know him?"
- Any question mentioning a candidate name

GUESS RULES:
- Guess only one person.
- Never repeat rejected guesses.
- Do not guess before enough evidence.
- When enough evidence exists, guess decisively.
- After multiple wrong guesses, return to tighter questions before guessing again.

LANGUAGE:
- If language is "ar", output Arabic only.
- If language is "en", output English only.

OUTPUT FORMAT:

Question:
{"type":"question","text":"..."}

Guess:
{"type":"guess","name":"...","confidence":0.82}`;
}

function sessionTranscript(session) {
  const turns = session.turns.length
    ? session.turns
        .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
        .join('\n')
    : 'No questions yet.';

  const rejected = session.rejectedGuesses.length
    ? session.rejectedGuesses.join(', ')
    : 'none';

  return [
    `Turns:\n${turns}`,
    `Rejected guesses: ${rejected}`,
    `Wrong guess streak: ${session.guessStreak}`,
    `Questions in current phase: ${session.questionsSincePhaseReset}`,
    `Current phase window: ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}`
  ].join('\n\n');
}

function canGuessNow(session) {
  return session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
}

function mustGuessNow(session) {
  return session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;
}

function safeLower(v) {
  return String(v || '').trim().toLowerCase();
}

function wordCount(text = '') {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function isQuestionTooLong(text = '', language = 'ar') {
  const count = wordCount(text);
  return language === 'ar' ? count > 5 : count > 7;
}

function isWeakQuestion(text = '') {
  const lower = safeLower(text);

  const weakPatterns = [
    'هل هو مشهور',
    'هل هي مشهورة',
    'هل هذه الشخصية مشهورة',
    'هل تعرفه',
    'هل تعرفها',
    'هل تعرف هذه الشخصية',
    'is it famous',
    'is this person famous',
    'is this character famous',
    'do you know',
    'is it well known',
    'is the person popular'
  ];

  return weakPatterns.some((x) => lower.includes(x));
}

function isDoubleChoiceQuestion(text = '') {
  const lower = safeLower(text);
  return (
    lower.includes(' أو ') ||
    lower.includes('or') ||
    lower.includes('male or female') ||
    lower.includes('ذكر أو أنثى')
  );
}

function looksLikeNameQuestion(text = '') {
  const lower = safeLower(text);
...
