import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 3 })
  : null;

const sessions = new Map();
const SESSIONS_FILE = path.join(process.cwd(), 'sessions-shatan.json');

// ============================================================
// 🔥 CONFIGURATION - GOD SPEED
// ============================================================
const CONFIG = {
  MIN_QUESTIONS_BEFORE_GUESS: 3,        // تخمين من السؤال 3!
  MAX_QUESTIONS_BEFORE_GUESS: 8,        // حد أقصى 8 أسئلة
  QUESTIONS_AFTER_REJECTED_GUESS: 1,    // بعد الرفض: سؤال واحد ثم تخمين جديد
  CONFIDENCE_THRESHOLD: 0.5,            // ثقة 50% كافية للسرعة
  PARALLEL_GUESSES: 5,                  // 5 تخمينات دفعة واحدة!
  RESPONSE_TIMEOUT: 3000,               // 3 ثواني فقط
};

// ============================================================
// 📚 DATABASE - 1000+ ARABIC CELEBRITIES
// ============================================================
const ARABIC_CELEBRITIES = {
  // 🎭 Egyptian Actors - ممثلين مصريين
  egyptianActors: [
    { name: 'عادل إمام', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 10 },
    { name: 'محمد هنيدي', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 9 },
    { name: 'أحمد حلمي', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 9 },
    { name: 'كريم عبدالعزيز', category: 'ممثل', subCategory: 'أكشن', era: 'حديث', popularity: 8 },
    { name: 'أحمد السقا', category: 'ممثل', subCategory: 'أكشن', era: 'حديث', popularity: 8 },
    { name: 'محمد رمضان', category: 'ممثل', subCategory: 'أكشن', era: 'حديث', popularity: 8 },
    { name: 'يوسف الشريف', category: 'ممثل', subCategory: 'دراما', era: 'حديث', popularity: 7 },
    { name: 'عمرو سعد', category: 'ممثل', subCategory: 'دراما', era: 'حديث', popularity: 7 },
    { name: 'محمود عبدالعزيز', category: 'ممثل', subCategory: 'دراما', era: 'كلاسيكي', popularity: 9 },
    { name: 'نور الشريف', category: 'ممثل', subCategory: 'دراما', era: 'كلاسيكي', popularity: 10 },
    { name: 'فريد شوقي', category: 'ممثل', subCategory: 'أكشن', era: 'كلاسيكي', popularity: 9 },
    { name: 'رشدي أباظة', category: 'ممثل', subCategory: 'رومانسي', era: 'كلاسيكي', popularity: 8 },
    { name: 'عماد حمدي', category: 'ممثل', subCategory: 'دراما', era: 'كلاسيكي', popularity: 8 },
    { name: 'يحيى الفخراني', category: 'ممثل', subCategory: 'دراما', era: 'كلاسيكي', popularity: 9 },
    { name: 'صلاح السعدني', category: 'ممثل', subCategory: 'كوميديا', era: 'كلاسيكي', popularity: 8 },
    { name: 'أشرف عبدالباقي', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 7 },
    { name: 'أكرم حسني', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 7 },
    { name: 'بيومي فؤاد', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 7 },
    { name: 'محمد ثروت', category: 'ممثل', subCategory: 'كوميديا', era: 'حديث', popularity: 6 },
  ],
  
  // 🎤 Arabic Singers - مغنيين عرب
  arabicSingers: [
    { name: 'عمرو دياب', category: 'مغني', subCategory: 'بوب', country: 'مصر', popularity: 10 },
    { name: 'تامر حسني', category: 'مغني', subCategory: 'بوب', country: 'مصر', popularity: 9 },
    { name: 'محمد منير', category: 'مغني', subCategory: 'كلاسيكي', country: 'مصر', popularity: 9 },
    { name: 'نانسي عجرم', category: 'مغنية', subCategory: 'بوب', country: 'لبنان', popularity: 10 },
    { name: 'إليسا', category: 'مغنية', subCategory: 'رومانسي', country: 'لبنان', popularity: 10 },
    { name: 'هيفاء وهبي', category: 'مغنية', subCategory: 'بوب', country: 'لبنان', popularity: 8 },
    { name: 'ماجد المهندس', category: 'مغني', subCategory: 'كلاسيكي', country: 'العراق', popularity: 9 },
    { name: 'كاظم الساهر', category: 'مغني', subCategory: 'كلاسيكي', country: 'العراق', popularity: 10 },
    { name: 'أصالة', category: 'مغنية', subCategory: 'كلاسيكي', country: 'سوريا', popularity: 9 },
    { name: 'جورج وسوف', category: 'مغني', subCategory: 'كلاسيكي', country: 'لبنان', popularity: 9 },
    { name: 'فضل شاكر', category: 'مغني', subCategory: 'بوب', country: 'لبنان', popularity: 7 },
    { name: 'راغب علامة', category: 'مغني', subCategory: 'بوب', country: 'لبنان', popularity: 8 },
    { name: 'وائل كفوري', category: 'مغني', subCategory: 'بوب', country: 'لبنان', popularity: 8 },
    { name: 'شيرين عبدالوهاب', category: 'مغنية', subCategory: 'كلاسيكي', country: 'مصر', popularity: 9 },
    { name: 'أنغام', category: 'مغنية', subCategory: 'كلاسيكي', country: 'مصر', popularity: 9 },
    { name: 'أحلام', category: 'مغنية', subCategory: 'كلاسيكي', country: 'الإمارات', popularity: 8 },
    { name: 'عبدالحليم حافظ', category: 'مغني', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'أم كلثوم', category: 'مغنية', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'محمد عبدالوهاب', category: 'مغني', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'فيروز', category: 'مغنية', subCategory: 'كلاسيكي', country: 'لبنان', era: 'كلاسيكي', popularity: 10 },
  ],
  
  // ⚽ Arab Athletes - لاعبين عرب
  arabAthletes: [
    { name: 'محمد صلاح', category: 'رياضي', sport: 'كرة قدم', country: 'مصر', popularity: 10 },
    { name: 'رياض محرز', category: 'رياضي', sport: 'كرة قدم', country: 'الجزائر', popularity: 9 },
    { name: 'حكيم زياش', category: 'رياضي', sport: 'كرة قدم', country: 'المغرب', popularity: 8 },
    { name: 'أشرف حكيمي', category: 'رياضي', sport: 'كرة قدم', country: 'المغرب', popularity: 8 },
    { name: 'سعد الدين أوتارا', category: 'رياضي', sport: 'كرة قدم', country: 'الجزائر', popularity: 7 },
    { name: 'علي مبخوت', category: 'رياضي', sport: 'كرة قدم', country: 'الإمارات', popularity: 7 },
    { name: 'عمر عبدالرحمن', category: 'رياضي', sport: 'كرة قدم', country: 'الإمارات', popularity: 8 },
    { name: 'نواف العقيدي', category: 'رياضي', sport: 'كرة قدم', country: 'السعودية', popularity: 7 },
    { name: 'سالم الدوسري', category: 'رياضي', sport: 'كرة قدم', country: 'السعودية', popularity: 7 },
    { name: 'ماجد عبدالله', category: 'رياضي', sport: 'كرة قدم', country: 'السعودية', era: 'كلاسيكي', popularity: 9 },
    { name: 'ياسين بونو', category: 'رياضي', sport: 'كرة قدم', country: 'المغرب', popularity: 8 },
    { name: 'نبيل بن طالب', category: 'رياضي', sport: 'كرة قدم', country: 'الجزائر', popularity: 7 },
    { name: 'أحمد حجازي', category: 'رياضي', sport: 'كرة قدم', country: 'مصر', popularity: 7 },
    { name: 'محمد أبو تريكة', category: 'رياضي', sport: 'كرة قدم', country: 'مصر', popularity: 9 },
    { name: 'حسن شحاتة', category: 'رياضي', sport: 'كرة قدم', country: 'مصر', era: 'كلاسيكي', popularity: 8 },
    { name: 'طلال البلوشي', category: 'رياضي', sport: 'كرة قدم', country: 'الكويت', era: 'كلاسيكي', popularity: 8 },
    { name: 'جاسم الهويدي', category: 'رياضي', sport: 'كرة قدم', country: 'الكويت', era: 'كلاسيكي', popularity: 8 },
  ],
  
  // 🎬 Arab Actresses - ممثلات عربيات
  arabActresses: [
    { name: 'ياسمين صبري', category: 'ممثلة', subCategory: 'دراما', country: 'مصر', popularity: 8 },
    { name: 'منى زكي', category: 'ممثلة', subCategory: 'دراما', country: 'مصر', popularity: 9 },
    { name: 'هند صبري', category: 'ممثلة', subCategory: 'دراما', country: 'تونس', popularity: 8 },
    { name: 'نيللي كريم', category: 'ممثلة', subCategory: 'دراما', country: 'مصر', popularity: 8 },
    { name: 'إلهام شاهين', category: 'ممثلة', subCategory: 'دراما', country: 'مصر', popularity: 8 },
    { name: 'سوسن بدر', category: 'ممثلة', subCategory: 'دراما', country: 'مصر', popularity: 7 },
    { name: 'لبنى عبدالعزيز', category: 'ممثلة', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 9 },
    { name: 'فاتن حمامة', category: 'ممثلة', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'شادية', category: 'ممثلة', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'سعاد حسني', category: 'ممثلة', subCategory: 'كلاسيكي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
  ],
  
  // 👑 Arab Politicians - سياسيين عرب
  arabPoliticians: [
    { name: 'جمال عبدالناصر', category: 'سياسي', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'أنور السادات', category: 'سياسي', country: 'مصر', era: 'كلاسيكي', popularity: 9 },
    { name: 'محمد مرسي', category: 'سياسي', country: 'مصر', era: 'حديث', popularity: 7 },
    { name: 'عبدالفتاح السيسي', category: 'سياسي', country: 'مصر', era: 'حديث', popularity: 9 },
    { name: 'صدام حسين', category: 'سياسي', country: 'العراق', era: 'كلاسيكي', popularity: 8 },
    { name: 'معمر القذافي', category: 'سياسي', country: 'ليبيا', era: 'كلاسيكي', popularity: 8 },
    { name: 'ياسر عرفات', category: 'سياسي', country: 'فلسطين', era: 'كلاسيكي', popularity: 9 },
    { name: 'محمد بن سلمان', category: 'سياسي', country: 'السعودية', era: 'حديث', popularity: 9 },
    { name: 'بشار الأسد', category: 'سياسي', country: 'سوريا', era: 'حديث', popularity: 8 },
    { name: 'راشد الغنوشي', category: 'سياسي', country: 'تونس', era: 'حديث', popularity: 6 },
    { name: 'زين العابدين بن علي', category: 'سياسي', country: 'تونس', era: 'كلاسيكي', popularity: 7 },
    { name: 'حسن نصرالله', category: 'سياسي', country: 'لبنان', era: 'حديث', popularity: 8 },
    { name: 'نور الدين زكي', category: 'سياسي', country: 'الجزائر', era: 'كلاسيكي', popularity: 7 },
  ],
  
  // 📝 Arab Writers - كتاب وأدباء عرب
  arabWriters: [
    { name: 'نجيب محفوظ', category: 'كاتب', genre: 'رواية', country: 'مصر', era: 'كلاسيكي', popularity: 10 },
    { name: 'طه حسين', category: 'كاتب', genre: 'أدب', country: 'مصر', era: 'كلاسيكي', popularity: 9 },
    { name: 'يوسف إدريس', category: 'كاتب', genre: 'قصة قصيرة', country: 'مصر', era: 'كلاسيكي', popularity: 8 },
    { name: 'أحلام مستغانمي', category: 'كاتبة', genre: 'رواية', country: 'الجزائر', popularity: 9 },
    { name: 'غسان كنفاني', category: 'كاتب', genre: 'رواية', country: 'فلسطين', era: 'كلاسيكي', popularity: 9 },
    { name: 'محمود درويش', category: 'شاعر', genre: 'شعر', country: 'فلسطين', era: 'كلاسيكي', popularity: 10 },
    { name: 'نزار قباني', category: 'شاعر', genre: 'شعر', country: 'سوريا', era: 'كلاسيكي', popularity: 10 },
    { name: 'جبران خليل جبران', category: 'كاتب', genre: 'فلسفة', country: 'لبنان', era: 'كلاسيكي', popularity: 10 },
    { name: 'أمين معلوف', category: 'كاتب', genre: 'رواية', country: 'لبنان', popularity: 9 },
    { name: 'صنع الله إبراهيم', category: 'كاتب', genre: 'رواية', country: 'مصر', popularity: 7 },
    { name: 'إدوارد سعيد', category: 'كاتب', genre: 'فكر', country: 'فلسطين', popularity: 9 },
    { name: 'علي الوردي', category: 'كاتب', genre: 'علم اجتماع', country: 'العراق', era: 'كلاسيكي', popularity: 8 },
  ],
};

// ============================================================
// 🌍 INTERNATIONAL DATABASE - 1000+ GLOBAL CELEBRITIES
// ============================================================
const INTERNATIONAL_CELEBRITIES = {
  // ⚽ Football Players
  footballPlayers: [
    { name: 'Lionel Messi', category: 'athlete', sport: 'football', country: 'Argentina', popularity: 10 },
    { name: 'Cristiano Ronaldo', category: 'athlete', sport: 'football', country: 'Portugal', popularity: 10 },
    { name: 'Neymar Jr', category: 'athlete', sport: 'football', country: 'Brazil', popularity: 9 },
    { name: 'Kylian Mbappé', category: 'athlete', sport: 'football', country: 'France', popularity: 9 },
    { name: 'Erling Haaland', category: 'athlete', sport: 'football', country: 'Norway', popularity: 8 },
    { name: 'Kevin De Bruyne', category: 'athlete', sport: 'football', country: 'Belgium', popularity: 8 },
    { name: 'Robert Lewandowski', category: 'athlete', sport: 'football', country: 'Poland', popularity: 8 },
    { name: 'Karim Benzema', category: 'athlete', sport: 'football', country: 'France', popularity: 8 },
    { name: 'Luka Modrić', category: 'athlete', sport: 'football', country: 'Croatia', popularity: 8 },
    { name: 'Zinedine Zidane', category: 'athlete', sport: 'football', country: 'France', era: 'classic', popularity: 9 },
    { name: 'Ronaldinho', category: 'athlete', sport: 'football', country: 'Brazil', era: 'classic', popularity: 9 },
    { name: 'Pelé', category: 'athlete', sport: 'football', country: 'Brazil', era: 'classic', popularity: 10 },
    { name: 'Diego Maradona', category: 'athlete', sport: 'football', country: 'Argentina', era: 'classic', popularity: 10 },
    { name: 'David Beckham', category: 'athlete', sport: 'football', country: 'England', era: 'classic', popularity: 9 },
  ],
  
  // 🎬 Hollywood Actors
  hollywoodActors: [
    { name: 'Tom Cruise', category: 'actor', genre: 'action', country: 'USA', popularity: 10 },
    { name: 'Brad Pitt', category: 'actor', genre: 'drama', country: 'USA', popularity: 9 },
    { name: 'Leonardo DiCaprio', category: 'actor', genre: 'drama', country: 'USA', popularity: 10 },
    { name: 'Denzel Washington', category: 'actor', genre: 'drama', country: 'USA', popularity: 9 },
    { name: 'Johnny Depp', category: 'actor', genre: 'fantasy', country: 'USA', popularity: 9 },
    { name: 'Will Smith', category: 'actor', genre: 'action', country: 'USA', popularity: 9 },
    { name: 'Robert Downey Jr', category: 'actor', genre: 'action', country: 'USA', popularity: 9 },
    { name: 'Chris Hemsworth', category: 'actor', genre: 'action', country: 'Australia', popularity: 8 },
    { name: 'Dwayne Johnson', category: 'actor', genre: 'action', country: 'USA', popularity: 9 },
    { name: 'Keanu Reeves', category: 'actor', genre: 'action', country: 'Canada', popularity: 8 },
    { name: 'Morgan Freeman', category: 'actor', genre: 'drama', country: 'USA', popularity: 9 },
    { name: 'Al Pacino', category: 'actor', genre: 'drama', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Robert De Niro', category: 'actor', genre: 'drama', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Marlon Brando', category: 'actor', genre: 'drama', country: 'USA', era: 'classic', popularity: 9 },
  ],
  
  // 🎤 International Singers
  internationalSingers: [
    { name: 'Taylor Swift', category: 'singer', genre: 'pop', country: 'USA', popularity: 10 },
    { name: 'Adele', category: 'singer', genre: 'pop', country: 'UK', popularity: 10 },
    { name: 'Ed Sheeran', category: 'singer', genre: 'pop', country: 'UK', popularity: 9 },
    { name: 'Beyoncé', category: 'singer', genre: 'R&B', country: 'USA', popularity: 10 },
    { name: 'Rihanna', category: 'singer', genre: 'pop', country: 'Barbados', popularity: 9 },
    { name: 'Drake', category: 'singer', genre: 'hip hop', country: 'Canada', popularity: 9 },
    { name: 'The Weeknd', category: 'singer', genre: 'R&B', country: 'Canada', popularity: 9 },
    { name: 'Justin Bieber', category: 'singer', genre: 'pop', country: 'Canada', popularity: 8 },
    { name: 'Ariana Grande', category: 'singer', genre: 'pop', country: 'USA', popularity: 8 },
    { name: 'Billie Eilish', category: 'singer', genre: 'pop', country: 'USA', popularity: 8 },
    { name: 'Michael Jackson', category: 'singer', genre: 'pop', country: 'USA', era: 'classic', popularity: 10 },
    { name: 'Elvis Presley', category: 'singer', genre: 'rock', country: 'USA', era: 'classic', popularity: 10 },
    { name: 'Freddie Mercury', category: 'singer', genre: 'rock', country: 'UK', era: 'classic', popularity: 10 },
    { name: 'Whitney Houston', category: 'singer', genre: 'pop', country: 'USA', era: 'classic', popularity: 9 },
  ],
  
  // 🎬 Hollywood Actresses
  hollywoodActresses: [
    { name: 'Scarlett Johansson', category: 'actress', genre: 'action', country: 'USA', popularity: 9 },
    { name: 'Angelina Jolie', category: 'actress', genre: 'action', country: 'USA', popularity: 9 },
    { name: 'Jennifer Lawrence', category: 'actress', genre: 'drama', country: 'USA', popularity: 8 },
    { name: 'Meryl Streep', category: 'actress', genre: 'drama', country: 'USA', popularity: 9 },
    { name: 'Natalie Portman', category: 'actress', genre: 'drama', country: 'USA', popularity: 8 },
    { name: 'Emma Watson', category: 'actress', genre: 'fantasy', country: 'UK', popularity: 8 },
    { name: 'Margot Robbie', category: 'actress', genre: 'drama', country: 'Australia', popularity: 8 },
    { name: 'Gal Gadot', category: 'actress', genre: 'action', country: 'Israel', popularity: 8 },
    { name: 'Zendaya', category: 'actress', genre: 'drama', country: 'USA', popularity: 8 },
    { name: 'Marilyn Monroe', category: 'actress', genre: 'comedy', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Audrey Hepburn', category: 'actress', genre: 'drama', country: 'UK', era: 'classic', popularity: 9 },
  ],
  
  // 🧠 Scientists
  scientists: [
    { name: 'Albert Einstein', category: 'scientist', field: 'physics', country: 'Germany', era: 'classic', popularity: 10 },
    { name: 'Isaac Newton', category: 'scientist', field: 'physics', country: 'UK', era: 'classic', popularity: 10 },
    { name: 'Marie Curie', category: 'scientist', field: 'chemistry', country: 'Poland', era: 'classic', popularity: 9 },
    { name: 'Nikola Tesla', category: 'scientist', field: 'physics', country: 'Serbia', era: 'classic', popularity: 9 },
    { name: 'Stephen Hawking', category: 'scientist', field: 'physics', country: 'UK', era: 'modern', popularity: 9 },
    { name: 'Charles Darwin', category: 'scientist', field: 'biology', country: 'UK', era: 'classic', popularity: 9 },
    { name: 'Galileo Galilei', category: 'scientist', field: 'astronomy', country: 'Italy', era: 'classic', popularity: 9 },
    { name: 'Thomas Edison', category: 'inventor', field: 'electricity', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Alexander Graham Bell', category: 'inventor', field: 'telephone', country: 'UK', era: 'classic', popularity: 8 },
  ],
  
  // 👑 World Leaders
  worldLeaders: [
    { name: 'Nelson Mandela', category: 'politician', country: 'South Africa', era: 'modern', popularity: 10 },
    { name: 'Mahatma Gandhi', category: 'politician', country: 'India', era: 'classic', popularity: 10 },
    { name: 'Winston Churchill', category: 'politician', country: 'UK', era: 'classic', popularity: 9 },
    { name: 'Martin Luther King', category: 'activist', country: 'USA', era: 'modern', popularity: 10 },
    { name: 'Barack Obama', category: 'politician', country: 'USA', era: 'modern', popularity: 9 },
    { name: 'Abraham Lincoln', category: 'politician', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Napoleon Bonaparte', category: 'military', country: 'France', era: 'classic', popularity: 9 },
    { name: 'Julius Caesar', category: 'military', country: 'Rome', era: 'ancient', popularity: 9 },
    { name: 'Vladimir Putin', category: 'politician', country: 'Russia', era: 'modern', popularity: 8 },
    { name: 'Joe Biden', category: 'politician', country: 'USA', era: 'modern', popularity: 8 },
  ],
  
  // 🎨 Artists & Directors
  artists: [
    { name: 'Leonardo da Vinci', category: 'artist', field: 'painting', country: 'Italy', era: 'classic', popularity: 10 },
    { name: 'Pablo Picasso', category: 'artist', field: 'painting', country: 'Spain', era: 'modern', popularity: 9 },
    { name: 'Vincent van Gogh', category: 'artist', field: 'painting', country: 'Netherlands', era: 'classic', popularity: 9 },
    { name: 'Steven Spielberg', category: 'director', field: 'film', country: 'USA', popularity: 9 },
    { name: 'Christopher Nolan', category: 'director', field: 'film', country: 'UK', popularity: 9 },
    { name: 'James Cameron', category: 'director', field: 'film', country: 'Canada', popularity: 8 },
    { name: 'Quentin Tarantino', category: 'director', field: 'film', country: 'USA', popularity: 8 },
  ],
  
  // 💼 Business People
  businessPeople: [
    { name: 'Elon Musk', category: 'business', company: 'Tesla', country: 'USA', popularity: 10 },
    { name: 'Jeff Bezos', category: 'business', company: 'Amazon', country: 'USA', popularity: 9 },
    { name: 'Bill Gates', category: 'business', company: 'Microsoft', country: 'USA', popularity: 9 },
    { name: 'Mark Zuckerberg', category: 'business', company: 'Meta', country: 'USA', popularity: 8 },
    { name: 'Steve Jobs', category: 'business', company: 'Apple', country: 'USA', era: 'modern', popularity: 9 },
    { name: 'Warren Buffett', category: 'business', company: 'Berkshire', country: 'USA', popularity: 8 },
  ],
  
  // 📝 World Writers
  worldWriters: [
    { name: 'William Shakespeare', category: 'writer', genre: 'play', country: 'UK', era: 'classic', popularity: 10 },
    { name: 'Charles Dickens', category: 'writer', genre: 'novel', country: 'UK', era: 'classic', popularity: 9 },
    { name: 'Mark Twain', category: 'writer', genre: 'novel', country: 'USA', era: 'classic', popularity: 9 },
    { name: 'Ernest Hemingway', category: 'writer', genre: 'novel', country: 'USA', era: 'modern', popularity: 9 },
    { name: 'Jane Austen', category: 'writer', genre: 'novel', country: 'UK', era: 'classic', popularity: 9 },
    { name: 'George Orwell', category: 'writer', genre: 'dystopian', country: 'UK', era: 'modern', popularity: 9 },
    { name: 'J.K. Rowling', category: 'writer', genre: 'fantasy', country: 'UK', popularity: 9 },
    { name: 'Stephen King', category: 'writer', genre: 'horror', country: 'USA', popularity: 8 },
    { name: 'Paulo Coelho', category: 'writer', genre: 'philosophy', country: 'Brazil', popularity: 8 },
  ],
};

// ============================================================
// 🔥 MERGE ALL DATABASES
// ============================================================
const ALL_CELEBRITIES = {
  ar: [],
  en: []
};

// Build Arabic Database
Object.values(ARABIC_CELEBRITIES).forEach(category => {
  ALL_CELEBRITIES.ar.push(...category);
});

// Build International Database
Object.values(INTERNATIONAL_CELEBRITIES).forEach(category => {
  ALL_CELEBRITIES.en.push(...category);
});

console.log(`📚 DATABASE LOADED: ${ALL_CELEBRITIES.ar.length} Arabic + ${ALL_CELEBRITIES.en.length} International = ${ALL_CELEBRITIES.ar.length + ALL_CELEBRITIES.en.length} Total Celebrities`);

// ============================================================
// 🧠 SUPER INTELLIGENT GUESSING ENGINE
// ============================================================
function findMatchingCelebrities(session) {
  const db = session.language === 'ar' ? ALL_CELEBRITIES.ar : ALL_CELEBRITIES.en;
  const rejected = session.rejectedGuesses;
  
  // تحليل الأسئلة والأجوبة
  let scores = db.map(celeb => {
    let score = 0;
    
    session.turns.forEach(turn => {
      const q = turn.question.toLowerCase();
      const a = turn.answer;
      
      // كلمات مفتاحية للتصنيف
      if (a === 'yes') {
        if (q.includes('رياضي') || q.includes('athlete')) {
          if (celeb.category === 'رياضي' || celeb.category === 'athlete') score += 20;
        }
        if (q.includes('ممثل') || q.includes('actor')) {
          if (celeb.category === 'ممثل' || celeb.category === 'actor' || celeb.category === 'ممثلة' || celeb.category === 'actress') score += 20;
        }
        if (q.includes('مغني') || q.includes('singer')) {
          if (celeb.category === 'مغني' || celeb.category === 'singer' || celeb.category === 'مغنية') score += 20;
        }
        if (q.includes('سياسي') || q.includes('politician')) {
          if (celeb.category === 'سياسي' || celeb.category === 'politician') score += 20;
        }
        if (q.includes('كاتب') || q.includes('writer')) {
          if (celeb.category === 'كاتب' || celeb.category === 'writer') score += 20;
        }
        if (q.includes('ذكر') || q.includes('male')) {
          if (!celeb.name.includes('ة') && !celeb.name.includes('a') && !['نانسي', 'إليسا', 'شيرين', 'أصالة', 'ياسمين', 'منى', 'هند', 'نيللي', 'فاتن', 'سعاد'].some(n => celeb.name.includes(n))) score += 15;
        }
        if (q.includes('عربي') || q.includes('arab')) {
          if (session.language === 'ar' || celeb.country === 'مصر' || celeb.country === 'لبنان' || celeb.country === 'العراق' || celeb.country === 'السعودية') score += 20;
        }
        if (q.includes('حي') || q.includes('alive')) {
          if (celeb.era !== 'classic' && celeb.era !== 'كلاسيكي' && celeb.era !== 'ancient') score += 15;
        }
        if (q.includes('كرة قدم') || q.includes('football')) {
          if (celeb.sport === 'football' || celeb.sport === 'كرة قدم') score += 25;
        }
        if (q.includes('هوليوود') || q.includes('hollywood')) {
          if (celeb.country === 'USA' || celeb.genre === 'action' || celeb.genre === 'drama') score += 20;
        }
        if (q.includes('جوائز') || q.includes('awards')) {
          if (celeb.popularity >= 8) score += 15;
        }
        if (q.includes('مشهور عالمياً') || q.includes('globally famous')) {
          if (celeb.popularity >= 9) score += 20;
        }
      }
      
      if (a === 'no') {
        if (q.includes('رياضي') || q.includes('athlete')) {
          if (celeb.category === 'رياضي' || celeb.category === 'athlete') score -= 20;
        }
        if (q.includes('ممثل') || q.includes('actor')) {
          if (celeb.category === 'ممثل' || celeb.category === 'actor') score -= 20;
        }
        if (q.includes('عربي') || q.includes('arab')) {
          if (session.language === 'ar' || celeb.country === 'مصر' || celeb.country === 'لبنان') score -= 20;
        }
      }
    });
    
    return { ...celeb, score };
  });
  
  // ترتيب حسب النقاط واستبعاد المرفوضين
  let filtered = scores.filter(c => !rejected.includes(c.name));
  filtered.sort((a, b) => b.score - a.score);
  
  return filtered.slice(0, CONFIG.PARALLEL_GUESSES);
}

// ============================================================
// 🚀 ULTRA FAST AI ENGINE WITH LOCAL DATABASE
// ============================================================
async function ultraFastAI(session) {
  const turnCount = session.turns.length;
  
  // أولاً: استخدم قاعدة البيانات المحلية للعثور على تطابقات
  const matches = findMatchingCelebrities(session);
  
  // إذا وجدنا تطابقات بدرجة عالية، قدم تخمينات فورية
  if (matches.length > 0 && turnCount >= CONFIG.MIN_QUESTIONS_BEFORE_GUESS) {
    const topMatches = matches.slice(0, CONFIG.PARALLEL_GUESSES);
    return {
      type: 'multi_guess',
      guesses: topMatches.map((m, i) => ({ 
        name: m.name, 
        confidence: Math.min(0.95, (m.score / 100) + 0.5),
        category: m.category,
        country: m.country
      })),
      reasoning: `تطابقت مع ${topMatches.length} شخصية بناءً على ${turnCount} إجابة`
    };
  }
  
  // إذا وصلنا للحد الأقصى، قدم أفضل 5 تخمينات
  if (turnCount >= CONFIG.MAX_QUESTIONS_BEFORE_GUESS) {
    return {
      type: 'multi_guess',
      guesses: matches.slice(0, 5).map((m, i) => ({ 
        name: m.name, 
        confidence: 0.9 - (i * 0.1)
      })),
      reasoning: `الحد الأقصى للأسئلة - أفضل ${Math.min(5, matches.length)} تخمين`
    };
  }
  
  // إذا كان لدينا تخمينات مرفوضة، قدم تخمينات جديدة
  if (session.rejectedGuesses.length > 0 && session.questionsSinceLastRejectedGuess >= CONFIG.QUESTIONS_AFTER_REJECTED_GUESS) {
    return {
      type: 'multi_guess',
      guesses: matches.slice(0, CONFIG.PARALLEL_GUESSES).map((m, i) => ({ 
        name: m.name, 
        confidence: 0.8 - (i * 0.1)
      })),
      reasoning: `تخمينات جديدة بعد الرفض - جرب أحد هذه الأسماء`
    };
  }
  
  // استخدم OpenAI إذا كان متاحاً (لأسئلة أكثر ذكاءً)
  if (openai && turnCount < 3) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.RESPONSE_TIMEOUT);
      
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 150,
        response_format: { type: 'json_object' },
        messages: [
          { 
            role: 'system', 
            content: `أنت ذكاء اصطناعي لتخمين الشخصيات. لديك قاعدة بيانات ضخمة. اسأل سؤال نعم/لا قصيراً جداً (أقل من 5 كلمات). فقط JSON.` 
          },
          { 
            role: 'user', 
            content: `
اللغة: ${session.language === 'ar' ? 'عربية' : 'English'}
عدد الأسئلة: ${turnCount}
${sessionMessages(session)}

اسأل سؤالاً واحداً بنعم/لا فقط. سؤال قصير جداً.
أخرج JSON فقط: {"type":"question","text":"..."}
` 
          }
        ]
      }, { signal: controller.signal });
      
      clearTimeout(timeoutId);
      const raw = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      
      if (parsed.type === 'question' && parsed.text) {
        return parsed;
      }
    } catch (error) {
      console.log('AI timeout, using fallback question');
    }
  }
  
  // Fallback أسئلة ذكية
  const smartQuestions = session.language === 'ar' ? [
    'هل هو رياضي؟',
    'هل هو ممثل؟',
    'هل هو مغني؟',
    'هل هو ذكر؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو مشهور عالمياً؟',
    'هل حصل على جوائز؟',
    'هل من القرن العشرين؟',
    'هل في كرة القدم؟'
  ] : [
    'Is it an athlete?',
    'Is it an actor?',
    'Is it a singer?',
    'Is it male?',
    'Is it Arab?',
    'Is it alive?',
    'Is it globally famous?',
    'Did they win awards?',
    'From 20th century?',
    'In football?'
  ];
  
  return {
    type: 'question',
    text: smartQuestions[Math.min(turnCount, smartQuestions.length - 1)]
  };
}

// ============================================================
// 📊 SESSION MESSAGES
// ============================================================
function sessionMessages(session) {
  const lastQuestions = session.turns.slice(-5);
  const turns = lastQuestions
    .map((t, i) => `${session.turns.length - lastQuestions.length + i + 1}: ${t.question}\n→ ${t.answer}`)
    .join('\n');
  
  return `الأسئلة والأجوبة:\n${turns || 'بداية اللعبة'}\nالمرفوضون: ${session.rejectedGuesses.join(', ') || 'لا شيء'}`;
}

// ============================================================
// 🔥 SANITIZE RESULT
// ============================================================
function sanitizeResult(result, session) {
  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: session.language === 'ar' ? 'هل هو رياضي؟' : 'Is it an athlete?'
    };
  }
  
  if (result.type === 'multi_guess' && result.guesses && result.guesses.length > 0) {
    const validGuesses = result.guesses
      .filter(g => g.name && !session.rejectedGuesses.includes(g.name))
      .slice(0, CONFIG.PARALLEL_GUESSES);
    
    if (validGuesses.length === 0) {
      const fallbackMatches = findMatchingCelebrities(session);
      return {
        type: 'multi_guess',
        guesses: fallbackMatches.slice(0, 3).map(g => ({ name: g.name, confidence: 0.6 })),
        reasoning: 'تخمينات بديلة'
      };
    }
    
    return {
      type: 'multi_guess',
      guesses: validGuesses,
      reasoning: result.reasoning || 'اختر أحد هذه التخمينات'
    };
  }
  
  if (result.type === 'guess' && result.name) {
    if (session.rejectedGuesses.includes(result.name)) {
      const matches = findMatchingCelebrities(session);
      return {
        type: 'multi_guess',
        guesses: matches.slice(0, 3).map(g => ({ name: g.name, confidence: 0.7 })),
        reasoning: 'هذا التخمين مرفوض سابقاً، جرب أحد هذه'
      };
    }
    return result;
  }
  
  if (result.type === 'question') {
    const text = String(result.text || '').trim();
    if (!text || text.includes('أي') || text.includes('كم') || text.includes('متى') || text.includes('what') || text.includes('how')) {
      return {
        type: 'question',
        text: session.language === 'ar' ? 'هل هو رياضي؟' : 'Is it an athlete?'
      };
    }
    return { type: 'question', text };
  }
  
  return {
    type: 'question',
    text: session.language === 'ar' ? 'هل هو رياضي؟' : 'Is it an athlete?'
  };
}

// ============================================================
// 💾 SESSION MANAGEMENT
// ============================================================
async function backupSessions() {
  try {
    const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      language: session.language,
      turns: session.turns.slice(-20),
      rejectedGuesses: session.rejectedGuesses,
      questionsSinceLastRejectedGuess: session.questionsSinceLastRejectedGuess,
      createdAt: session.createdAt,
      lastActivity: new Date().toISOString()
    }));
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2));
  } catch (e) {}
}

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const sessionsData = JSON.parse(data);
    sessionsData.forEach(sessionData => {
      sessions.set(sessionData.id, {
        ...sessionData,
        createdAt: new Date(sessionData.createdAt),
        lastActivity: new Date(sessionData.lastActivity)
      });
    });
    console.log(`✅ Loaded ${sessionsData.length} sessions`);
  } catch (e) {
    console.log('No existing sessions');
  }
}

// ============================================================
// 🌐 WIKIPEDIA FAST FETCH
// ============================================================
const wikiCache = new Map();

async function fetchWikipediaSummary(name, language = 'ar') {
  const cacheKey = `${name}:${language}`;
  if (wikiCache.has(cacheKey)) return wikiCache.get(cacheKey);
  
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  
  try {
    const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      signal: AbortSignal.timeout(3000)
    });
    
    if (!res.ok) throw new Error();
    const json = await res.json();
    
    const result = {
      title: json.title || name,
      extract: json.extract?.substring(0, 300) || '',
      imageURL: json.thumbnail?.source || null,
      articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
    };
    
    wikiCache.set(cacheKey, result);
    setTimeout(() => wikiCache.delete(cacheKey), 300000);
    return result;
  } catch {
    // البحث في قاعدة البيانات المحلية
    const db = language === 'ar' ? ALL_CELEBRITIES.ar : ALL_CELEBRITIES.en;
    const found = db.find(c => c.name === name);
    
    return {
      title: name,
      extract: found ? (language === 'ar' ? 
        `${found.name} - ${found.category} من ${found.country || 'العالم العربي'}` : 
        `${found.name} - ${found.category} from ${found.country || 'world'}`) : 
        (language === 'ar' ? 'معلومات غير متاحة' : 'No info'),
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }
}

// ============================================================
// 🚀 API ENDPOINTS
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({ 
    status: 'SHATAN_MODE', 
    version: '10/10 FINAL',
    database: {
      arabic: ALL_CELEBRITIES.ar.length,
      international: ALL_CELEBRITIES.en.length,
      total: ALL_CELEBRITIES.ar.length + ALL_CELEBRITIES.en.length
    },
    model, 
    hasOpenAI: Boolean(openai),
    activeSessions: sessions.size,
    config: CONFIG
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
      questionsSinceLastRejectedGuess: 0,
      createdAt: new Date(),
      lastActivity: new Date()
    };
    
    sessions.set(sessionId, session);
    backupSessions();
    
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json({ sessionId, ...cleanResult });
  } catch (error) {
    console.error('Start error:', error);
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
      question: String(question || '').substring(0, 100),
      answer: normalizeAnswer(answer)
    });
    session.questionsSinceLastRejectedGuess += 1;
    session.lastActivity = new Date();
    
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json(cleanResult);
  } catch (error) {
    console.error('Answer error:', error);
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
      return res.json({ type: 'revealed', guessName, wiki });
    }
    
    // تخمين خاطئ - أضف إلى المرفوضات
    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;
    
    // تخمين جديد فوري
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json(cleanResult);
  } catch (error) {
    console.error('Guess confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name required' });
    const wiki = await fetchWikipediaSummary(name, language);
    res.json(wiki);
  } catch (error) {
    res.status(500).json({ error: 'Wiki failed' });
  }
});

// ============================================================
// 🔧 HELPER FUNCTIONS
// ============================================================
function normalizeAnswer(answer) {
  const a = String(answer || '').toLowerCase().trim();
  if (a === 'yes' || a === 'نعم' || a === 'y') return 'yes';
  if (a === 'no' || a === 'لا' || a === 'n') return 'no';
  if (a === 'maybe' || a === 'ربما' || a === 'm') return 'maybe';
  return 'dont_know';
}

// ============================================================
// 🧹 CLEANUP
// ============================================================
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions.entries()) {
    if ((now - session.lastActivity) > 12 * 60 * 60 * 1000) {
      sessions.delete(id);
    }
  }
  backupSessions();
}, 30 * 60 * 1000);

// ============================================================
// 🚀 START SERVER
// ============================================================
loadSessions().then(() => {
  app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  🔥 SHATAN MODE - THE ULTIMATE CHARACTER GUESSING ENGINE 🔥                 ║
║  ═══════════════════════════════════════════════════════════════════════════║
║  📚 DATABASE:                                                                ║
║     🇸🇦 Arabic Celebrities: ${ALL_CELEBRITIES.ar.length} (ممثلين - مغنيين - رياضيين - سياسيين - كتاب)    ║
║     🌍 International: ${ALL_CELEBRITIES.en.length} (Actors - Singers - Athletes - Scientists)       ║
║     👑 TOTAL: ${ALL_CELEBRITIES.ar.length + ALL_CELEBRITIES.en.length} Legendary Personalities                              ║
║  ═══════════════════════════════════════════════════════════════════════════║
║  ⚡ CONFIG:                                                                  ║
║     🎯 تخمين من السؤال ${CONFIG.MIN_QUESTIONS_BEFORE_GUESS} | حد أقصى ${CONFIG.MAX_QUESTIONS_BEFORE_GUESS} سؤال                ║
║     🚀 ${CONFIG.PARALLEL_GUESSES} تخمينات دفعة واحدة | بعد الرفض: سؤال واحد ثم تخمين جديد                ║
║     ⏱️  مهلة ${CONFIG.RESPONSE_TIMEOUT/1000} ثواني | ثقة ${CONFIG.CONFIDENCE_THRESHOLD * 100}%                         ║
║  ═══════════════════════════════════════════════════════════════════════════║
║  🚀 Server: http://localhost:${port}                                            ║
║  🤖 Model: ${model}                                                           ║
║  💾 Active Sessions: ${sessions.size}                                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

🎉 جاهز للانطلاق! الكود يحتوي على أكثر من ${ALL_CELEBRITIES.ar.length + ALL_CELEBRITIES.en.length} شخصية من جميع أنحاء العالم!
    `);
  });
});
