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

function makeSystemPrompt(language = 'ar') {
  return `You are an intelligent guessing engine similar to Akinator.

CRITICAL RULES:
- Ask only ONE short yes/no question at a time.
- Allowed answers are: yes, no, maybe, dont_know.
- Focus on high-information questions that quickly eliminate many possibilities.
- Prioritize famous global and Arab real people.

SMART STRATEGY:
- First 3 questions: broad classification only (gender, real person, field).
- Next questions: narrow the category using traits only (actor, athlete, singer, politician, scientist, fictional, alive, nationality, etc).
- Ask only YES/NO questions about general traits and attributes.
- NEVER mention, suggest, or ask about any person's name during the question phase.
- NEVER ask questions like: "Is it Michael Jackson?" or "Is it [name]?"
- During the question phase, do not show candidate names, examples, or suggestions.
- Stay in question mode for at least 7 questions.
- Only after question 7, if confidence is high enough, make ONE guess.
- Never ask more than 8 questions without making a guess.

IF GUESS IS REJECTED:
- If the user says "no" to a guess, do NOT immediately guess another name.
- Return to question mode.
- Ask more trait-based yes/no questions.
- Do not repeat rejected guesses.
- Gather more information before making the next guess.

LANGUAGE:
- If language is 'ar', all questions and guesses must be in Arabic only.
- If language is 'en', all questions and guesses must be in English only.

IMPORTANT:
- Do not repeat questions.
- Do not ask vague or useless questions.
- Be decisive and confident.
- Output STRICT JSON only.
- For questions, output only:
{"type":"question","text":"..."}
- For guesses, output only:
{"type":"guess","name":"...","confidence":0.7}`;
}

function sessionMessages(session) {
  const transcript = session.turns.length
    ? session.turns
        .map((t, index) => `Q${index + 1}: ${t.question}\nA${index + 1}: ${t.answer}`)
        .join('\n')
    : 'No questions asked yet.';

  const rejected = session.rejectedGuesses.length
    ? `Rejected guesses: ${session.rejectedGuesses.join(', ')}`
    : 'Rejected guesses: none';

  return `${transcript}\n${rejected}`;
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

function safeFallbackQuestion(language, count = 0) {
  const ar = [
    'هل هذه الشخصية حقيقية؟',
    'هل هذه الشخصية رجل؟',
    'هل هذه الشخصية مشهورة عالمياً؟',
    'هل تعمل هذه الشخصية في الفن؟',
    'هل هذه الشخصية على قيد الحياة؟',
    'هل هذه الشخصية عربية؟',
    'هل تعمل هذه الشخصية في الغناء؟',
    'هل تعمل هذه الشخصية في التمثيل؟'
  ];

  const en = [
    'Is this person real?',
    'Is this person male?',
    'Is this person globally famous?',
    'Does this person work in entertainment?',
    'Is this person alive?',
    'Is this person Arab?',
    'Does this person work in singing?',
    'Does this person work in acting?'
  ];

  const list = language === 'ar' ? ar : en;
  return { type: 'question', text: list[Math.min(count, list.length - 1)] };
}

function sanitizeEngineResult(result, session) {
  if (!result || typeof result !== 'object') {
    return safeFallbackQuestion(session.language, session.turns.length);
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();
    const confidence = Number(result.confidence || 0);

    if (!name) {
      return safeFallbackQuestion(session.language, session.turns.length);
    }

    if (session.rejectedGuesses.includes(name)) {
      return safeFallbackQuestion(session.language, session.turns.length);
    }

    return {
      type: 'guess',
      name,
      confidence: Number.isFinite(confidence) ? confidence : 0.5
    };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text) {
      return safeFallbackQuestion(session.language, session.turns.length);
    }

    return { type: 'question', text };
  }

  return safeFallbackQuestion(session.language, session.turns.length);
}

async function askEngine(session) {
  if (!openai) {
    if (session.turns.length < 7) {
      return safeFallbackQuestion(session.language, session.turns.length);
    }

    return {
      type: 'guess',
      name: session.language === 'ar' ? 'كاظم الساهر' : 'Kadim Al Sahir',
      confidence: 0.4
    };
  }

  const forceQuestion =
    session.turns.length < 7 ||
    (session.lastGuessRejected === true && session.turns.length < 9);

  const extraRule = forceQuestion
    ? session.language === 'ar'
      ? '\nImportant override: اسأل سؤالاً فقط الآن ولا تقم بأي تخمين.'
      : '\nImportant override: Ask a question only now and do not make any guess.'
    : '';

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
${sessionMessages(session)}

Question count: ${session.turns.length}
Rejected guess count: ${session.rejectedGuesses.length}${extraRule}

Generate the next best ${forceQuestion ? 'question' : 'question or guess'} in the specified language.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEngineResult(parsed, session);
  } catch {
    return safeFallbackQuestion(session.language, session.turns.length);
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
      lastGuessRejected: false
    };

    sessions.set(sessionId, session);

    const result = await askEngine(session);
    res.json({ sessionId, ...result });
  } catch (error) {
    console.error('start error:', error);
    res.status(500).json({
      error: 'Failed to start game',
      detail: error?.message || 'Unknown error'
    });
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

    session.lastGuessRejected = false;

    const result = await askEngine(session);
    res.json(result);
  } catch (error) {
    console.error('answer error:', error);
    res.status(500).json({
      error: 'Failed to answer question',
      detail: error?.message || 'Unknown error'
    });
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

    if (guessName) {
      session.rejectedGuesses.push(String(guessName));
    }

    session.lastGuessRejected = true;

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('guess-confirm error:', error);
    res.status(500).json({
      error: 'Failed to confirm guess',
      detail: error?.message || 'Unknown error'
    });
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
    console.error('wiki error:', error);
    res.status(500).json({
      error: 'Failed to fetch wiki',
      detail: error?.message || 'Unknown error'
    });
  }
});

app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
