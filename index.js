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

const MIN_QUESTIONS_BEFORE_GUESS = 7;
const MAX_QUESTIONS_BEFORE_FORCE_GUESS = 10;
const MAX_CONSECUTIVE_GUESSES = 3;
const QUESTIONS_AFTER_FAILED_GUESS_SERIES = 2;

function makeSystemPrompt(language = 'ar') {
  return `You are an expert character guessing engine.

GOAL:
Guess the user's character accurately in 7 to 10 questions.

STRICT RULES:
- Ask ONLY ONE yes/no question at a time.
- Allowed answers are: yes, no, maybe, dont_know.
- Questions must be SHORT.
- Arabic questions should usually be 2 to 6 words.
- English questions should usually be 2 to 8 words.
- Do NOT explain your reasoning.
- Do NOT add extra commentary.
- Return STRICT JSON only.

QUESTION STRATEGY:
1. Real or fictional
2. Gender
3. Broad profession/category
4. Nationality/region
5. Alive or dead
6. Narrow professional type
7. Move strongly toward a guess

QUESTION QUALITY:
- Do not repeat previous questions.
- Do not ask the same idea in different wording.
- Do not contradict previous answers.
- Each question must eliminate many possibilities.

NAME RESTRICTION:
- During question mode, NEVER mention any person name.
- NEVER ask name-based questions.
- Names are allowed ONLY in guess mode.

GUESS RULES:
- Never guess before question ${MIN_QUESTIONS_BEFORE_GUESS}.
- Try to guess between question ${MIN_QUESTIONS_BEFORE_GUESS} and ${MAX_QUESTIONS_BEFORE_FORCE_GUESS}.
- If confidence is high, make ONE guess only.
- Never output more than one name.

AFTER WRONG GUESS:
- Do not repeat rejected guesses.
- After 3 wrong guesses in a row, return to question mode.
- Ask at least ${QUESTIONS_AFTER_FAILED_GUESS_SERIES} more strong questions before guessing again.

LANGUAGE:
- If language is 'ar', output Arabic only.
- If language is 'en', output English only.

OUTPUT FORMAT:

Question:
{"type":"question","text":"..."}

Guess:
{"type":"guess","name":"...","confidence":0.82}`;
}

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

function sessionMessages(session) {
  const transcript = session.turns.length
    ? session.turns
        .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
        .join('\n')
    : 'No questions yet.';

  const rejected = session.rejectedGuesses.length
    ? `Rejected guesses: ${session.rejectedGuesses.join(', ')}`
    : 'Rejected guesses: none';

  return `${transcript}\n${rejected}\nGuess streak: ${session.guessStreak}\nQuestions since guess reset: ${session.questionsSinceGuessReset}`;
}

function shortFallbackQuestion(language = 'ar', turnCount = 0) {
  const ar = [
    'هل هو حقيقي؟',
    'هل هو رجل؟',
    'هل هو فنان؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو ممثل؟',
    'هل هو مغني؟',
    'هل هو رياضي؟',
    'هل هو سياسي؟',
    'هل هو مشهور؟'
  ];

  const en = [
    'Is it real?',
    'Is it male?',
    'Is it an artist?',
    'Is it Arab?',
    'Is it alive?',
    'Is it an actor?',
    'Is it a singer?',
    'Is it an athlete?',
    'Is it a politician?',
    'Is it famous?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'شخصية مشهورة', confidence: 0.3 }
    : { type: 'guess', name: 'A famous person', confidence: 0.3 };
}

function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 6 : words.length > 8;
}

function isWeakQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();

  const weak = [
    'هل هو مشهور',
    'هل هذه الشخصية مشهورة',
    'is it famous',
    'is this person famous',
    'هل تعرفه',
    'do you know'
  ];

  return weak.some((w) => lower.includes(w));
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();

  return (
    lower.startsWith('is it ') ||
    lower.startsWith('is this ') ||
    lower.startsWith('could it be ') ||
    lower.includes('هل هو ') && lower.split(/\s+/).length > 4
  );
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

    if (isQuestionTooLong(text, session.language) || isWeakQuestion(text) || looksLikeNameQuestion(text)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (session.turns.some((t) => t.question.trim() === text)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();

    if (!name) return fallbackGuess(session.language);

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

async function forceSingleGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.25,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Make your single best guess now.
Do not repeat rejected guesses.
Return STRICT JSON only.

Format:
{"type":"guess","name":"...","confidence":0.82}`
      },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

Make one best guess now.`
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
  const mayGuess =
    turnCount >= MIN_QUESTIONS_BEFORE_GUESS &&
    session.questionsSinceGuessReset >= QUESTIONS_AFTER_FAILED_GUESS_SERIES;

  if (!openai) {
    if (turnCount < MIN_QUESTIONS_BEFORE_GUESS) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.35,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

SERVER RULES:
- Keep question mode clean and short.
- Never mention names in questions.
- Never guess before question ${MIN_QUESTIONS_BEFORE_GUESS}.
- After 3 failed guesses, return to question mode.
- Ask at least ${QUESTIONS_AFTER_FAILED_GUESS_SERIES} more questions before guessing again after a failed guess series.
- Never repeat rejected guesses.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const result = sanitizeEngineResult(parsed, session);

    if (result.type === 'guess' && !mayGuess) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (turnCount >= MAX_QUESTIONS_BEFORE_FORCE_GUESS && result.type !== 'guess') {
      return await forceSingleGuess(session);
    }

    return result;
  } catch {
    if (turnCount >= MAX_QUESTIONS_BEFORE_FORCE_GUESS) {
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
  const title = encodeURIComponent(name.replace(/ /g, '_'));
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
      questionsSinceGuessReset: QUESTIONS_AFTER_FAILED_GUESS_SERIES
    };

    sessions.set(sessionId, session);

    const result = await askEngine(session);
    res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    res.status(500).json({ error: 'Failed to start game' });
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

    session.questionsSinceGuessReset += 1;
    session.guessStreak = 0;

    const result = await askEngine(session);
    res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    res.status(500).json({ error: 'Failed to process answer' });
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
      session.questionsSinceGuessReset = QUESTIONS_AFTER_FAILED_GUESS_SERIES;

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

    // أول 3 مرات: يسمح بتخمينات متتالية
    if (session.guessStreak < MAX_CONSECUTIVE_GUESSES) {
      const result = await forceSingleGuess(session);
      return res.json(result);
    }

    // في الرابعة: يرجع للأسئلة ويضيّق أكثر
    session.guessStreak = 0;
    session.questionsSinceGuessReset = 0;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm guess' });
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
    res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
