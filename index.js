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
const MAX_QUESTIONS_BEFORE_GUESS = 10;
const QUESTIONS_AFTER_REJECTED_GUESS = 2;

function makeSystemPrompt(language = 'ar') {
  return `You are an elite character guessing engine.

PRIMARY GOAL:
Identify the character in 7 to 10 questions.

STRICT RULES:
- Ask only ONE yes/no question at a time.
- Allowed answers are: yes, no, maybe, dont_know.
- Return STRICT JSON only.
- Never explain your reasoning.
- Never add extra commentary.
- Never output markdown.

QUESTION STYLE:
- Questions must be VERY SHORT.
- Arabic questions should usually be 2 to 6 words.
- English questions should usually be 2 to 8 words.
- Prefer direct, high-information questions only.
- Avoid weak, vague, decorative, or repetitive questions.

STRATEGY:
- Questions 1-3: broad classification only.
  Use: real/fictional, gender, field.
- Questions 4-6: narrow quickly.
  Use: actor, singer, athlete, politician, scientist, Arab, alive, era, nationality.
- Questions 7-10: move strongly toward the answer.

NAME RESTRICTION:
- During question mode, NEVER mention any person name.
- NEVER ask a name-based question.
- Names are allowed only when making a guess.

GUESSING RULES:
- Never guess before question 7.
- You should try to guess between question 7 and question 10.
- Never continue beyond question 10 without making one guess.
- Only ONE guess at a time.

IF A GUESS IS REJECTED:
- Do NOT make another guess immediately.
- Return to question mode.
- Ask at least 2 more strong trait-based questions before the next guess.
- Do not repeat rejected guesses.

OUTPUT FORMAT:

Question:
{"type":"question","text":"..."}

Guess:
{"type":"guess","name":"...","confidence":0.82}`;
}

function sessionMessages(session) {
  const transcript = session.turns
    .map((t, index) => `Q${index + 1}: ${t.question}\nA${index + 1}: ${t.answer}`)
    .join('\n');

  const rejected = session.rejectedGuesses.length
    ? `Rejected guesses: ${session.rejectedGuesses.join(', ')}`
    : 'Rejected guesses: none';

  const afterRejectInfo = `Questions since last rejected guess: ${session.questionsSinceLastRejectedGuess}`;

  return `${transcript}\n${rejected}\n${afterRejectInfo}`;
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

function shortFallbackQuestion(language = 'ar', turnCount = 0) {
  const ar = [
    'هل هو رجل؟',
    'هل هو حقيقي؟',
    'هل هو ممثل؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو مغني؟',
    'هل هو رياضي؟',
    'هل هو سياسي؟',
    'هل هو مشهور جداً؟',
    'هل هو من الفن؟'
  ];

  const en = [
    'Is it male?',
    'Is it real?',
    'Is it an actor?',
    'Is it Arab?',
    'Is it alive?',
    'Is it a singer?',
    'Is it an athlete?',
    'Is it a politician?',
    'Is it very famous?',
    'Is it in entertainment?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

function fallbackGuess(language = 'ar') {
  return language === 'ar'
    ? { type: 'guess', name: 'محمد صلاح', confidence: 0.35 }
    : { type: 'guess', name: 'Mohamed Salah', confidence: 0.35 };
}

function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 6 : words.length > 8;
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();

  if (!lower) return false;

  return (
    lower.startsWith('is it ') ||
    lower.startsWith('could it be ') ||
    lower.startsWith('is this ') ||
    lower.includes('مايكل') ||
    lower.includes('michael') ||
    lower.includes('محمد') ||
    lower.includes('tom ') ||
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

    if (isQuestionTooLong(text, session.language)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (looksLikeNameQuestion(text)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    return {
      type: 'question',
      text
    };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();

    if (!name) {
      return fallbackGuess(session.language);
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

async function forceGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Make your single best guess now.
Return STRICT JSON only.

Format:
{"type":"guess","name":"...","confidence":0.82}`
      },
      {
        role: 'user',
        content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

Make the best single guess now.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEngineResult(parsed, session);
  } catch {
    return fallbackGuess(session.language);
  }
}

async function askEngine(session) {
  const turnCount = session.turns.length;
  const canGuessNow =
    turnCount >= MIN_QUESTIONS_BEFORE_GUESS &&
    session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS;

  if (!openai) {
    const fallbackQuestions = session.language === 'ar'
      ? [
          'هل هو رجل؟',
          'هل هو حقيقي؟',
          'هل هو ممثل؟',
          'هل هو عربي؟',
          'هل هو حي؟',
          'هل هو مغني؟',
          'هل هو رياضي؟'
        ]
      : [
          'Is it male?',
          'Is it real?',
          'Is it an actor?',
          'Is it Arab?',
          'Is it alive?',
          'Is it a singer?',
          'Is it an athlete?'
        ];

    if (turnCount < MIN_QUESTIONS_BEFORE_GUESS) {
      return {
        type: 'question',
        text: fallbackQuestions[Math.min(turnCount, fallbackQuestions.length - 1)]
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

Extra server rules:
- Ask very short questions only.
- Never guess before question ${MIN_QUESTIONS_BEFORE_GUESS}.
- Guess between question ${MIN_QUESTIONS_BEFORE_GUESS} and question ${MAX_QUESTIONS_BEFORE_GUESS}.
- If a guess was rejected, ask at least ${QUESTIONS_AFTER_REJECTED_GUESS} more questions before guessing again.
- Never mention a name in question mode.
- Prefer strong narrowing questions only.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const result = sanitizeEngineResult(parsed, session);

    if (result.type === 'guess' && !canGuessNow) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount)
      };
    }

    if (result.type === 'question' && turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return result;
  } catch {
    if (turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return session.language === 'ar'
      ? { type: 'question', text: shortFallbackQuestion('ar', turnCount) }
      : { type: 'question', text: shortFallbackQuestion('en', turnCount) };
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
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
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
      questionsSinceLastRejectedGuess: QUESTIONS_AFTER_REJECTED_GUESS
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

    session.questionsSinceLastRejectedGuess += 1;

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

      return res.json({
        type: 'revealed',
        guessName,
        wiki
      });
    }

    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;

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
