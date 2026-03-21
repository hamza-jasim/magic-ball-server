import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3001;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sessions = new Map();

const MIN_Q = 7;
const MAX_Q = 10;
const AFTER_REJECT_Q = 2;

function makeSystemPrompt(lang) {
  return `You are a world-class guessing AI.

Goal:
Guess the character in 7–10 questions.

Rules:
- Ask ONLY one yes/no question.
- Questions must be VERY SHORT.
- Arabic: max 5 words.
- English: max 7 words.
- No explanations.

Strategy:
1-3: basic (gender, real, category)
4-6: narrow fast
7-10: move to answer

STRICT:
- NEVER mention names in questions
- ONLY guess after question 7
- MAX 10 questions
- ONE guess only

If guess is wrong:
- DO NOT guess again immediately
- Ask at least 2 new questions

Output JSON ONLY:

{"type":"question","text":"..."}
or
{"type":"guess","name":"...","confidence":0.8}`;
}

function normalize(a) {
  return ['yes','no','maybe','dont_know'].includes(a) ? a : 'dont_know';
}

function shortQ(lang, i) {
  const ar = ['هل هو رجل؟','هل هو حقيقي؟','هل هو ممثل؟','هل هو عربي؟','هل هو حي؟'];
  const en = ['Is it male?','Is it real?','Is it actor?','Is it Arab?','Is it alive?'];
  return (lang==='ar'?ar:en)[i % 5];
}

function tooLong(t, lang) {
  const w = t.split(' ');
  return lang==='ar' ? w.length>6 : w.length>8;
}

function invalidQ(t) {
  return t.toLowerCase().includes('is it ') && t.split(' ').length>4;
}

function sanitize(r, session) {
  if (!r || !r.type) {
    return { type:'question', text: shortQ(session.language, session.turns.length) };
  }

  if (r.type === 'question') {
    if (!r.text || tooLong(r.text, session.language) || invalidQ(r.text)) {
      return { type:'question', text: shortQ(session.language, session.turns.length) };
    }
  }

  if (r.type === 'guess' && session.turns.length < MIN_Q) {
    return { type:'question', text: shortQ(session.language, session.turns.length) };
  }

  return r;
}

async function ask(session) {
  const count = session.turns.length;

  const canGuess =
    count >= MIN_Q &&
    session.afterReject >= AFTER_REJECT_Q;

  const res = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role:'system', content: makeSystemPrompt(session.language) },
      {
        role:'user',
        content:`Language: ${session.language==='ar'?'Arabic':'English'}

History:
${session.turns.map((t,i)=>`Q${i+1}:${t.q}\nA:${t.a}`).join('\n')}

Rules:
- Short questions only
- No names in questions
- Guess only after ${MIN_Q}
- Must guess before ${MAX_Q}`
      }
    ]
  });

  let raw = res.choices[0]?.message?.content || '{}';

  try {
    let parsed = JSON.parse(raw);
    let clean = sanitize(parsed, session);

    if (clean.type === 'guess' && !canGuess) {
      return { type:'question', text: shortQ(session.language, count) };
    }

    if (count >= MAX_Q && clean.type !== 'guess') {
      return {
        type:'guess',
        name: session.language==='ar' ? 'تخميني الحالي' : 'My guess',
        confidence: 0.5
      };
    }

    return clean;

  } catch {
    return { type:'question', text: shortQ(session.language, count) };
  }
}

async function wiki(name, lang) {
  const l = lang==='ar'?'ar':'en';
  const url = `https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
  const r = await fetch(url);

  if (!r.ok) return { title:name, extract:'No data' };

  const j = await r.json();
  return {
    title:j.title,
    extract:j.extract,
    image:j.thumbnail?.source
  };
}

app.get('/api/health', (req,res)=>{
  res.json({ ok:true });
});

app.post('/api/start', async (req,res)=>{
  const id = crypto.randomUUID();

  const session = {
    id,
    language: req.body?.language==='en'?'en':'ar',
    turns: [],
    rejected: [],
    afterReject: AFTER_REJECT_Q
  };

  sessions.set(id, session);

  const r = await ask(session);
  res.json({ sessionId:id, ...r });
});

app.post('/api/answer', async (req,res)=>{
  const { sessionId, question, answer } = req.body;
  const s = sessions.get(sessionId);

  if (!s) return res.status(404).json({error:'no session'});

  s.turns.push({ q:question, a:normalize(answer) });
  s.afterReject++;

  const r = await ask(s);
  res.json(r);
});

app.post('/api/confirm', async (req,res)=>{
  const { sessionId, guessName, correct } = req.body;
  const s = sessions.get(sessionId);

  if (!s) return res.status(404).json({error:'no session'});

  if (correct) {
    const w = await wiki(guessName, s.language);
    return res.json({ type:'done', guessName, wiki:w });
  }

  s.rejected.push(guessName);
  s.afterReject = 0;

  const r = await ask(s);
  res.json(r);
});

app.listen(port, ()=>{
  console.log('Server running on port', port);
});
