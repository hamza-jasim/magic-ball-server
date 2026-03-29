/**
 * Magic Ball — AI Character Guessing Game (Ultra-Smart Engine)
 *
 * Rules:
 *  • Minimum 10, maximum 15 questions before first guess
 *  • Up to 3 guesses per cycle
 *  • If all 3 guesses are wrong → ask 5–10 more smart questions in same domain → guess again
 *  • Static question banks guarantee zero repetition and zero drift
 *  • GPT used ONLY for final guess — never for questions unless bank exhausted
 *  • Smart shouldAsk() filter: no contradictory, redundant, or irrelevant questions
 *  • Domain locked the moment a broad category is confirmed
 *  • Sub-domain narrows further (footballer ≠ boxer ≠ swimmer ≠ basketballer)
 *  • Confidence scoring filters candidates before guessing
 *  • Session state fully explicit — no re-parsing of question text
 */

import express from 'express';
import cors    from 'cors';
import OpenAI  from 'openai';
import crypto  from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT  = Number(process.env.PORT  || 3001);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const openaiApiKey  = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const openaiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey, ...(openaiBaseUrl ? { baseURL: openaiBaseUrl } : {}) })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
//  GAME CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL_MIN  = 10;   // minimum questions before first guess
const INITIAL_MAX  = 15;   // maximum questions before forced guess
const FOLLOWUP_MIN = 5;    // minimum extra questions after failed guesses
const FOLLOWUP_MAX = 10;   // maximum extra questions
const MAX_GUESSES  = 3;    // max guess attempts per cycle
const SESSION_TTL  = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
//  QUESTION BANK — Static, ordered, curated for maximum information gain
// ─────────────────────────────────────────────────────────────────────────────
const Q = {

  // Phase 1: broad classification (shuffled each session for variety)
  broad: [
    { key:'real',            ar:'هل الشخصية حقيقية وليست خيالية؟',           en:'Is it a real person (not fictional)?' },
    { key:'alive',           ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
    { key:'male',            ar:'هل الشخصية من الجنس الذكوري؟',              en:'Is it male?' },
    { key:'famous_globally', ar:'هل الشخصية مشهورة عالمياً؟',               en:'Is the person world-famous?' },
    { key:'arab_world',      ar:'هل الشخصية من العالم العربي أو الشرق الأوسط؟', en:'Is the person from the Arab world or Middle East?' },
    { key:'born_20th',       ar:'هل الشخصية وُلدت في القرن العشرين (1900–2000)؟', en:'Was the person born in the 20th century (1900–2000)?' },
    { key:'athlete',         ar:'هل الشخصية رياضي/ة محترف/ة؟',              en:'Is it a professional athlete or sports player?' },
    { key:'entertainer',     ar:'هل الشخصية فنان/ة أو ممثل/ة أو مغني/ة؟',   en:'Is it an entertainer (actor, singer, artist)?' },
    { key:'politician',      ar:'هل الشخصية سياسي/ة أو رئيس/ة دولة؟',       en:'Is it a politician or head of state?' },
    { key:'scientist',       ar:'هل الشخصية عالم/ة أو مخترع/ة؟',            en:'Is it a scientist or inventor?' },
    { key:'business',        ar:'هل الشخصية رجل/إمرأة أعمال أو مؤسس/ة شركة؟', en:'Is it a famous business figure or company founder?' },
    { key:'royalty',         ar:'هل الشخصية ملكية (ملك/ملكة/أمير/أميرة)؟',  en:'Is it royalty (king/queen/prince/princess)?' },
    { key:'writer',          ar:'هل الشخصية كاتب/ة أو روائي/ة أو شاعر/ة؟',  en:'Is it a writer, novelist, or poet?' },
    { key:'historical',      ar:'هل الشخصية تاريخية قديمة (قبل عام 1900م)؟', en:'Is it an ancient historical figure (before 1900)?' },
    { key:'fictional',       ar:'هل الشخصية خيالية أو كرتونية أو من عالم التمثيل؟', en:'Is it a fictional or animated character?' },
  ],

  // Phase 2a: sport sub-domain detection
  athlete_sport: [
    { key:'sport_football',   ar:'هل تلعب الشخصية كرة القدم (فوتبول/سوكر)؟',  en:'Does the person play football/soccer?' },
    { key:'sport_basketball', ar:'هل تلعب الشخصية كرة السلة؟',                 en:'Does the person play basketball?' },
    { key:'sport_tennis',     ar:'هل تلعب الشخصية التنس؟',                     en:'Does the person play tennis?' },
    { key:'sport_boxing',     ar:'هل الشخصية ملاكم/ة محترف/ة؟',               en:'Is the person a professional boxer?' },
    { key:'sport_swimming',   ar:'هل الشخصية سباح/ة محترف/ة؟',                en:'Is the person a competitive swimmer?' },
    { key:'sport_athletics',  ar:'هل الشخصية عداء/ة أو رياضي/ة ألعاب قوى؟',  en:'Is the person a track & field athlete?' },
    { key:'sport_golf',       ar:'هل تلعب الشخصية الغولف؟',                   en:'Does the person play golf?' },
    { key:'sport_cycling',    ar:'هل الشخصية دراج/ة محترف/ة؟',               en:'Is the person a professional cyclist?' },
    { key:'sport_mma',        ar:'هل الشخصية مقاتل/ة في الفنون القتالية المختلطة؟', en:'Is the person an MMA/martial arts fighter?' },
    { key:'sport_other',      ar:'هل الشخصية رياضي/ة أولمبية في رياضة أخرى؟', en:'Is the person an Olympic athlete in another sport?' },
  ],

  // Phase 2b: entertainer sub-domain detection
  entertainer_type: [
    { key:'ent_actor',     ar:'هل الشخصية ممثل/ة في أفلام أو مسلسلات؟',     en:'Is the person an actor or actress?' },
    { key:'ent_singer',    ar:'هل الشخصية مغنٍ/مغنية أو فنان/ة موسيقي/ة؟',  en:'Is the person a singer or music artist?' },
    { key:'ent_director',  ar:'هل الشخصية مخرج/ة أفلام أو مسلسلات؟',        en:'Is the person a film/TV director?' },
    { key:'ent_comedian',  ar:'هل الشخصية كوميدي/ة أو ساخر/ة؟',             en:'Is the person a comedian?' },
    { key:'ent_presenter', ar:'هل الشخصية مقدم/ة برامج تلفزيونية؟',          en:'Is the person a TV presenter or host?' },
    { key:'ent_model',     ar:'هل الشخصية عارض/ة أزياء مشهور/ة؟',           en:'Is the person a famous model?' },
    { key:'ent_producer',  ar:'هل الشخصية منتج/ة أفلام أو موسيقى؟',         en:'Is the person a music or film producer?' },
  ],

  // ─── FOOTBALLER deep-dive ─────────────────────────────────────────────────
  footballer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                  en:'Is the person Arab?' },
    { key:'nat_s_american', ar:'هل الشخصية من أمريكا الجنوبية؟',             en:'Is the person South American?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                        en:'Is the person European?' },
    { key:'nat_african',    ar:'هل الشخصية أفريقية (غير عربية)؟',            en:'Is the person African (non-Arab)?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب كرة القدم حالياً؟',  en:'Is the person still playing football now?' },
    { key:'ach_ballondor',  ar:'هل الشخصية فازت بجائزة البالون دور؟',        en:"Did the person win the Ballon d'Or?" },
    { key:'ach_worldcup',   ar:'هل الشخصية فازت بكأس العالم لكرة القدم؟',   en:'Did the person win the FIFA World Cup?' },
    { key:'ach_ucl',        ar:'هل الشخصية فازت بدوري أبطال أوروبا (UEFA)؟', en:'Did the person win the UEFA Champions League?' },
    { key:'nat_portuguese', ar:'هل الشخصية برتغالية الجنسية؟',               en:'Is the person Portuguese?' },
    { key:'nat_argentine',  ar:'هل الشخصية أرجنتينية الجنسية؟',              en:'Is the person Argentine?' },
    { key:'nat_brazilian',  ar:'هل الشخصية برازيلية الجنسية؟',               en:'Is the person Brazilian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',                 en:'Is the person French?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية الجنسية؟',                en:'Is the person Spanish?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية (إنجليزية/اسكتلندية)؟', en:'Is the person British (English/Scottish)?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية الجنسية؟',                en:'Is the person German?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية الجنسية؟',                  en:'Is the person Egyptian?' },
    { key:'nat_moroccan',   ar:'هل الشخصية مغربية الجنسية؟',                 en:'Is the person Moroccan?' },
    { key:'nat_algerian',   ar:'هل الشخصية جزائرية الجنسية؟',                en:'Is the person Algerian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية الجنسية؟',                 en:'Is the person Saudi?' },
    { key:'nat_dutch',      ar:'هل الشخصية هولندية الجنسية؟',                en:'Is the person Dutch?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية الجنسية؟',                en:'Is the person Italian?' },
    { key:'nat_belgian',    ar:'هل الشخصية بلجيكية الجنسية؟',                en:'Is the person Belgian?' },
    { key:'nat_croatian',   ar:'هل الشخصية كرواتية الجنسية؟',                en:'Is the person Croatian?' },
    { key:'nat_senegalese', ar:'هل الشخصية سنغالية الجنسية؟',               en:'Is the person Senegalese?' },
    { key:'nat_cameroonian',ar:'هل الشخصية كاميرونية الجنسية؟',              en:'Is the person Cameroonian?' },
    { key:'nat_ivorian',    ar:'هل الشخصية من ساحل العاج؟',                  en:'Is the person from Ivory Coast?' },
    { key:'pos_striker',    ar:'هل الشخصية مهاجم/ة (فوروارد)؟',             en:'Is the person a striker/forward?' },
    { key:'pos_goalkeeper', ar:'هل الشخصية حارس/ة مرمى؟',                   en:'Is the person a goalkeeper?' },
    { key:'pos_midfielder', ar:'هل الشخصية لاعب/ة وسط ميدان؟',              en:'Is the person a midfielder?' },
    { key:'pos_defender',   ar:'هل الشخصية مدافع/ة؟',                       en:'Is the person a defender?' },
    { key:'club_real',      ar:'هل الشخصية لعبت لصالح ريال مدريد؟',         en:'Did the person play for Real Madrid?' },
    { key:'club_barca',     ar:'هل الشخصية لعبت لصالح برشلونة؟',            en:'Did the person play for Barcelona?' },
    { key:'club_manu',      ar:'هل الشخصية لعبت لصالح مانشستر يونايتد؟',    en:'Did the person play for Manchester United?' },
    { key:'club_liver',     ar:'هل الشخصية لعبت لصالح ليفربول؟',            en:'Did the person play for Liverpool?' },
    { key:'club_city',      ar:'هل الشخصية لعبت لصالح مانشستر سيتي؟',       en:'Did the person play for Manchester City?' },
    { key:'club_chelsea',   ar:'هل الشخصية لعبت لصالح تشيلسي؟',             en:'Did the person play for Chelsea?' },
    { key:'club_juve',      ar:'هل الشخصية لعبت لصالح يوفنتوس؟',            en:'Did the person play for Juventus?' },
    { key:'club_psg',       ar:'هل الشخصية لعبت لصالح باريس سان جيرمان؟',   en:'Did the person play for PSG?' },
    { key:'club_bayern',    ar:'هل الشخصية لعبت لصالح بايرن ميونيخ؟',       en:'Did the person play for Bayern Munich?' },
    { key:'club_alnassr',   ar:'هل الشخصية تلعب أو لعبت لصالح النصر السعودي؟', en:'Did/does the person play for Al-Nassr?' },
    { key:'club_atletico',  ar:'هل الشخصية لعبت لصالح أتلتيكو مدريد؟',      en:'Did the person play for Atlético Madrid?' },
    { key:'club_arsenal',   ar:'هل الشخصية لعبت لصالح أرسنال؟',             en:'Did the person play for Arsenal?' },
    { key:'club_inter',     ar:'هل الشخصية لعبت لصالح إنتر ميلان؟',         en:'Did the person play for Inter Milan?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في فترة التسعينيات؟',      en:'Did the person rise to fame in the 1990s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في فترة الألفينيات (2000s)؟', en:'Did the person rise to fame in the 2000s?' },
    { key:'era_10s',        ar:'هل الشخصية اشتهرت في العقد الثاني (2010s)؟', en:'Did the person rise to fame in the 2010s?' },
    { key:'era_20s',        ar:'هل الشخصية اشتهرت في العقد الثالث (2020s)؟', en:'Did the person rise to fame in the 2020s?' },
    { key:'ach_afcon',      ar:'هل الشخصية فازت ببطولة كأس أمم أفريقيا؟',   en:'Did the person win the Africa Cup of Nations?' },
    { key:'ach_euro',       ar:'هل الشخصية فازت ببطولة اليورو الأوروبي؟',    en:'Did the person win the UEFA European Championship?' },
    { key:'ach_copa',       ar:'هل الشخصية فازت بكأس كوبا أمريكا؟',         en:'Did the person win Copa America?' },
  ],

  // ─── BASKETBALLER deep-dive ───────────────────────────────────────────────
  basketballer: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية الجنسية؟',               en:'Is the person European?' },
    { key:'nat_african',    ar:'هل الشخصية أفريقية الأصل؟',                 en:'Is the person of African origin?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب كرة السلة حالياً؟', en:'Is the person still playing basketball?' },
    { key:'ach_nba_champ',  ar:'هل الشخصية فازت ببطولة NBA؟',              en:'Did the person win an NBA Championship?' },
    { key:'ach_mvp',        ar:'هل الشخصية فازت بجائزة أفضل لاعب (MVP)؟',  en:'Did the person win the MVP award?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟',  en:'Did the person win Olympic gold?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',          en:'Did the person rise to fame in the 90s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في الألفينيات؟',          en:'Did the person rise to fame in the 2000s?' },
    { key:'pos_guard',      ar:'هل الشخصية يلعب في مركز الحارس؟',          en:'Is the person a guard position player?' },
    { key:'pos_center',     ar:'هل الشخصية يلعب في مركز البيفوت؟',         en:'Is the person a center?' },
    { key:'pos_forward',    ar:'هل الشخصية يلعب في مركز المهاجم؟',         en:'Is the person a forward?' },
    { key:'nat_serbian',    ar:'هل الشخصية صربية الجنسية؟',                 en:'Is the person Serbian?' },
    { key:'nat_greek',      ar:'هل الشخصية يونانية الجنسية؟',               en:'Is the person Greek?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── TENNIS deep-dive ─────────────────────────────────────────────────────
  tennis: [
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية الجنسية؟',               en:'Is the person Spanish?' },
    { key:'nat_swiss',      ar:'هل الشخصية سويسرية الجنسية؟',               en:'Is the person Swiss?' },
    { key:'nat_serbian',    ar:'هل الشخصية صربية الجنسية؟',                 en:'Is the person Serbian?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية الجنسية؟',               en:'Is the person German?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية الجنسية؟',              en:'Is the person Australian?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية الجنسية؟',                 en:'Is the person Russian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_polish',     ar:'هل الشخصية بولندية الجنسية؟',               en:'Is the person Polish?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب التنس حالياً؟',     en:'Is the person still playing tennis?' },
    { key:'ach_grandslam',  ar:'هل الشخصية فازت بإحدى بطولات غراند سلام؟', en:'Did the person win a Grand Slam tournament?' },
    { key:'ach_wimbledon',  ar:'هل الشخصية فازت ببطولة ويمبلدون؟',         en:'Did the person win Wimbledon?' },
    { key:'ach_usopen',     ar:'هل الشخصية فازت بالبطولة الأمريكية المفتوحة؟', en:'Did the person win the US Open?' },
    { key:'ach_roland',     ar:'هل الشخصية فازت ببطولة رولان غاروس (الفرنسية)؟', en:'Did the person win Roland Garros (French Open)?' },
    { key:'ach_australia',  ar:'هل الشخصية فازت بالبطولة الأسترالية المفتوحة؟', en:'Did the person win the Australian Open?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── BOXER deep-dive ──────────────────────────────────────────────────────
  boxer: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_mexican',    ar:'هل الشخصية مكسيكية الجنسية؟',               en:'Is the person Mexican?' },
    { key:'nat_filipino',   ar:'هل الشخصية فلبينية الجنسية؟',               en:'Is the person Filipino?' },
    { key:'nat_kazakh',     ar:'هل الشخصية كازاخستانية الجنسية؟',           en:'Is the person Kazakh?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تتنافس في الملاكمة؟',   en:'Is the person still competing in boxing?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',          en:'Did the person rise to fame in the 90s?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟',  en:'Did the person win Olympic gold in boxing?' },
    { key:'ach_undisputed', ar:'هل الشخصية حازت على ألقاب عالمية متعددة في نفس الوقت؟', en:'Did the person hold multiple world titles simultaneously?' },
    { key:'weight_heavy',   ar:'هل الشخصية في فئة الوزن الثقيل؟',          en:'Is the person a heavyweight boxer?' },
    { key:'weight_middle',  ar:'هل الشخصية في فئة الوزن المتوسط؟',         en:'Is the person a middleweight boxer?' },
    { key:'weight_light',   ar:'هل الشخصية في فئة الأوزان الخفيفة؟',       en:'Is the person in a lighter weight class?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── SWIMMER deep-dive ────────────────────────────────────────────────────
  swimmer: [
    { key:'nat_american',    ar:'هل الشخصية أمريكية الجنسية؟',              en:'Is the person American?' },
    { key:'nat_australian',  ar:'هل الشخصية أسترالية الجنسية؟',             en:'Is the person Australian?' },
    { key:'nat_european',    ar:'هل الشخصية أوروبية الجنسية؟',              en:'Is the person European?' },
    { key:'ach_olympics',    ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟', en:'Did the person win Olympic gold in swimming?' },
    { key:'ach_multi_gold',  ar:'هل الشخصية فازت بأكثر من 5 ذهبيات أولمبية؟', en:'Did the person win more than 5 Olympic gold medals?' },
    { key:'ach_world_rec',   ar:'هل الشخصية تحمل رقماً قياسياً عالمياً في السباحة؟', en:'Does the person hold a world record in swimming?' },
    { key:'era_active',      ar:'هل الشخصية لا تزال تتنافس في السباحة؟',   en:'Is the person still competing in swimming?' },
    { key:'style_freestyle', ar:'هل تسبح الشخصية سباحة حرة (كراول)؟',     en:'Does the person primarily swim freestyle?' },
    { key:'style_butterfly', ar:'هل تسبح الشخصية سباحة الفراشة؟',          en:'Does the person primarily swim butterfly?' },
    { key:'alive',           ar:'هل الشخصية لا تزال على قيد الحياة؟',       en:'Is the person still alive?' },
  ],

  // ─── TRACK & FIELD deep-dive ─────────────────────────────────────────────
  athlete_athletics: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_jamaican',   ar:'هل الشخصية جامايكية الجنسية؟',              en:'Is the person Jamaican?' },
    { key:'nat_kenyan',     ar:'هل الشخصية كينية الجنسية؟',                 en:'Is the person Kenyan?' },
    { key:'nat_ethiopian',  ar:'هل الشخصية إثيوبية الجنسية؟',               en:'Is the person Ethiopian?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'event_sprint',   ar:'هل الشخصية متخصصة في العدو السريع (100م أو 200م)؟', en:'Is the person a sprinter (100m/200m)?' },
    { key:'event_marathon', ar:'هل الشخصية متخصصة في الجري طويل المسافة أو الماراثون؟', en:'Is the person a long-distance runner or marathoner?' },
    { key:'event_jump',     ar:'هل الشخصية متخصصة في الوثب (العالي أو الطويل)؟', en:'Is the person a jumper (high/long jump)?' },
    { key:'event_throws',   ar:'هل الشخصية متخصصة في رياضات الرمي (رمح/قرص)؟', en:'Is the person a thrower (javelin/discus/shot put)?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟',  en:'Did the person win Olympic gold in athletics?' },
    { key:'ach_world_rec',  ar:'هل الشخصية تحمل رقماً قياسياً عالمياً؟',   en:'Does the person hold a world record?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تتنافس حالياً؟',         en:'Is the person still competing?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── ACTOR deep-dive ──────────────────────────────────────────────────────
  actor: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية الجنسية؟',                 en:'Is the person Indian?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية الجنسية؟',              en:'Is the person Australian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية الجنسية؟',               en:'Is the person Italian?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية الجنسية؟',               en:'Is the person Spanish?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية الجنسية؟',                 en:'Is the person Egyptian?' },
    { key:'nat_lebanese',   ar:'هل الشخصية لبنانية الجنسية؟',               en:'Is the person Lebanese?' },
    { key:'nat_syrian',     ar:'هل الشخصية سورية الجنسية؟',                 en:'Is the person Syrian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية الجنسية؟',                en:'Is the person Saudi?' },
    { key:'ach_oscar',      ar:'هل الشخصية فازت بجائزة الأوسكار؟',         en:'Did the person win an Oscar?' },
    { key:'ach_emmy',       ar:'هل الشخصية فازت بجائزة الإيمي التلفزيونية؟', en:'Did the person win an Emmy?' },
    { key:'work_action',    ar:'هل الشخصية مشهورة بأفلام الأكشن والإثارة؟', en:'Is the person known for action/thriller films?' },
    { key:'work_superhero', ar:'هل الشخصية مثّلت دور بطل/ة خارق/ة (مارفل أو DC)؟', en:'Did the person play a superhero (Marvel/DC)?' },
    { key:'work_tv',        ar:'هل الشخصية اشتهرت بمسلسل تلفزيوني طويل؟', en:'Is the person famous mainly from a long TV series?' },
    { key:'work_comedy',    ar:'هل الشخصية مشهورة بأفلام الكوميديا؟',       en:'Is the person known for comedy films?' },
    { key:'work_drama',     ar:'هل الشخصية مشهورة بأفلام الدراما؟',         en:'Is the person known for drama films?' },
    { key:'work_scifi',     ar:'هل الشخصية مشهورة بأفلام الخيال العلمي؟',  en:'Is the person known for sci-fi films?' },
    { key:'work_bollywood', ar:'هل الشخصية من مشاهير بوليوود الهندية؟',    en:'Is the person from Bollywood (Indian cinema)?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تمثّل حالياً؟',          en:'Is the person still actively acting?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في فترة التسعينيات؟',    en:'Did the person rise to fame in the 90s?' },
    { key:'era_80s',        ar:'هل الشخصية اشتهرت في فترة الثمانينيات؟',   en:'Did the person rise to fame in the 80s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في فترة الألفينيات؟',    en:'Did the person rise to fame in the 2000s?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── SINGER deep-dive ─────────────────────────────────────────────────────
  singer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية الجنسية؟',                 en:'Is the person Egyptian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية الجنسية؟',                en:'Is the person Saudi?' },
    { key:'nat_kuwaiti',    ar:'هل الشخصية كويتية الجنسية؟',                en:'Is the person Kuwaiti?' },
    { key:'nat_emirati',    ar:'هل الشخصية إماراتية الجنسية؟',              en:'Is the person Emirati?' },
    { key:'nat_lebanese',   ar:'هل الشخصية لبنانية الجنسية؟',               en:'Is the person Lebanese?' },
    { key:'nat_moroccan',   ar:'هل الشخصية مغربية الجنسية؟',                en:'Is the person Moroccan?' },
    { key:'nat_algerian',   ar:'هل الشخصية جزائرية الجنسية؟',               en:'Is the person Algerian?' },
    { key:'nat_iraqi',      ar:'هل الشخصية عراقية الجنسية؟',                en:'Is the person Iraqi?' },
    { key:'nat_tunisian',   ar:'هل الشخصية تونسية الجنسية؟',                en:'Is the person Tunisian?' },
    { key:'nat_syrian',     ar:'هل الشخصية سورية الجنسية؟',                 en:'Is the person Syrian?' },
    { key:'nat_canadian',   ar:'هل الشخصية كندية الجنسية؟',                 en:'Is the person Canadian?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية الجنسية؟',              en:'Is the person Australian?' },
    { key:'style_pop',      ar:'هل الشخصية مغن/ية بوب أو موسيقى حديثة؟',   en:'Is the person a pop or contemporary music artist?' },
    { key:'style_tarab',    ar:'هل الشخصية مغن/ية طرب أصيل أو موسيقى عربية كلاسيكية؟', en:'Is the person known for traditional Arabic/Tarab music?' },
    { key:'style_rap',      ar:'هل الشخصية راب/هيب هوب؟',                   en:'Is the person a rapper/hip-hop artist?' },
    { key:'style_rock',     ar:'هل الشخصية مغن/ية روك أو ميتال؟',           en:'Is the person a rock/metal artist?' },
    { key:'style_rnb',      ar:'هل الشخصية من فنانين ريذم آند بلوز (R&B)؟', en:'Is the person an R&B artist?' },
    { key:'style_band',     ar:'هل الشخصية عضو في فرقة موسيقية؟',           en:'Is the person part of a music band/group?' },
    { key:'ach_grammy',     ar:'هل الشخصية فازت بجائزة غرامي الموسيقية؟',  en:'Did the person win a Grammy Award?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تغني وتصدر ألبومات حالياً؟', en:'Is the person still actively releasing music?' },
    { key:'era_60s_70s',    ar:'هل الشخصية اشتهرت في حقبة الستينيات أو السبعينيات؟', en:'Did the person rise to fame in the 60s or 70s?' },
    { key:'era_80s',        ar:'هل الشخصية اشتهرت في فترة الثمانينيات؟',   en:'Did the person rise to fame in the 80s?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في فترة التسعينيات؟',    en:'Did the person rise to fame in the 90s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في فترة الألفينيات؟',    en:'Did the person rise to fame in the 2000s?' },
    { key:'era_10s',        ar:'هل الشخصية اشتهرت في العقد الثاني؟',        en:'Did the person rise to fame in the 2010s?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── POLITICIAN deep-dive ────────────────────────────────────────────────
  politician: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية الجنسية؟',                 en:'Is the person Russian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية الجنسية؟',               en:'Is the person German?' },
    { key:'nat_chinese',    ar:'هل الشخصية صينية الجنسية؟',                 en:'Is the person Chinese?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية الجنسية؟',                 en:'Is the person Indian?' },
    { key:'nat_turkish',    ar:'هل الشخصية تركية الجنسية؟',                 en:'Is the person Turkish?' },
    { key:'nat_israeli',    ar:'هل الشخصية إسرائيلية الجنسية؟',             en:'Is the person Israeli?' },
    { key:'role_president', ar:'هل الشخصية شغلت منصب رئيس/ة جمهورية أو دولة؟', en:'Did the person serve as president or head of state?' },
    { key:'role_pm',        ar:'هل الشخصية شغلت منصب رئيس/ة وزراء؟',       en:'Did the person serve as prime minister?' },
    { key:'role_dictator',  ar:'هل الشخصية كانت حاكماً مطلقاً أو ديكتاتوراً؟', en:'Was the person an authoritarian ruler or dictator?' },
    { key:'historical',     ar:'هل الشخصية تاريخية؟ (قبل 1950م)',            en:'Is it a historical political figure (before 1950)?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── SCIENTIST deep-dive ─────────────────────────────────────────────────
  scientist: [
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية الجنسية؟',               en:'Is the person German?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_polish',     ar:'هل الشخصية بولندية الجنسية؟',               en:'Is the person Polish?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية الجنسية؟',               en:'Is the person Italian?' },
    { key:'field_physics',  ar:'هل الشخصية متخصصة في علم الفيزياء؟',        en:'Is the person specialized in physics?' },
    { key:'field_chemistry',ar:'هل الشخصية متخصصة في علم الكيمياء؟',       en:'Is the person specialized in chemistry?' },
    { key:'field_biology',  ar:'هل الشخصية متخصصة في علم الأحياء أو الطب؟', en:'Is the person specialized in biology/medicine?' },
    { key:'field_tech',     ar:'هل الشخصية متخصصة في التكنولوجيا والحوسبة؟', en:'Is the person specialized in technology/computing?' },
    { key:'field_math',     ar:'هل الشخصية متخصصة في الرياضيات؟',          en:'Is the person specialized in mathematics?' },
    { key:'field_astro',    ar:'هل الشخصية متخصصة في علم الفلك أو الفضاء؟', en:'Is the person specialized in astronomy/space?' },
    { key:'ach_nobel',      ar:'هل الشخصية فازت بجائزة نوبل في العلوم؟',   en:'Did the person win a Nobel Prize in science?' },
    { key:'historical',     ar:'هل الشخصية تاريخية؟ (قبل 1950م)',           en:'Is it a historical scientist (before 1950)?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── BUSINESS deep-dive ───────────────────────────────────────────────────
  business: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية الجنسية؟',               en:'Is the person European?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_chinese',    ar:'هل الشخصية صينية الجنسية؟',                 en:'Is the person Chinese?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية الجنسية؟',                 en:'Is the person Indian?' },
    { key:'work_founder',   ar:'هل الشخصية مؤسس/ة شركة تقنية عملاقة؟',    en:'Is the person founder of a major tech company?' },
    { key:'ach_billionaire',ar:'هل الشخصية من المليارديرات العالميين؟',     en:'Is the person a billionaire?' },
    { key:'sector_tech',    ar:'هل عمل الشخصية في قطاع التكنولوجيا؟',       en:'Is the person in the tech industry?' },
    { key:'sector_finance', ar:'هل عمل الشخصية في قطاع المالية أو الاستثمار؟', en:'Is the person in the finance/investment sector?' },
    { key:'sector_media',   ar:'هل عمل الشخصية في قطاع الإعلام أو الترفيه؟', en:'Is the person in the media/entertainment sector?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال نشطة في عالم الأعمال؟', en:'Is the person still active in business?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── ROYALTY deep-dive ────────────────────────────────────────────────────
  royalty: [
    { key:'nat_british',    ar:'هل الشخصية من العائلة المالكة البريطانية؟',  en:'Is the person from the British Royal Family?' },
    { key:'nat_arab',       ar:'هل الشخصية من أسرة حاكمة عربية؟',           en:'Is the person from an Arab ruling family?' },
    { key:'nat_european',   ar:'هل الشخصية من أسرة حاكمة أوروبية؟',         en:'Is the person from a European royal family?' },
    { key:'role_king',      ar:'هل الشخصية ملك/ة؟',                         en:'Is the person a king or queen?' },
    { key:'role_prince',    ar:'هل الشخصية أمير/أميرة؟',                    en:'Is the person a prince or princess?' },
    { key:'historical',     ar:'هل الشخصية شخصية ملكية تاريخية؟',           en:'Is it a historical royal figure?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── WRITER deep-dive ─────────────────────────────────────────────────────
  writer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية الجنسية؟',                 en:'Is the person Russian?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية الجنسية؟',                 en:'Is the person Egyptian?' },
    { key:'nat_colombian',  ar:'هل الشخصية كولومبية الجنسية؟',              en:'Is the person Colombian?' },
    { key:'nat_japanese',   ar:'هل الشخصية يابانية الجنسية؟',               en:'Is the person Japanese?' },
    { key:'type_novelist',  ar:'هل الشخصية روائي/ة (تكتب روايات)؟',        en:'Is the person a novelist?' },
    { key:'type_poet',      ar:'هل الشخصية شاعر/ة؟',                        en:'Is the person a poet?' },
    { key:'type_playwright',ar:'هل الشخصية كاتب/ة مسرح؟',                  en:'Is the person a playwright?' },
    { key:'type_journalist',ar:'هل الشخصية صحفي/ة أو مراسل/ة مشهور/ة؟',   en:'Is the person a famous journalist?' },
    { key:'ach_nobel',      ar:'هل الشخصية فازت بجائزة نوبل للآداب؟',      en:'Did the person win the Nobel Prize in Literature?' },
    { key:'ach_booker',     ar:'هل الشخصية فازت بجائزة بوكر الأدبية؟',     en:'Did the person win the Booker Prize?' },
    { key:'historical',     ar:'هل الشخصية أديب/ة تاريخي/ة قديمة؟',        en:'Is it a historical literary figure?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── FICTIONAL deep-dive ──────────────────────────────────────────────────
  fictional: [
    { key:'fic_superhero',  ar:'هل الشخصية بطل/ة خارق/ة بقدرات فوق بشرية؟', en:'Is it a superhero with superpowers?' },
    { key:'fic_villain',    ar:'هل الشخصية الشرير/ة الرئيسي/ة في القصة؟',   en:'Is it a main villain?' },
    { key:'fic_marvel',     ar:'هل الشخصية من كون مارفل (MCU/Marvel Comics)؟', en:'Is it from the Marvel universe (MCU/Marvel Comics)?' },
    { key:'fic_dc',         ar:'هل الشخصية من كون DC Comics أو أفلام DC؟',   en:'Is it from DC Comics/DC films?' },
    { key:'fic_disney',     ar:'هل الشخصية من أفلام ديزني الأنيميشن؟',      en:'Is it from Disney animated films?' },
    { key:'fic_pixar',      ar:'هل الشخصية من أفلام بيكسار؟',               en:'Is it from Pixar films?' },
    { key:'fic_anime',      ar:'هل الشخصية من أنيمي ياباني؟',               en:'Is it from a Japanese anime series?' },
    { key:'fic_movie',      ar:'هل الشخصية من فيلم سينمائي (ليس مسلسل)؟',  en:'Is it primarily from a movie (not a TV series)?' },
    { key:'fic_series',     ar:'هل الشخصية من مسلسل تلفزيوني؟',             en:'Is it from a TV series?' },
    { key:'fic_game',       ar:'هل الشخصية من لعبة فيديو؟',                 en:'Is it from a video game?' },
    { key:'fic_book',       ar:'هل الشخصية من رواية أو كتاب أدبي؟',         en:'Is it from a novel or book?' },
    { key:'fic_fly',        ar:'هل تستطيع الشخصية الطيران؟',                en:'Can the character fly?' },
    { key:'fic_powers',     ar:'هل تمتلك الشخصية قوى خارقة للطبيعة؟',      en:'Does the character have supernatural powers?' },
    { key:'fic_human',      ar:'هل الشخصية بشرية الشكل والطبيعة؟',          en:'Is the character human in appearance and nature?' },
    { key:'fic_robot',      ar:'هل الشخصية آلة أو روبوت أو ذكاء اصطناعي؟', en:'Is the character a robot, machine, or AI?' },
    { key:'fic_animal',     ar:'هل الشخصية حيوان أو مخلوق غير بشري؟',      en:'Is the character an animal or non-human creature?' },
    { key:'fic_netflix',    ar:'هل الشخصية من مسلسل نتفليكس مشهور؟',       en:'Is the character from a famous Netflix series?' },
    { key:'male',           ar:'هل الشخصية ذكر؟',                           en:'Is the character male?' },
  ],

  // ─── DIRECTOR deep-dive ───────────────────────────────────────────────────
  director: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية الجنسية؟',               en:'Is the person Italian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية الجنسية؟',               en:'Is the person French?' },
    { key:'nat_mexican',    ar:'هل الشخصية مكسيكية الجنسية؟',               en:'Is the person Mexican?' },
    { key:'nat_japanese',   ar:'هل الشخصية يابانية الجنسية؟',               en:'Is the person Japanese?' },
    { key:'ach_oscar',      ar:'هل الشخصية فازت بأوسكار أفضل مخرج/ة؟',    en:'Did the person win an Oscar for Best Director?' },
    { key:'work_action',    ar:'هل الشخصية مشهورة بإخراج أفلام الأكشن؟',   en:'Is the person known for directing action films?' },
    { key:'work_drama',     ar:'هل الشخصية مشهورة بإخراج أفلام الدراما؟',  en:'Is the person known for directing drama films?' },
    { key:'work_scifi',     ar:'هل الشخصية مشهورة بإخراج أفلام الخيال العلمي؟', en:'Is the person known for directing sci-fi films?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تخرج أفلاماً حالياً؟', en:'Is the person still actively directing?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],

  // ─── COMEDIAN deep-dive ───────────────────────────────────────────────────
  comedian: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية الجنسية؟',               en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية الجنسية؟',               en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية الجنسية؟',                 en:'Is the person Arab?' },
    { key:'work_standup',   ar:'هل الشخصية معروفة بعروض الستاند أب كوميدي؟', en:'Is the person known for stand-up comedy?' },
    { key:'work_tv',        ar:'هل الشخصية معروفة بمسلسل كوميدي تلفزيوني؟', en:'Is the person known from a TV comedy show?' },
    { key:'work_films',     ar:'هل الشخصية مثّلت في أفلام كوميدية طويلة؟',  en:'Did the person star in feature comedy films?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال نشطة حالياً؟',          en:'Is the person still active now?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',        en:'Is the person still alive?' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  DOMAIN → QUESTION LIST MAPPING
// ─────────────────────────────────────────────────────────────────────────────
const DOMAIN_LISTS = {
  footballer:        ['footballer'],
  basketballer:      ['basketballer'],
  tennis:            ['tennis'],
  boxer:             ['boxer'],
  swimmer:           ['swimmer'],
  athlete_athletics: ['athlete_athletics'],
  athlete:           ['athlete_sport'],
  actor:             ['actor'],
  singer:            ['singer'],
  director:          ['director'],
  comedian:          ['comedian'],
  entertainer:       ['entertainer_type'],
  politician:        ['politician'],
  scientist:         ['scientist'],
  business:          ['business'],
  royalty:           ['royalty'],
  writer:            ['writer'],
  fictional:         ['fictional'],
};

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION STORE
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 5 * 60 * 1000);

function newSession(language) {
  return {
    language,
    turns: [],
    askedKeys: new Set(),
    pendingKey: null,
    domain: null,
    subDomain: null,
    facts: {},
    rejectedGuesses: [],
    guessStreak: 0,
    questionsThisPhase: 0,
    minQ: INITIAL_MIN,
    maxQ: INITIAL_MAX,
    expiresAt: Date.now() + SESSION_TTL,
    broadOrder: shuffle(Q.broad.map(q => q.key)),
    cycleCount: 0,
    totalQuestions: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE UPDATE — applies yes/no to lock domains and record facts
// ─────────────────────────────────────────────────────────────────────────────
function applyAnswer(session, key, answer) {
  const yes = answer === 'yes';
  const no  = answer === 'no';

  if (yes) session.facts[key] = true;
  if (no)  session.facts[key] = false;

  // Lock primary domain
  if (!session.domain) {
    if (key === 'athlete'     && yes) session.domain = 'athlete';
    if (key === 'entertainer' && yes) session.domain = 'entertainer';
    if (key === 'politician'  && yes) session.domain = 'politician';
    if (key === 'scientist'   && yes) session.domain = 'scientist';
    if (key === 'business'    && yes) session.domain = 'business';
    if (key === 'royalty'     && yes) session.domain = 'royalty';
    if (key === 'writer'      && yes) session.domain = 'writer';
    if (key === 'fictional'   && yes) { session.domain = 'fictional'; session.subDomain = 'fictional'; }
    if (key === 'real'        && no)  session.domain = 'fictional';
    if (key === 'fictional'   && no)  session.facts.real = true;
  }

  // Lock sub-domain (sport type)
  if (!session.subDomain) {
    if (key === 'sport_football'   && yes) { session.subDomain = 'footballer';        session.domain = 'athlete'; }
    if (key === 'sport_basketball' && yes) { session.subDomain = 'basketballer';      session.domain = 'athlete'; }
    if (key === 'sport_tennis'     && yes) { session.subDomain = 'tennis';            session.domain = 'athlete'; }
    if (key === 'sport_boxing'     && yes) { session.subDomain = 'boxer';             session.domain = 'athlete'; }
    if (key === 'sport_swimming'   && yes) { session.subDomain = 'swimmer';           session.domain = 'athlete'; }
    if (key === 'sport_athletics'  && yes) { session.subDomain = 'athlete_athletics'; session.domain = 'athlete'; }
    if (key === 'ent_actor'        && yes) { session.subDomain = 'actor';             session.domain = 'entertainer'; }
    if (key === 'ent_singer'       && yes) { session.subDomain = 'singer';            session.domain = 'entertainer'; }
    if (key === 'ent_director'     && yes) { session.subDomain = 'director';          session.domain = 'entertainer'; }
    if (key === 'ent_comedian'     && yes) { session.subDomain = 'comedian';          session.domain = 'entertainer'; }
    if (key === 'ent_presenter'    && yes) { session.subDomain = 'comedian';          session.domain = 'entertainer'; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHOULD ASK FILTER — prevents redundant, contradictory, irrelevant questions
// ─────────────────────────────────────────────────────────────────────────────
function shouldAsk(key, session) {
  const f = session.facts;

  // ── Nationality: once one is confirmed, skip all others ──────────────────
  const allNatKeys = [
    'nat_arab','nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian',
    'nat_dutch','nat_russian','nat_australian','nat_swiss','nat_serbian',
    'nat_latin','nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati',
    'nat_moroccan','nat_algerian','nat_lebanese','nat_iraqi','nat_syrian',
    'nat_turkish','nat_chinese','nat_indian','nat_japanese','nat_korean',
    'nat_iranian','nat_israeli','nat_jordanian','nat_mexican','nat_filipino',
    'nat_kazakh','nat_colombian','nat_polish','nat_jamaican','nat_kenyan',
    'nat_ethiopian','nat_african','nat_canadian','nat_s_american','nat_european',
    'nat_croatian','nat_belgian','nat_senegalese','nat_cameroonian','nat_ivorian',
    'nat_tunisian','nat_greek',
  ];
  const confirmedNat = allNatKeys.find(k => f[k] === true);
  if (confirmedNat && allNatKeys.includes(key) && key !== confirmedNat) return false;

  // ── Regional filters: if Arab confirmed, skip non-Arab nationalities ─────
  const arabNats = ['nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati','nat_moroccan',
    'nat_algerian','nat_lebanese','nat_iraqi','nat_syrian','nat_jordanian','nat_tunisian'];
  const nonArabNats = ['nat_american','nat_british','nat_french','nat_spanish','nat_portuguese',
    'nat_argentine','nat_brazilian','nat_german','nat_italian','nat_dutch','nat_russian',
    'nat_australian','nat_swiss','nat_serbian','nat_latin','nat_chinese','nat_japanese',
    'nat_korean','nat_indian','nat_turkish','nat_greek'];

  if (f['nat_arab'] === true  && nonArabNats.includes(key))  return false;
  if (f['nat_arab'] === false && arabNats.includes(key))     return false;

  if (f['nat_european'] === true && ['nat_american','nat_arab','nat_chinese',
    'nat_japanese','nat_korean','nat_indian','nat_african'].includes(key)) return false;
  if (f['nat_s_american'] === true && ['nat_british','nat_german','nat_french',
    'nat_italian','nat_dutch','nat_russian'].includes(key)) return false;
  if (f['nat_african'] === true && ['nat_american','nat_european',
    'nat_s_american','nat_arab'].includes(key)) return false;

  // ── Sport type: once confirmed, skip others ───────────────────────────────
  const sportKeys = ['sport_football','sport_basketball','sport_tennis','sport_boxing',
    'sport_swimming','sport_golf','sport_athletics','sport_cycling','sport_mma','sport_other'];
  const confirmedSport = sportKeys.find(k => f[k] === true);
  if (confirmedSport && sportKeys.includes(key) && key !== confirmedSport) return false;

  // ── Entertainer sub-type: once confirmed, skip others ────────────────────
  const entKeys = ['ent_actor','ent_singer','ent_director','ent_comedian','ent_presenter','ent_model','ent_producer'];
  const confirmedEnt = entKeys.find(k => f[k] === true);
  if (confirmedEnt && entKeys.includes(key) && key !== confirmedEnt) return false;

  // ── Domain: once confirmed, skip other domain questions ──────────────────
  const domainKeys = ['athlete','entertainer','politician','scientist','business','royalty','writer','fictional'];
  const confirmedDomain = domainKeys.find(k => f[k] === true);
  if (confirmedDomain && domainKeys.includes(key) && key !== confirmedDomain) return false;

  // ── Alive/historical contradictions ──────────────────────────────────────
  if (f['alive'] === true   && key === 'historical')   return false;
  if (f['alive'] === false  && key === 'era_active')   return false;
  if (f['historical'] === true && key === 'era_active') return false;
  if (f['era_active'] === true && key === 'historical') return false;

  // ── Era contradictions ────────────────────────────────────────────────────
  if (f['era_active'] === true && ['era_90s','era_80s','era_00s','era_10s','era_20s','era_60s_70s'].includes(key)) return false;
  if (f['era_90s']    === true && ['era_80s','era_00s','era_10s','era_20s','era_60s_70s'].includes(key)) return false;
  if (f['era_80s']    === true && ['era_90s','era_00s','era_10s','era_20s'].includes(key)) return false;
  if (f['era_00s']    === true && ['era_80s','era_90s','era_10s','era_20s'].includes(key)) return false;
  if (f['era_10s']    === true && ['era_80s','era_90s','era_00s'].includes(key)) return false;

  // ── Real vs fictional contradictions ─────────────────────────────────────
  if (f['real'] === true && ['fictional','fic_marvel','fic_dc','fic_disney','fic_anime',
    'fic_superhero','fic_villain','fic_fly','fic_powers','fic_game','fic_movie',
    'fic_human','fic_robot','fic_animal','fic_pixar','fic_netflix','fic_series','fic_book'].includes(key)) return false;
  if (f['fictional'] === true && ['real','athlete','entertainer','politician','scientist',
    'business','royalty','writer'].includes(key)) return false;

  // ── Fictional universe contradictions ────────────────────────────────────
  if (f['fic_marvel'] === true && ['fic_dc','fic_disney','fic_anime','fic_pixar'].includes(key)) return false;
  if (f['fic_dc']     === true && ['fic_marvel','fic_disney','fic_anime','fic_pixar'].includes(key)) return false;
  if (f['fic_disney'] === true && ['fic_marvel','fic_dc','fic_anime'].includes(key)) return false;
  if (f['fic_anime']  === true && ['fic_marvel','fic_dc','fic_disney','fic_pixar'].includes(key)) return false;

  // ── Weight class: only relevant for boxers ───────────────────────────────
  const weightKeys = ['weight_heavy','weight_middle','weight_light'];
  if (session.subDomain !== 'boxer' && weightKeys.includes(key)) return false;
  const confirmedWeight = weightKeys.find(k => f[k] === true);
  if (confirmedWeight && weightKeys.includes(key) && key !== confirmedWeight) return false;

  // ── Field specialty: only for scientists ─────────────────────────────────
  const fieldKeys = ['field_physics','field_chemistry','field_biology','field_tech','field_math','field_astro'];
  if (session.domain !== 'scientist' && fieldKeys.includes(key)) return false;
  const confirmedField = fieldKeys.find(k => f[k] === true);
  if (confirmedField && fieldKeys.includes(key) && key !== confirmedField) return false;

  // ── Style: only for singers ───────────────────────────────────────────────
  const styleKeys = ['style_pop','style_tarab','style_rap','style_rnb','style_rock','style_band'];
  if (session.subDomain !== 'singer' && session.domain !== 'singer' && styleKeys.includes(key)) return false;

  // ── Swimmer styles ────────────────────────────────────────────────────────
  if (session.subDomain !== 'swimmer' && ['style_freestyle','style_butterfly'].includes(key)) return false;

  // ── Position: only relevant in sport ─────────────────────────────────────
  const posFootball = ['pos_striker','pos_goalkeeper','pos_midfielder','pos_defender'];
  if (session.subDomain !== 'footballer' && posFootball.includes(key)) return false;

  const posBasket = ['pos_guard','pos_center','pos_forward'];
  if (session.subDomain !== 'basketballer' && posBasket.includes(key)) return false;

  // ── Club questions only for footballers ───────────────────────────────────
  const clubKeys = ['club_real','club_barca','club_manu','club_liver','club_city','club_chelsea',
    'club_juve','club_psg','club_bayern','club_alnassr','club_atletico','club_arsenal','club_inter'];
  if (session.subDomain !== 'footballer' && clubKeys.includes(key)) return false;

  // ── Achievement relevance ─────────────────────────────────────────────────
  if (key === 'ach_ballondor' && session.subDomain && session.subDomain !== 'footballer') return false;
  if (key === 'ach_worldcup'  && session.subDomain && !['footballer','athlete_athletics'].includes(session.subDomain)) return false;
  if (key === 'ach_ucl'       && session.subDomain !== 'footballer') return false;
  if (key === 'ach_afcon'     && session.subDomain !== 'footballer') return false;
  if (key === 'ach_euro'      && session.subDomain !== 'footballer') return false;
  if (key === 'ach_copa'      && session.subDomain !== 'footballer') return false;
  if (key === 'ach_nba_champ' && session.subDomain !== 'basketballer') return false;
  if (key === 'ach_grandslam' && session.subDomain !== 'tennis') return false;
  if (key === 'ach_wimbledon' && session.subDomain !== 'tennis') return false;
  if (key === 'ach_usopen'    && session.subDomain !== 'tennis') return false;
  if (key === 'ach_roland'    && session.subDomain !== 'tennis') return false;
  if (key === 'ach_australia' && session.subDomain !== 'tennis') return false;
  if (key === 'ach_undisputed' && session.subDomain !== 'boxer') return false;

  // ── born_20th: useless if historical is confirmed ─────────────────────────
  if (f['historical'] === true && key === 'born_20th') return false;
  if (f['born_20th'] === false && key === 'historical') return false;
  if (f['born_20th'] === true  && key === 'historical') return false;

  // ── Skip 'alive' if already answered ─────────────────────────────────────
  if (f['alive'] !== undefined && key === 'alive') return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEXT QUESTION SELECTOR — picks most informative unasked question
// ─────────────────────────────────────────────────────────────────────────────
function nextQuestion(session) {
  const { domain, subDomain, askedKeys, language: lang } = session;
  const ar = lang === 'ar';

  let listNames;
  if (subDomain && DOMAIN_LISTS[subDomain]) {
    listNames = DOMAIN_LISTS[subDomain];
  } else if (domain && DOMAIN_LISTS[domain]) {
    listNames = DOMAIN_LISTS[domain];
  } else {
    // Use shuffled broad order for variety across sessions
    const broadList = session.broadOrder
      .map(key => Q.broad.find(q => q.key === key))
      .filter(Boolean);
    for (const entry of broadList) {
      if (askedKeys.has(entry.key)) continue;
      if (!shouldAsk(entry.key, session)) continue;
      return { key: entry.key, text: ar ? entry.ar : entry.en };
    }
    return null;
  }

  for (const listName of listNames) {
    const list = Q[listName] ?? [];
    for (const entry of list) {
      if (askedKeys.has(entry.key)) continue;
      if (!shouldAsk(entry.key, session)) continue;
      return { key: entry.key, text: ar ? entry.ar : entry.en };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CALCULATE CANDIDATE CONFIDENCE SCORE based on known facts
//  Higher score = fewer remaining candidates = more confident guess
// ─────────────────────────────────────────────────────────────────────────────
function candidateConfidenceScore(session) {
  const f = session.facts;
  let score = 0;

  // Sub-domain narrows candidates dramatically
  if (session.subDomain) score += 30;
  if (session.domain)    score += 10;

  // Nationality is very narrowing
  const allNatKeys = Object.keys(f).filter(k => k.startsWith('nat_') && f[k] === true);
  score += allNatKeys.length * 15;

  // Achievements are very identifying
  const achKeys = Object.keys(f).filter(k => k.startsWith('ach_') && f[k] === true);
  score += achKeys.length * 10;

  // Era narrows further
  const eraKeys = Object.keys(f).filter(k => k.startsWith('era_') && f[k] !== undefined);
  score += eraKeys.length * 5;

  // Position/club/style
  const miscKeys = Object.keys(f).filter(k =>
    (k.startsWith('pos_') || k.startsWith('club_') || k.startsWith('style_') ||
     k.startsWith('work_') || k.startsWith('fic_') || k.startsWith('field_')) && f[k] === true
  );
  score += miscKeys.length * 8;

  // Alive/historical
  if (f['alive'] !== undefined)     score += 5;
  if (f['male'] !== undefined)      score += 5;
  if (f['historical'] !== undefined) score += 5;

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI QUESTION GENERATOR — only called when static bank is exhausted
// ─────────────────────────────────────────────────────────────────────────────
async function generateAIQuestion(session) {
  if (!openai) return null;
  const ar     = session.language === 'ar';
  const domain = session.subDomain ?? session.domain ?? 'general';
  const askedList = Array.from(session.askedKeys).slice(-30).join(', ');
  const factsStr  = factsSummary(session);

  const systemPrompt = ar
    ? `أنت محقق بارع في لعبة تخمين الشخصيات. مهمتك توليد سؤال ذكي واحد يساعد في تحديد الشخصية بدقة.
قواعد صارمة:
- السؤال يجب أن يكون بالعربية فقط
- يجب أن يكون ذا صلة بمجال: ${domain}
- لا تكرر هذه الأسئلة: [${askedList}]
- الحقائق المعروفة: ${factsStr}
- السؤال يجب أن يقلص القائمة المحتملة للشخصيات بشكل كبير
- استخدم صيغة الجنسين: "هل الشخصية مصري/ة؟" أو "هل الشخصية حاملة لقب...؟"
- أجب بـ JSON فقط: {"key":"ai_unique_key","text":"سؤالك هنا"}`
    : `You are a skilled detective in a character guessing game. Generate ONE highly informative yes/no question to narrow down the character.
Strict rules:
- Question must be in English only
- Must be relevant to domain: ${domain}
- Do NOT repeat: [${askedList}]
- Known facts: ${factsStr}
- Question should significantly eliminate possible candidates
- Reply with JSON only: {"key":"ai_unique_key","text":"Your question here"}`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      max_tokens: 150,
      messages: [{ role: 'system', content: systemPrompt }],
    });
    const raw = resp.choices?.[0]?.message?.content ?? '';
    const m   = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj  = JSON.parse(m[0]);
    const text = String(obj.text ?? '').trim();
    if (!text) return null;
    const key  = `ai_${Date.now()}`;
    return { key, text };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FACTS SUMMARY — human-readable facts for GPT guess prompt
// ─────────────────────────────────────────────────────────────────────────────
function factsSummary(session) {
  const f = session.facts;
  const parts = [];
  const add = (cond, label) => { if (cond) parts.push(label); };

  add(session.subDomain,                     `sub-domain: ${session.subDomain}`);
  add(session.domain && !session.subDomain,  `domain: ${session.domain}`);
  add(f.male    === true,  'male');
  add(f.male    === false, 'female');
  add(f.alive   === true,  'alive/living');
  add(f.alive   === false, 'deceased');
  add(f.historical === true, 'historical figure (pre-1900)');
  add(f.famous_globally === true,  'world-famous');
  add(f.arab_world === true,       'from Arab world/Middle East');
  add(f.born_20th === true,        'born in 20th century');

  // Nationalities
  const natMap = {
    nat_arab:'Arab', nat_american:'American', nat_british:'British', nat_french:'French',
    nat_spanish:'Spanish', nat_portuguese:'Portuguese', nat_argentine:'Argentine',
    nat_brazilian:'Brazilian', nat_german:'German', nat_italian:'Italian',
    nat_dutch:'Dutch', nat_russian:'Russian', nat_australian:'Australian',
    nat_swiss:'Swiss', nat_serbian:'Serbian', nat_egyptian:'Egyptian',
    nat_saudi:'Saudi', nat_kuwaiti:'Kuwaiti', nat_emirati:'Emirati',
    nat_moroccan:'Moroccan', nat_algerian:'Algerian', nat_lebanese:'Lebanese',
    nat_iraqi:'Iraqi', nat_syrian:'Syrian', nat_turkish:'Turkish',
    nat_chinese:'Chinese', nat_indian:'Indian', nat_japanese:'Japanese',
    nat_korean:'Korean', nat_iranian:'Iranian', nat_mexican:'Mexican',
    nat_canadian:'Canadian', nat_jamaican:'Jamaican', nat_kenyan:'Kenyan',
    nat_ethiopian:'Ethiopian', nat_african:'African (non-Arab)', nat_s_american:'South American',
    nat_european:'European', nat_croatian:'Croatian', nat_belgian:'Belgian',
    nat_senegalese:'Senegalese', nat_cameroonian:'Cameroonian', nat_ivorian:'Ivorian',
    nat_tunisian:'Tunisian', nat_greek:'Greek', nat_polish:'Polish', nat_filipino:'Filipino',
    nat_kazakh:'Kazakh', nat_colombian:'Colombian',
  };
  for (const [k, label] of Object.entries(natMap)) add(f[k] === true, label);

  // Achievements
  const achMap = {
    ach_worldcup:'won FIFA World Cup', ach_ballondor:"won Ballon d'Or",
    ach_ucl:'won UEFA Champions League', ach_oscar:'won Oscar',
    ach_emmy:'won Emmy', ach_grammy:'won Grammy', ach_nobel:'won Nobel Prize',
    ach_olympics:'won Olympic gold medal', ach_grandslam:'won Grand Slam (tennis)',
    ach_nba_champ:'won NBA Championship', ach_mvp:'won MVP award',
    ach_afcon:'won Africa Cup of Nations', ach_euro:'won UEFA Euros',
    ach_copa:'won Copa America', ach_billionaire:'billionaire',
    ach_undisputed:'multi-title world boxing champion',
    ach_world_rec:'holds world record', ach_multi_gold:'5+ Olympic gold medals',
  };
  for (const [k, label] of Object.entries(achMap)) add(f[k] === true, label);

  // Era
  const eraMap = {
    era_active:'still active/playing now', era_90s:'rose to fame in 90s',
    era_80s:'rose to fame in 80s', era_00s:'rose to fame in 2000s',
    era_10s:'rose to fame in 2010s', era_20s:'rose to fame in 2020s',
    era_60s_70s:'rose to fame in 60s/70s',
  };
  for (const [k, label] of Object.entries(eraMap)) add(f[k] === true, label);
  for (const [k, label] of Object.entries(eraMap)) add(f[k] === false, `NOT ${label}`);

  // Position/club/style/work/fictional
  const miscMap = {
    pos_striker:'striker/forward', pos_goalkeeper:'goalkeeper',
    pos_midfielder:'midfielder', pos_defender:'defender',
    pos_guard:'basketball guard', pos_center:'basketball center', pos_forward:'basketball forward',
    club_real:'played for Real Madrid', club_barca:'played for Barcelona',
    club_manu:'played for Man United', club_liver:'played for Liverpool',
    club_city:'played for Man City', club_chelsea:'played for Chelsea',
    club_juve:'played for Juventus', club_psg:'played for PSG',
    club_bayern:'played for Bayern Munich', club_alnassr:'played for Al-Nassr',
    club_atletico:'played for Atlético Madrid', club_arsenal:'played for Arsenal',
    club_inter:'played for Inter Milan',
    weight_heavy:'heavyweight boxer', weight_middle:'middleweight boxer', weight_light:'lighter weight boxer',
    field_physics:'physicist', field_chemistry:'chemist', field_biology:'biologist/doctor',
    field_tech:'technology/computer scientist', field_math:'mathematician', field_astro:'astronomer',
    style_pop:'pop music artist', style_tarab:'traditional Arabic/Tarab singer',
    style_rap:'rapper/hip-hop artist', style_rnb:'R&B artist', style_rock:'rock artist',
    style_band:'member of a band', style_freestyle:'freestyle swimmer', style_butterfly:'butterfly swimmer',
    work_action:'known for action films', work_superhero:'played superhero role',
    work_tv:'famous from TV series', work_comedy:'known for comedy', work_drama:'known for drama',
    work_scifi:'known for sci-fi', work_bollywood:'from Bollywood', work_standup:'stand-up comedian',
    work_founder:'company founder', work_films:'comedy film star',
    sector_tech:'tech industry', sector_finance:'finance/investment', sector_media:'media/entertainment',
    role_president:'served as president/head of state', role_pm:'served as prime minister',
    role_dictator:'authoritarian ruler', role_king:'king or queen', role_prince:'prince or princess',
    type_novelist:'novelist', type_poet:'poet', type_playwright:'playwright', type_journalist:'journalist',
    event_sprint:'sprinter (100m/200m)', event_marathon:'marathon/long-distance runner',
    event_jump:'jumper (high/long jump)', event_throws:'thrower (javelin/discus/shot put)',
    fic_marvel:'from Marvel universe', fic_dc:'from DC universe', fic_disney:'from Disney',
    fic_pixar:'from Pixar', fic_anime:'from Japanese anime', fic_superhero:'superhero character',
    fic_villain:'villain character', fic_fly:'can fly', fic_powers:'has superpowers',
    fic_human:'human character', fic_robot:'robot/AI character', fic_animal:'animal/creature character',
    fic_movie:'from a movie', fic_series:'from a TV series', fic_game:'from a video game',
    fic_book:'from a novel/book', fic_netflix:'from a Netflix series',
  };
  for (const [k, label] of Object.entries(miscMap)) add(f[k] === true, label);

  // Negatives that help
  for (const [k, label] of Object.entries(natMap)) add(f[k] === false, `NOT ${label}`);
  for (const [k, label] of Object.entries(achMap)) add(f[k] === false, `NOT ${label}`);

  return parts.join('; ') || 'no specific facts yet';
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIKIPEDIA FETCH — gets image, extract, article URL
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWiki(name, lang) {
  if (!name?.trim()) return null;
  const primaryLang = lang === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.trim().replace(/ /g, '_'));

  const fetchFromLang = async (l) => {
    const url = `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'MagicBallGame/2.0' } });
    if (!r.ok) throw new Error(`Wikipedia ${l}: ${r.status}`);
    return r.json();
  };

  try {
    let j = await fetchFromLang(primaryLang);
    let imageURL = j.thumbnail?.source ?? null;

    // Fallback to English image if Arabic page lacks one
    if (!imageURL && primaryLang === 'ar') {
      try { const enJ = await fetchFromLang('en'); imageURL = enJ.thumbnail?.source ?? null; } catch {}
    }

    return {
      title:      j.title ?? name,
      extract:    j.extract ?? '',
      imageURL,
      articleURL: j.content_urls?.desktop?.page ?? `https://${primaryLang}.wikipedia.org/wiki/${title}`,
    };
  } catch {
    if (primaryLang === 'ar') {
      try {
        const enJ = await fetchFromLang('en');
        return {
          title:      enJ.title ?? name,
          extract:    enJ.extract ?? '',
          imageURL:   enJ.thumbnail?.source ?? null,
          articleURL: enJ.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
        };
      } catch {}
    }
    return {
      title: name,
      extract: lang === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available.',
      imageURL: null,
      articleURL: `https://${primaryLang}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSE JSON from AI response safely
// ─────────────────────────────────────────────────────────────────────────────
function parseGuessJSON(raw) {
  const text = String(raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const name = String(obj.name ?? obj.character ?? obj.guess ?? '').trim();
    const confidence = typeof obj.confidence === 'number'
      ? Math.min(1, Math.max(0, obj.confidence)) : 0.75;
    if (!name) return null;
    return { name, confidence };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GPT GUESS — ultra-precise prompt using ALL collected facts
// ─────────────────────────────────────────────────────────────────────────────
async function makeGuess(session) {
  const ar = session.language === 'ar';
  const fallback = {
    type: 'guess',
    name: ar ? 'شخصية غير محددة' : 'Unknown character',
    confidence: 0.2,
    wiki: null,
    guessNumber: session.guessStreak + 1,
    questionNumber: session.totalQuestions,
  };

  if (!openai) {
    console.error('[makeGuess] OpenAI not configured');
    return fallback;
  }

  const summary  = factsSummary(session);
  const rejected = session.rejectedGuesses;
  const qa = session.turns.map((t, i) => `Q${i + 1}: ${t.question} → ${t.answer}`).join('\n');

  const system = ar
    ? `أنت خبير بارع في تحديد هوية الشخصيات الشهيرة. استناداً إلى الحقائق المؤكدة أدناه، حدّد الشخصية الأكثر احتمالاً.
قواعد صارمة:
- قدّم اسماً واحداً فقط، مكتوباً كما هو شائع (مثال: "محمد صلاح" أو "ليونيل ميسي" أو "فيروز")
- لا تكرر هذه الأسماء المرفوضة: [${rejected.join('، ') || 'لا شيء'}]
- إذا لم تكن متأكداً، اختر الأكثر احتمالاً بناءً على الحقائق
- أجب بـ JSON فقط، بدون أي نص آخر: {"name":"...","confidence":0.9}`
    : `You are a world-class character identification expert. Based ONLY on the confirmed facts below, name the single most likely real character.
Strict rules:
- Provide ONE full name as commonly known (e.g. "Lionel Messi", "Michael Jordan", "Marilyn Monroe")
- NEVER repeat these rejected names: [${rejected.join(', ') || 'none'}]
- If uncertain, pick the single most probable candidate based on the facts
- Respond with JSON ONLY, no other text: {"name":"...","confidence":0.9}`;

  const user = `=== CONFIRMED FACTS ===
${summary}

=== FULL Q&A LOG ===
${qa || 'none yet'}

=== REJECTED GUESSES (DO NOT repeat these) ===
${rejected.join(', ') || 'none'}

=== INSTRUCTION ===
Output your single best guess as JSON now. Consider all facts carefully.`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.05,  // Very low temperature for consistent, precise guessing
      max_tokens: 80,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content ?? '';
    const parsed = parseGuessJSON(raw);

    if (!parsed) {
      console.error('[makeGuess] Failed to parse JSON from:', raw);
      return fallback;
    }

    const { name, confidence } = parsed;

    // Double-check not returning a rejected name
    if (rejected.map(r => r.toLowerCase()).includes(name.toLowerCase())) {
      console.warn('[makeGuess] Returned rejected name again:', name);
      return fallback;
    }

    const wiki = await fetchWiki(name, session.language);

    return {
      type: 'guess',
      name,
      confidence,
      wiki,
      guessNumber: session.guessStreak + 1,
      questionNumber: session.totalQuestions,
    };
  } catch (e) {
    console.error('[makeGuess] Error:', e?.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE — decides what to do next (question vs guess)
// ─────────────────────────────────────────────────────────────────────────────
async function runEngine(session) {
  const { questionsThisPhase: qCount, minQ, maxQ } = session;

  // If we haven't reached minimum questions yet, ALWAYS ask more
  if (qCount < minQ) {
    const q = nextQuestion(session);
    if (q) {
      session.pendingKey = q.key;
      return {
        type: 'question',
        text: q.text,
        questionNumber: session.totalQuestions + 1,
        phase: session.cycleCount === 0 ? 'initial' : 'followup',
      };
    }
    // Static bank exhausted — use AI question
    const aiQ = await generateAIQuestion(session);
    if (aiQ) {
      session.pendingKey = aiQ.key;
      return {
        type: 'question',
        text: aiQ.text,
        questionNumber: session.totalQuestions + 1,
        phase: session.cycleCount === 0 ? 'initial' : 'followup',
      };
    }
    // No more questions possible — force guess
    return makeGuess(session);
  }

  // Reached maximum questions — must guess now
  if (qCount >= maxQ) {
    return makeGuess(session);
  }

  // Between min and max: decide whether to ask or guess
  const q = nextQuestion(session);
  if (!q) {
    // No more questions — try AI, then guess
    const aiQ = await generateAIQuestion(session);
    if (aiQ) {
      session.pendingKey = aiQ.key;
      return {
        type: 'question',
        text: aiQ.text,
        questionNumber: session.totalQuestions + 1,
        phase: session.cycleCount === 0 ? 'initial' : 'followup',
      };
    }
    return makeGuess(session);
  }

  // Check if we have enough confidence to guess early (only after minQ)
  const confidenceScore = candidateConfidenceScore(session);
  const readyToGuess = confidenceScore >= 70;  // High threshold for early guess

  if (readyToGuess && qCount >= minQ) {
    return makeGuess(session);
  }

  session.pendingKey = q.key;
  return {
    type: 'question',
    text: q.text,
    questionNumber: session.totalQuestions + 1,
    phase: session.cycleCount === 0 ? 'initial' : 'followup',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) }));
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) }));

// ── POST /api/game/start ──────────────────────────────────────────────────────
app.post('/api/game/start', async (req, res) => {
  try {
    const language  = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session   = newSession(language);
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('[start]', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// Alias
app.post('/api/start', async (req, res) => {
  try {
    const language  = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session   = newSession(language);
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('[start]', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// ── POST /api/game/answer ─────────────────────────────────────────────────────
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    const normAnswer = (() => {
      const m = { yes:'yes', no:'no', maybe:'maybe', dontknow:'dont_know', dont_know:'dont_know' };
      return m[String(answer ?? '').trim().toLowerCase().replace(/[^a-z_]/g, '')] ?? 'dont_know';
    })();

    const key = session.pendingKey ?? 'unknown';
    session.askedKeys.add(key);
    session.pendingKey = null;
    session.turns.push({ key, question: String(question ?? ''), answer: normAnswer });
    session.questionsThisPhase += 1;
    session.totalQuestions += 1;

    applyAnswer(session, key, normAnswer);

    return res.json(await runEngine(session));
  } catch (e) {
    console.error('[answer]', e);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

// Alias
app.post('/api/next', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (answer) {
      const normAnswer = (() => {
        const m = { yes:'yes', no:'no', maybe:'maybe', dontknow:'dont_know', dont_know:'dont_know' };
        return m[String(answer).trim().toLowerCase().replace(/[^a-z_]/g, '')] ?? 'dont_know';
      })();
      const key = session.pendingKey ?? 'unknown';
      session.askedKeys.add(key);
      session.pendingKey = null;
      session.turns.push({ key, question: String(question ?? key), answer: normAnswer });
      session.questionsThisPhase += 1;
      session.totalQuestions += 1;
      applyAnswer(session, key, normAnswer);
    }

    const result = await runEngine(session);
    return res.json({ result });
  } catch (e) {
    console.error('[next]', e);
    return res.status(500).json({ error: 'Failed to process' });
  }
});

// ── POST /api/game/guess-confirm ──────────────────────────────────────────────
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    // ✅ Correct guess — game won!
    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      sessions.delete(String(sessionId));
      return res.json({ type: 'revealed', guessName, wiki });
    }

    // ❌ Wrong guess — record and try again or ask more questions
    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    // Still have guesses left in this cycle
    if (session.guessStreak < MAX_GUESSES) {
      return res.json(await makeGuess(session));
    }

    // All 3 guesses exhausted — reset and ask 5–10 more questions in same domain
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;
    session.cycleCount += 1;

    return res.json(await runEngine(session));
  } catch (e) {
    console.error('[guess-confirm]', e);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

// Alias
app.post('/api/guess-result', async (req, res) => {
  try {
    const { sessionId, correct, guessedName } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (correct) {
      const wiki = await fetchWiki(String(guessedName ?? ''), session.language);
      sessions.delete(String(sessionId));
      return res.json({ ok: true, won: true, wiki });
    }

    const name = String(guessedName || '').trim();
    if (name && !session.rejectedGuesses.includes(name)) session.rejectedGuesses.push(name);
    session.guessStreak += 1;

    if (session.guessStreak < MAX_GUESSES) {
      const nextGuess = await makeGuess(session);
      return res.json({ ok: false, won: false, ...nextGuess });
    }

    // All guesses used — back to questions
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;
    session.cycleCount += 1;

    return res.json({ ok: true, won: false, gaveUp: false, continuePlaying: true });
  } catch (e) {
    console.error('[guess-result]', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── GET /api/wiki ──────────────────────────────────────────────────────────────
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    return res.json(await fetchWiki(name, lang));
  } catch (e) {
    console.error('[wiki]', e);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ── GET /api/session/:id — debug ───────────────────────────────────────────────
app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId:          req.params.id,
    language:           s.language,
    turns:              s.turns.length,
    totalQuestions:     s.totalQuestions,
    domain:             s.domain,
    subDomain:          s.subDomain,
    rejectedGuesses:    s.rejectedGuesses,
    guessStreak:        s.guessStreak,
    questionsThisPhase: s.questionsThisPhase,
    phase:              { min: s.minQ, max: s.maxQ },
    cycleCount:         s.cycleCount,
    confidenceScore:    candidateConfidenceScore(s),
    facts:              s.facts,
  });
});

app.listen(PORT, () => {
  console.log(`🎱 Magic Ball server running on port ${PORT}`);
  console.log(`   Model: ${MODEL} | OpenAI: ${openai ? '✅' : '❌'}`);
  console.log(`   Rules: ${INITIAL_MIN}–${INITIAL_MAX} questions → up to ${MAX_GUESSES} guesses → ${FOLLOWUP_MIN}–${FOLLOWUP_MAX} more questions`);
});
