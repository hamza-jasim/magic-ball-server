"use strict";

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// 🔴 مهم: تأكد عندك API KEY بالـ ENV
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = "gpt-4o-mini";

// 🧠 Prompt بسيط
const SYSTEM_PROMPT = `
You are an AI like Akinator.

Rules:
- Ask ONLY one yes/no question
- No explanations
- After some questions say:
My guess: [name]
`;

// 🟢 اختبار السيرفر
app.get("/", (req, res) => {
  res.send("Server is working ✅");
});

// 🟢 health
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// 🟢 start
app.post("/api/start", (req, res) => {
  res.json({
    messages: [],
    text: "Is the person real?",
    isGuess: false
  });
});

// 🟢 answer
app.post("/api/answer", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages) {
      return res.status(400).json({ error: "messages required" });
    }

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ],
    });

    const text = response.choices[0]?.message?.content || "";
    const isGuess = text.includes("My guess:");

    res.json({
      text,
      isGuess
    });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ error: "AI failed" });
  }
});

// 🔴 مهم جداً ل Railway
const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
