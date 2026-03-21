import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

dotenv.config();
const app = express();
app.use(cors(), express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map();

// إعدادات التحكم بالعقل (Strict Control)
const START_GUESSING_AFTER = 8; // يبدأ التخمين فقط بعد السؤال الثامن
const QUESTIONS_AFTER_REJECTION = 4; // إذا أخطأ، يسأل 4 أسئلة إضافية إجبارياً

function generateSystemPrompt(session) {
    const turns = session.turns.length;
    // شرط التخمين: يجب أن يتجاوز العدد المطلوب + أن يكون قد سأل بما يكفي بعد آخر رفض
    const isAllowedToGuess = turns >= START_GUESSING_AFTER && 
                             session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTION;

    return `
You are the world's smartest character-guessing engine.
CORE RULES:
1. Current Turn: ${turns}. 
2. Mode: ${isAllowedToGuess ? 'You may GUESS if 100% sure.' : 'STRICT QUESTION MODE. No names allowed.'}
3. Forbidden Names (Already rejected): [${session.rejectedGuesses.join(', ')}].
4. Question Rules: Max 5 words. Yes/No format only. NEVER mention any specific person or character name in a question.
5. Guessing Rules: Only guess if confidence > 0.9.

Response Format (JSON only):
{
  "type": "question",
  "text": "Short question here"
} 
OR 
{
  "type": "guess",
  "name": "Full Name",
  "confidence": 0.95
}`;
}

async function askAI(session) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: generateSystemPrompt(session) },
                { role: "user", content: `History:\n${session.turns.map(t => `Q:${t.question} A:${t.answer}`).join('\n')}\nTask: Next JSON.` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1 // تقليل العشوائية لأقصى حد
        });

        let result = JSON.parse(response.choices[0].message.content);

        // حماية برمجية (Hard-Coded Protection)
        const turnCount = session.turns.length;
        const waitingAfterReject = session.questionsSinceLastRejectedGuess < QUESTIONS_AFTER_REJECTION;

        if (result.type === 'guess') {
            // إذا حاول التخمين قبل السؤال 8 أو قبل انتهاء فترة الانتظار بعد الرفض
            if (turnCount < START_GUESSING_AFTER || waitingAfterReject) {
                // نجبره على تحويل التخمين لسؤال استراتيجي
                return { type: "question", text: session.language === 'ar' ? "هل الشخصية حقيقية؟" : "Is it a real person?" };
            }
            // إذا خمن اسم تم رفضه سابقاً
            if (session.rejectedGuesses.includes(result.name)) {
                return { type: "question", text: session.language === 'ar' ? "هل الشخصية مشهورة حالياً؟" : "Is the person currently famous?" };
            }
        }
        return result;
    } catch (e) {
        return { type: "question", text: "هل الشخصية ذكر؟" };
    }
}

// --- API Routes ---

app.post('/api/game/start', async (req, res) => {
    const sessionId = crypto.randomUUID();
    const session = {
        id: sessionId,
        language: req.body.language || 'ar',
        turns: [],
        rejectedGuesses: [],
        questionsSinceLastRejectedGuess: 10
    };
    sessions.set(sessionId, session);
    res.json({ sessionId, ...(await askAI(session)) });
});

app.post('/api/game/answer', async (req, res) => {
    const { sessionId, question, answer } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).send();

    session.turns.push({ question, answer });
    session.questionsSinceLastRejectedGuess++;
    
    res.json(await askAI(session));
});

app.post('/api/game/guess-confirm', async (req, res) => {
    const { sessionId, correct, guessName } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).send();

    if (correct) {
        res.json({ type: 'win', name: guessName });
    } else {
        session.rejectedGuesses.push(guessName);
        session.questionsSinceLastRejectedGuess = 0; // تصفير العداد لإجباره على 4 أسئلة جديدة
        res.json(await askAI(session));
    }
});

app.listen(3001, () => console.log("Logic Server Updated & Smart!"));
