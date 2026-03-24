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

// ===== RULES =====
const INITIAL_MIN_QUESTIONS = 8;
const INITIAL_MAX_QUESTIONS = 13;

const FOLLOWUP_MIN_QUESTIONS = 5;
const FOLLOWUP_MAX_QUESTIONS = 8;

const MAX_CONSECUTIVE_GUESSES = 3;

// ===== HELPERS =====
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know'
  };

  return map[answer] || 'dont_know';
}

function makeSystemPrompt(language = 'ar') {
  return `You are an elite character guessing engine.

GOAL:
Guess the user's character with sharp, short, high-quality elimination questions.

ABSOLUTE RULES:
- Ask ONLY ONE question at a time.
- Allowed user answers are ONLY: yes, no, maybe, dont_know
- Questions must be SHORT.
- Arabic questions should usually be 2 to 5 words.
- English questions should usually be 2 to 7 words.
- Never explain reasoning.
- Never add commentary.
- Return STRICT JSON only.

QUESTION QUALITY:
- Questions must eliminate many possibilities.
- Questions must be specific and useful.
- Do NOT ask weak questions.
- Do NOT ask broad useless questions unless necessary.
- Do NOT repeat previous questions.
- Do NOT ask the same meaning in different wording.
- Do NOT contradict previous answers.
- Do NOT mention any person name while asking questions.
- Do NOT ask name-based questions.
- Do NOT leak candidate names during question mode.

GOOD QUESTION FLOW:
1. Real vs fictional
2. Male vs female
3. General field/profession
4. Region / nationality
5. Alive vs dead
6. Narrow category
7. Strong discriminator
8. Move toward confident guess

BAD QUESTIONS TO AVOID:
- "Is this person famous?"
- "Do you know him?"
- "Is this character well known?"
- Any question that feels generic or wasteful
- Any question mentioning a person name

GUESS RULES:
- Never guess too early.
- Guess only when enough evidence exists.
- Return only ONE name in guess mode.
- Never repeat rejected guesses.

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
    `Consecutive wrong guesses: ${session.guessStreak}`,
    `Questions in current phase: ${session.questionsSincePhaseReset}`,
    `Current guess window: ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}`
  ].join('\n\n');
}

function shortFallbackQuestion(language = 'ar', turnCount = 0) {
  const ar = [
    'هل هي حقيقية؟',
    'هل هو رجل؟',
    'هل هي امرأة؟',
    'هل هو فنان؟',
    'هل هو رياضي؟',
    'هل هو ممثل؟',
    'هل هو مغني؟',
    'هل هو عربي؟',
    'هل هو أجنبي؟',
    'هل هو حي؟',
    'هل هو سياسي؟',
    'هل هو لاعب كرة؟',
    'هل هو خيالي؟'
  ];

  const en = [
    'Is it real?',
    'Is it male?',
    'Is it female?',
    'Is it an artist?',
    'Is it an athlete?',
    'Is it an actor?',
    'Is it a singer?',
    'Is it Arab?',
    'Is it foreign?',
    'Is it alive?',
    'Is it a politician?',
    'Is it a footballer?',
    'Is it fictional?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'شخصية مشهورة', confidence: 0.25 }
    : { type: 'guess', name: 'A famous person', confidence: 0.25 };
}

function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 5 : words.length > 7;
}

function isWeakQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();

  const weakPatterns = [
    'هل هو مشهور',
    'هل هي مشهورة',
    'هل هذه الشخصية مشهورة',
    'هل تعرفه',
    'هل تعرفها',
    'is it famous',
    'is this person famous',
    'do you know',
    'is this character famous'
  ];

  return weakPatterns.some((w) => lower.includes(w));
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();

  if (
    lower.startsWith('is it ') ||
    lower.startsWith('is this ') ||
    lower.startsWith('could it be ') ||
    lower.startsWith('is the person ')
  ) {
    return true;
  }

  if (lower.includes('هل هو ') || lower.includes('هل هي ')) {
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length > 4) return true;
  }

  return false;
}

function sanitizeEngineResult(result, session) {
  const turnCount = session.turns.length;

  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (
      isQuestionTooLong(text, session.language) ||
      isWeakQuestion(text) ||
      looksLikeNameQuestion(text) ||
      session.turns.some((t) => String(t.question || '').trim() === text)
    ) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();

    if (!name) {
      return fallbackGuess(session.language);
    }

    if (session.rejectedGuesses.includes(name)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    return {
      type: 'guess',
      name,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.6
    };
  }

  return {
    type: 'question',
    text: shortFallbackQuestion(session.language, turnCount)
  };
}

function canGuessNow(session) {
  return session.questionsSincePhaseReset >= session.minQuestionsBeforeGuess;
}

function mustGuessNow(session) {
  return session.questionsSincePhaseReset >= session.maxQuestionsBeforeGuess;
}

async function forceSingleGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Make your single best guess now.
Do NOT repeat rejected guesses.
Return STRICT JSON only.

Format:
{"type":"guess","name":"...","confidence":0.82}`
      },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionTranscript(session)}

Make only one best guess now.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const clean = sanitizeEngineResult(parsed, session);
    return clean.type === 'guess' ? clean : fallbackGuess(session.language);
  } catch {
    return fallbackGuess(session.language);
  }
}

async function askEngine(session) {
  const turnCount = session.turns.length;

  if (!openai) {
    if (mustGuessNow(session)) {
      return fallbackGuess(session.language);
    }

    if (canGuessNow(session)) {
      return fallbackGuess(session.language);
    }

    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionTranscript(session)}

SERVER RULES:
- Current phase guess window is ${session.minQuestionsBeforeGuess} to ${session.maxQuestionsBeforeGuess}.
- Do NOT guess before question count ${session.minQuestionsBeforeGuess} in this phase.
- MUST guess if question count reached ${session.maxQuestionsBeforeGuess} in this phase.
- Do NOT repeat rejected guesses.
- Do NOT mention names during questions.
- Keep questions short and strong.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    let result = sanitizeEngineResult(parsed, session);

    if (result.type === 'guess' && !canGuessNow(session)) {
      result = {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (mustGuessNow(session) && result.type !== 'guess') {
      return await forceSingleGuess(session);
    }

    return result;
  } catch {
    if (mustGuessNow(session)) {
      return await forceSingleGuess(session);
    }

    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount)
    };
  }
}

async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name || '').replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);

  if (!res.ok) {
    return {
      title: name,
      extract: language === 'ar'
        ? 'لا توجد معلومات متاحة'
        : 'No information available',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }

  const json = await res.json();

  return {
    title: json.title || name,
    extract: json.extract || '',
    imageURL: json.thumbnail?.source || null,
    articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
  };
}

// ===== ROUTES =====
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model,
    hasOpenAI: Boolean(openai)
  });
});

app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();

    const session = {
      id: sessionId,
      language,
      turns: [],
      rejectedGuesses: [],
      guessStreak: 0,
      questionsSincePhaseReset: 0,
      minQuestionsBeforeGuess: INITIAL_MIN_QUESTIONS,
      maxQuestionsBeforeGuess: INITIAL_MAX_QUESTIONS
    };

    sessions.set(sessionId, session);

    const result = await askEngine(session);
    return res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.turns.push({
      question: String(question || ''),
      answer: normalizeAnswer(answer)
    });

    session.questionsSincePhaseReset += 1;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (correct) {
      const wiki = await fetchWikipediaSummary(String(guessName || ''), session.language);

      session.guessStreak = 0;
      session.questionsSincePhaseReset = 0;
      session.minQuestionsBeforeGuess = INITIAL_MIN_QUESTIONS;
      session.maxQuestionsBeforeGuess = INITIAL_MAX_QUESTIONS;

      return res.json({
        type: 'revealed',
        guessName,
        wiki
      });
    }

    if (guessName) {
      session.rejectedGuesses.push(String(guessName));
    }

    session.guessStreak += 1;

    // أول 3 تخمينات متتالية
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceSingleGuess(session);
      return res.json(result);
    }

    // بعد ثالث رفض: يرجع للأسئلة 5 إلى 8
    session.guessStreak = 0;
    session.questionsSincePhaseReset = 0;
    session.minQuestionsBeforeGuess = FOLLOWUP_MIN_QUESTIONS;
    session.maxQuestionsBeforeGuess = FOLLOWUP_MAX_QUESTIONS;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const wiki = await fetchWikipediaSummary(name, language);
    return res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
