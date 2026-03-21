import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

// 1. إعدادات البيئة
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 2. التحقق من مفتاح OpenAI
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// مخزن الجلسات (في الذاكرة)
const sessions = new Map();

// 3. ثوابت اللعبة الصارمة
const MIN_QUESTIONS = 7;           // لن يخمن أبداً قبل السؤال السابع
const MAX_QUESTIONS_LIMIT = 25;    // حد أقصى للأسئلة
const AFTER_FAIL_WAIT = 3;        // كم سؤال يسأل بعد التخمين الخاطئ

/* ============================================================
   التعليمات البرمجية للذكاء الاصطناعي (System Prompt)
   ============================================================ */
function getSystemPrompt(session) {
  const turnCount = session.turns.length;
  // شرط السماح بالتخمين: أن يتجاوز الحد الأدنى ولم يرفض تخمين قريبًا
  const canGuess = turnCount >= MIN_QUESTIONS && session.questionsSinceLastRejectedGuess >= AFTER_FAIL_WAIT;

  return `
You are a highly intelligent character-guessing AI.
Current Status:
- Language: ${session.language === 'ar' ? 'Arabic' : 'English'}
- Turn Number: ${turnCount}
- Can you Guess? ${canGuess ? 'YES' : 'NO, ONLY ASK QUESTIONS'}
- Previously Rejected Names: [${session.rejectedGuesses.join(', ')}]

RULES:
1. If you are in QUESTION mode: Ask a short, strategic Yes/No question. NEVER mention names.
2. If you are in GUESS mode: Provide the name of the character you are confident about.
3. NEVER guess any name from the "Rejected Names" list.
4. If the user says 'No' to a guess, you must go back to asking questions for at least ${AFTER_FAIL_WAIT} more turns.
5. RESPONSE FORMAT: You must ALWAYS respond in strict JSON format like this:
   For a question: {"type": "question", "text": "Is the character real?"}
   For a guess: {"type": "guess", "name": "Lionel Messi", "confidence": 0.95}
`;
}

/* ============================================================
   محرك معالجة الطلبات
   ============================================================ */
async function processAiTurn(session) {
  if (!openai) {
    return { type: 'question', text: "API Key is missing!" };
  }

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: getSystemPrompt(session) },
        { role: "user", content: `Here is the history of our game so far: ${JSON.stringify(session.turns)}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3 // درجة منخفضة لضمان الدقة وعدم الهلوسة
    });

    let aiResult = JSON.parse(response.choices[0].message.content);

    // حماية إضافية: إذا حاول الـ AI التخمين قبل السؤال السابع، نجبره على سؤال افتراضي
    if (session.turns.length < MIN_QUESTIONS && aiResult.type === 'guess') {
      return { 
        type: 'question', 
        text: session.language === 'ar' ? "هل الشخصية حقيقية وليست خيالية؟" : "Is the character a real person?" 
      };
    }

    return aiResult;
  } catch (error) {
    console.error("OpenAI Error:", error);
    return { 
      type: 'question', 
      text: session.language === 'ar' ? "حدث خطأ، هل يمكننا المتابعة؟" : "An error occurred, can we continue?" 
    };
  }
}

/* ============================================================
   المسارات (API Endpoints)
   ============================================================ */

// 1. بدء لعبة جديدة
app.post('/api/game/start', async (req, res) => {
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    language: req.body.language || 'ar',
    turns: [],
    rejectedGuesses: [],
    questionsSinceLastRejectedGuess: 10 // لكي يبدأ وهو مستعد
  };
  
  sessions.set(sessionId, session);
  const result = await processAiTurn(session);
  res.json({ sessionId, ...result });
});

// 2. إرسال إجابة (نعم، لا، لا أعلم...)
app.post('/api/game/answer', async (req, res) => {
  const { sessionId, question, answer } = req.body;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Session expired" });

  // إضافة السؤال وإجابة المستخدم للسجل
  session.turns.push({ question, answer });
  session.questionsSinceLastRejectedGuess++;

  const result = await processAiTurn(session);
  res.json(result);
});

// 3. تأكيد التخمين (هل هو فلان؟)
app.post('/api/game/guess-confirm', async (req, res) => {
  const { sessionId, correct, guessName } = req.body;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Session expired" });

  if (correct) {
    // إذا فاز الذكاء الاصطناعي
    return res.json({ 
      type: 'revealed', 
      message: session.language === 'ar' ? `رائع! لقد عرفت أنها ${guessName}` : `Great! I knew it was ${guessName}` 
    });
  } else {
    // إذا كان التخمين خاطئاً
    session.rejectedGuesses.push(guessName);
    session.questionsSinceLastRejectedGuess = 0; // تصفير العداد لإجباره على الأسئلة

    const result = await processAiTurn(session);
    res.json(result);
  }
});

// 4. فحص الحالة
app.get('/api/health', (req, res) => {
  res.json({ status: "running", openai: !!openai });
});

// تشغيل السيرفر
app.listen(port, () => {
  console.log(`
  ✅ Game Server is running!
  🚀 Port: ${port}
  🤖 Model: ${model}
  -----------------------------------
  `);
});
