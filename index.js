/**
 * Magic Ball — "20 Questions" AI character guessing game
 * Architecture:
 *   • Questions come from STATIC ordered lists per domain (zero repetition, zero drift)
 *   • GPT-4o is used ONLY for making the final guess and generating extra contextual questions
 *   • Domain is locked the moment a broad category is confirmed
 *   • Sub-domain narrows the list further (footballer ≠ boxer ≠ swimmer)
 *   • State is stored explicitly in the session — no re-parsing of question text
 *   • Broad questions are shuffled each session so first question varies
 *   • Gender-neutral Arabic phrasing (فنان/ة, رياضي/ة, etc.)
 */

import express from 'express';
import cors    from 'cors';
import OpenAI  from 'openai';
import crypto  from 'node:crypto';

const app  = express();
app.use(cors());
app.use(express.json());

const PORT  = Number(process.env.PORT  || 3001);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Support direct key or Replit AI Integration proxy
const openaiApiKey  = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const openaiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const openai = openaiApiKey
  ? new OpenAI({
      apiKey: openaiApiKey,
      ...(openaiBaseUrl ? { baseURL: openaiBaseUrl } : {})
    })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL_MIN  = 15;
const INITIAL_MAX  = 20;
const FOLLOWUP_MIN = 5;
const FOLLOWUP_MAX = 10;
const MAX_GUESSES  = 3;
const SESSION_TTL  = 60 * 60 * 1000;

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
//  QUESTION BANK
// ─────────────────────────────────────────────────────────────────────────────
const Q = {

  broad: [
    { key:'real',         ar:'هل الشخصية حقيقية وليست خيالية؟',          en:'Is it a real person (not fictional)?' },
    { key:'male',         ar:'هل الشخصية من الجنس الذكوري؟',             en:'Is it male?' },
    { key:'athlete',      ar:'هل الشخصية رياضي/ة محترف/ة؟',             en:'Is it a professional athlete?' },
    { key:'entertainer',  ar:'هل الشخصية فنان/ة أو نجم/ة؟',             en:'Is it an entertainer or celebrity?' },
    { key:'politician',   ar:'هل الشخصية سياسي/ة أو زعيم/ة؟',           en:'Is it a politician or leader?' },
    { key:'scientist',    ar:'هل الشخصية عالم/ة أو مخترع/ة؟',           en:'Is it a scientist or inventor?' },
    { key:'business',     ar:'هل الشخصية رجل/إمرأة أعمال مشهور/ة؟',    en:'Is it a famous businessperson?' },
    { key:'royalty',      ar:'هل الشخصية ملكية (ملك/ملكة/أمير/أميرة)؟', en:'Is it royalty (king/queen/prince/princess)?' },
    { key:'writer',       ar:'هل الشخصية كاتب/ة أو شاعر/ة؟',            en:'Is it a writer or poet?' },
    { key:'alive',        ar:'هل الشخصية لا تزال على قيد الحياة؟',       en:'Is the person still alive?' },
    { key:'historical',   ar:'هل الشخصية تاريخية قديمة (قبل 1900م)؟',   en:'Is it an ancient historical figure (before 1900)?' },
    { key:'fictional',    ar:'هل الشخصية خيالية أو كرتونية؟',            en:'Is it a fictional or animated character?' },
    { key:'famous_globally', ar:'هل الشخصية مشهورة عالمياً؟',            en:'Is the person world-famous?' },
    { key:'arab_world',   ar:'هل الشخصية من العالم العربي؟',              en:'Is the person from the Arab world?' },
    { key:'born_20th',    ar:'هل الشخصية وُلدت في القرن العشرين؟',       en:'Was the person born in the 20th century?' },
  ],

  athlete_sport: [
    { key:'sport_football',   ar:'هل تلعب الشخصية كرة القدم؟',           en:'Does the person play football/soccer?' },
    { key:'sport_basketball', ar:'هل تلعب الشخصية كرة السلة؟',           en:'Does the person play basketball?' },
    { key:'sport_tennis',     ar:'هل تلعب الشخصية التنس؟',               en:'Does the person play tennis?' },
    { key:'sport_boxing',     ar:'هل الشخصية ملاكم/ة؟',                  en:'Is the person a boxer?' },
    { key:'sport_swimming',   ar:'هل الشخصية سباح/ة؟',                   en:'Is the person a swimmer?' },
    { key:'sport_golf',       ar:'هل تلعب الشخصية الغولف؟',              en:'Does the person play golf?' },
    { key:'sport_athletics',  ar:'هل الشخصية عداء/ة أو رامي/ة؟',         en:'Is the person a track & field athlete?' },
    { key:'sport_cycling',    ar:'هل الشخصية دراجة هوائية/سيكلست؟',      en:'Is the person a cyclist?' },
    { key:'sport_mma',        ar:'هل الشخصية مقاتل/ة في الفنون القتالية؟', en:'Is the person an MMA/martial arts fighter?' },
    { key:'sport_other',      ar:'هل الشخصية رياضية أولمبية؟',            en:'Is the person an Olympic athlete?' },
  ],

  entertainer_type: [
    { key:'ent_actor',    ar:'هل الشخصية ممثل/ة؟',                       en:'Is the person an actor or actress?' },
    { key:'ent_singer',   ar:'هل الشخصية مغنٍ/مغنية؟',                  en:'Is the person a singer?' },
    { key:'ent_director', ar:'هل الشخصية مخرج/ة أفلام؟',                en:'Is the person a film director?' },
    { key:'ent_comedian', ar:'هل الشخصية فكاه/ية أو كوميدي/ة؟',         en:'Is the person a comedian?' },
    { key:'ent_presenter',ar:'هل الشخصية مقدم/ة برامج أو مذيع/ة؟',      en:'Is the person a TV presenter or host?' },
    { key:'ent_model',    ar:'هل الشخصية عارض/ة أزياء؟',                en:'Is the person a model?' },
    { key:'ent_producer', ar:'هل الشخصية منتج/ة أفلام أو موسيقى؟',      en:'Is the person a music or film producer?' },
  ],

  footballer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_s_american', ar:'هل الشخصية من أمريكا الجنوبية؟',         en:'Is the person South American?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                    en:'Is the person European?' },
    { key:'ach_worldcup',   ar:'هل الشخصية فازت بكأس العالم؟',           en:'Did the person win the World Cup?' },
    { key:'ach_ballondor',  ar:'هل الشخصية فازت بالبالون دور؟',          en:"Did the person win the Ballon d'Or?" },
    { key:'ach_ucl',        ar:'هل الشخصية فازت بدوري أبطال أوروبا؟',   en:'Did the person win the Champions League?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب حالياً؟',        en:'Is the person still playing now?' },
    { key:'nat_portuguese', ar:'هل الشخصية برتغالية؟',                   en:'Is the person Portuguese?' },
    { key:'nat_argentine',  ar:'هل الشخصية أرجنتينية؟',                  en:'Is the person Argentine?' },
    { key:'nat_brazilian',  ar:'هل الشخصية برازيلية؟',                   en:'Is the person Brazilian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية؟',                    en:'Is the person Spanish?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية؟',                    en:'Is the person German?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_moroccan',   ar:'هل الشخصية مغربية؟',                     en:'Is the person Moroccan?' },
    { key:'nat_algerian',   ar:'هل الشخصية جزائرية؟',                    en:'Is the person Algerian?' },
    { key:'nat_dutch',      ar:'هل الشخصية هولندية؟',                    en:'Is the person Dutch?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية؟',                    en:'Is the person Italian?' },
    { key:'nat_belgian',    ar:'هل الشخصية بلجيكية؟',                    en:'Is the person Belgian?' },
    { key:'nat_croatian',   ar:'هل الشخصية كرواتية؟',                    en:'Is the person Croatian?' },
    { key:'pos_striker',    ar:'هل الشخصية مهاجم/ة؟',                    en:'Is the person a striker/forward?' },
    { key:'pos_goalkeeper', ar:'هل الشخصية حارس/ة مرمى؟',               en:'Is the person a goalkeeper?' },
    { key:'pos_midfielder', ar:'هل الشخصية لاعب/ة وسط؟',                en:'Is the person a midfielder?' },
    { key:'pos_defender',   ar:'هل الشخصية مدافع/ة؟',                   en:'Is the person a defender?' },
    { key:'club_real',      ar:'هل الشخصية لعبت في ريال مدريد؟',         en:'Did the person play for Real Madrid?' },
    { key:'club_barca',     ar:'هل الشخصية لعبت في برشلونة؟',            en:'Did the person play for Barcelona?' },
    { key:'club_manu',      ar:'هل الشخصية لعبت في مانشستر يونايتد؟',    en:'Did the person play for Man United?' },
    { key:'club_liver',     ar:'هل الشخصية لعبت في ليفربول؟',            en:'Did the person play for Liverpool?' },
    { key:'club_city',      ar:'هل الشخصية لعبت في مانشستر سيتي؟',       en:'Did the person play for Man City?' },
    { key:'club_chelsea',   ar:'هل الشخصية لعبت في تشيلسي؟',             en:'Did the person play for Chelsea?' },
    { key:'club_juve',      ar:'هل الشخصية لعبت في يوفنتوس؟',            en:'Did the person play for Juventus?' },
    { key:'club_psg',       ar:'هل الشخصية لعبت في باريس سان جيرمان؟',   en:'Did the person play for PSG?' },
    { key:'club_bayern',    ar:'هل الشخصية لعبت في بايرن ميونيخ؟',       en:'Did the person play for Bayern Munich?' },
    { key:'club_alnassr',   ar:'هل الشخصية تلعب في النصر السعودي؟',      en:'Does the person play for Al-Nassr?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',       en:'Did the person rise to fame in the 90s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في الألفينيات؟',       en:'Did the person rise to fame in the 2000s?' },
    { key:'era_10s',        ar:'هل الشخصية اشتهرت في العقد الثاني؟',     en:'Did the person rise to fame in the 2010s?' },
    { key:'ach_afcon',      ar:'هل الشخصية فازت ببطولة أمم أفريقيا؟',    en:'Did the person win the Africa Cup?' },
    { key:'ach_euro',       ar:'هل الشخصية فازت ببطولة أمم أوروبا؟',     en:'Did the person win the Euros?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  basketballer: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب حالياً؟',        en:'Is the person still playing now?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',       en:'Did the person rise to fame in the 90s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في الألفينيات؟',       en:'Did the person rise to fame in the 2000s?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية؟',      en:'Did the person win an Olympic medal?' },
    { key:'ach_nba_champ',  ar:'هل الشخصية فازت ببطولة NBA؟',            en:'Did the person win an NBA Championship?' },
    { key:'ach_mvp',        ar:'هل الشخصية فازت بجائزة MVP؟',            en:'Did the person win the MVP award?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                    en:'Is the person European?' },
    { key:'nat_african',    ar:'هل الشخصية أفريقية الأصل؟',              en:'Is the person of African origin?' },
    { key:'pos_guard',      ar:'هل الشخصية حارس/ة في كرة السلة؟',        en:'Is the person a guard in basketball?' },
    { key:'pos_center',     ar:'هل الشخصية مركز في كرة السلة؟',          en:'Is the person a center?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  tennis: [
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                    en:'Is the person European?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية؟',                    en:'Is the person Spanish?' },
    { key:'nat_swiss',      ar:'هل الشخصية سويسرية؟',                    en:'Is the person Swiss?' },
    { key:'nat_serbian',    ar:'هل الشخصية صربية؟',                      en:'Is the person Serbian?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية؟',                    en:'Is the person German?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية؟',                   en:'Is the person Australian?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية؟',                      en:'Is the person Russian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تلعب حالياً؟',        en:'Is the person still playing now?' },
    { key:'ach_grandslam',  ar:'هل الشخصية فازت ببطولة غراند سلام؟',     en:'Did the person win a Grand Slam?' },
    { key:'ach_wimbledon',  ar:'هل الشخصية فازت ببطولة ويمبلدون؟',       en:'Did the person win Wimbledon?' },
    { key:'ach_usopen',     ar:'هل الشخصية فازت بالبطولة الأمريكية المفتوحة؟', en:'Did the person win the US Open?' },
    { key:'ach_roland',     ar:'هل الشخصية فازت ببطولة رولان غاروس؟',    en:'Did the person win Roland Garros?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  boxer: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_mexican',    ar:'هل الشخصية مكسيكية؟',                    en:'Is the person Mexican?' },
    { key:'nat_filipino',   ar:'هل الشخصية فلبينية؟',                    en:'Is the person Filipino?' },
    { key:'nat_kazakh',     ar:'هل الشخصية كازاخستانية؟',                en:'Is the person Kazakh?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تتنافس حالياً؟',      en:'Is the person still competing now?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',       en:'Did the person rise to fame in the 90s?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟', en:'Did the person win Olympic gold?' },
    { key:'ach_undisputed', ar:'هل الشخصية حازت على ألقاب عالمية متعددة؟', en:'Did the person hold multiple world titles?' },
    { key:'weight_heavy',   ar:'هل الشخصية في وزن ثقيل؟',               en:'Is the person a heavyweight?' },
    { key:'weight_middle',  ar:'هل الشخصية في وزن متوسط؟',              en:'Is the person a middleweight?' },
    { key:'weight_light',   ar:'هل الشخصية في وزن خفيف؟',               en:'Is the person a lightweight?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  swimmer: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                    en:'Is the person European?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية؟',                   en:'Is the person Australian?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟', en:'Did the person win Olympic gold?' },
    { key:'ach_multi_gold', ar:'هل الشخصية فازت بأكثر من 5 ميداليات ذهبية؟', en:'Did the person win more than 5 Olympic golds?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تسبح حالياً؟',        en:'Is the person still competing now?' },
    { key:'style_freestyle',ar:'هل تسبح الشخصية الحرة؟',                 en:'Does the person swim freestyle?' },
    { key:'style_butterfly',ar:'هل تسبح الشخصية الفراشة؟',               en:'Does the person swim butterfly?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  athlete_athletics: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_jamaican',   ar:'هل الشخصية جامايكية؟',                   en:'Is the person Jamaican?' },
    { key:'nat_kenyan',     ar:'هل الشخصية كينية؟',                      en:'Is the person Kenyan?' },
    { key:'nat_ethiopian',  ar:'هل الشخصية إثيوبية؟',                    en:'Is the person Ethiopian?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'event_sprint',   ar:'هل الشخصية عداءة سريعة (100م/200م)؟',   en:'Is the person a sprinter (100m/200m)?' },
    { key:'event_marathon', ar:'هل الشخصية تجري الماراثون؟',             en:'Is the person a marathon runner?' },
    { key:'event_jump',     ar:'هل الشخصية رياضية قفز (عال/طويل)؟',     en:'Is the person a jumper (high/long jump)?' },
    { key:'ach_olympics',   ar:'هل الشخصية فازت بميدالية أولمبية ذهبية؟', en:'Did the person win Olympic gold?' },
    { key:'ach_world_rec',  ar:'هل الشخصية تحمل رقماً قياسياً عالمياً؟', en:'Does the person hold a world record?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تتنافس حالياً؟',      en:'Is the person still competing?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  actor: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية؟',                   en:'Is the person Australian?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية؟',                      en:'Is the person Indian?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_lebanese',   ar:'هل الشخصية لبنانية؟',                    en:'Is the person Lebanese?' },
    { key:'nat_syrian',     ar:'هل الشخصية سورية؟',                      en:'Is the person Syrian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية؟',                    en:'Is the person Italian?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية؟',                    en:'Is the person Spanish?' },
    { key:'ach_oscar',      ar:'هل الشخصية فازت بجائزة أوسكار؟',         en:'Did the person win an Oscar?' },
    { key:'ach_emmy',       ar:'هل الشخصية فازت بجائزة إيمي؟',           en:'Did the person win an Emmy?' },
    { key:'work_action',    ar:'هل الشخصية تمثل في أفلام أكشن؟',         en:'Is the person known for action movies?' },
    { key:'work_superhero', ar:'هل الشخصية مثلت دور بطل/ة خارق/ة؟',    en:'Did the person play a superhero?' },
    { key:'work_tv',        ar:'هل الشخصية اشتهرت في مسلسل تلفزيوني؟',  en:'Is the person famous from a TV series?' },
    { key:'work_comedy',    ar:'هل الشخصية تمثل في أفلام كوميدية؟',      en:'Is the person known for comedy films?' },
    { key:'work_drama',     ar:'هل الشخصية تمثل في أفلام دراما؟',        en:'Is the person known for drama films?' },
    { key:'work_horror',    ar:'هل الشخصية تمثل في أفلام رعب؟',          en:'Is the person known for horror films?' },
    { key:'work_scifi',     ar:'هل الشخصية تمثل في أفلام خيال علمي؟',    en:'Is the person known for sci-fi films?' },
    { key:'work_bollywood', ar:'هل الشخصية من بوليوود؟',                 en:'Is the person from Bollywood?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تمثل حالياً؟',        en:'Is the person still acting now?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',       en:'Did the person rise to fame in the 90s?' },
    { key:'era_80s',        ar:'هل الشخصية اشتهرت في الثمانينيات؟',      en:'Did the person rise to fame in the 80s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في الألفينيات؟',       en:'Did the person rise to fame in the 2000s?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  singer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_kuwaiti',    ar:'هل الشخصية كويتية؟',                     en:'Is the person Kuwaiti?' },
    { key:'nat_emirati',    ar:'هل الشخصية إماراتية؟',                   en:'Is the person Emirati?' },
    { key:'nat_lebanese',   ar:'هل الشخصية لبنانية؟',                    en:'Is the person Lebanese?' },
    { key:'nat_moroccan',   ar:'هل الشخصية مغربية؟',                     en:'Is the person Moroccan?' },
    { key:'nat_algerian',   ar:'هل الشخصية جزائرية؟',                    en:'Is the person Algerian?' },
    { key:'nat_iraqi',      ar:'هل الشخصية عراقية؟',                     en:'Is the person Iraqi?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_latin',      ar:'هل الشخصية من أمريكا اللاتينية؟',        en:'Is the person Latin American?' },
    { key:'nat_canadian',   ar:'هل الشخصية كندية؟',                      en:'Is the person Canadian?' },
    { key:'nat_australian', ar:'هل الشخصية أسترالية؟',                   en:'Is the person Australian?' },
    { key:'nat_korean',     ar:'هل الشخصية كورية؟',                      en:'Is the person Korean?' },
    { key:'ach_grammy',     ar:'هل الشخصية فازت بجائزة غرامي؟',          en:'Did the person win a Grammy?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تغني حالياً؟',        en:'Is the person still singing now?' },
    { key:'era_90s',        ar:'هل الشخصية اشتهرت في التسعينيات؟',       en:'Did the person rise to fame in the 90s?' },
    { key:'era_80s',        ar:'هل الشخصية اشتهرت في الثمانينيات؟',      en:'Did the person rise to fame in the 80s?' },
    { key:'era_00s',        ar:'هل الشخصية اشتهرت في الألفينيات؟',       en:'Did the person rise to fame in the 2000s?' },
    { key:'style_pop',      ar:'هل الشخصية مغنية بوب؟',                  en:'Is the person a pop singer?' },
    { key:'style_band',     ar:'هل الشخصية في فرقة موسيقية؟',            en:'Is the person part of a band?' },
    { key:'style_rap',      ar:'هل الشخصية مغنية راب أو هيب هوب؟',      en:'Is the person a rapper or hip-hop artist?' },
    { key:'style_rnb',      ar:'هل الشخصية مغنية R&B؟',                 en:'Is the person an R&B singer?' },
    { key:'style_rock',     ar:'هل الشخصية مغنية روك؟',                  en:'Is the person a rock artist?' },
    { key:'style_classical',ar:'هل الشخصية مغنية كلاسيكية أو أوبرا؟',   en:'Is the person a classical or opera singer?' },
    { key:'style_tarab',    ar:'هل الشخصية مغنية طرب أصيل؟',             en:'Is the person a traditional Arabic music singer?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  director: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية؟',                    en:'Is the person Italian?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية؟',                    en:'Is the person Spanish?' },
    { key:'nat_japanese',   ar:'هل الشخصية يابانية؟',                    en:'Is the person Japanese?' },
    { key:'nat_iranian',    ar:'هل الشخصية إيرانية؟',                    en:'Is the person Iranian?' },
    { key:'ach_oscar',      ar:'هل الشخصية فازت بأوسكار أفضل مخرج/ة؟',  en:'Did the person win Best Director Oscar?' },
    { key:'ach_palme',      ar:'هل الشخصية فازت بالسعفة الذهبية في كان؟', en:"Did the person win the Palme d'Or at Cannes?" },
    { key:'work_action',    ar:'هل الشخصية تخرج أفلام أكشن؟',            en:'Is the person known for action/thriller films?' },
    { key:'work_scifi',     ar:'هل الشخصية تخرج أفلام خيال علمي؟',       en:'Is the person known for sci-fi films?' },
    { key:'work_horror',    ar:'هل الشخصية تخرج أفلام رعب؟',             en:'Is the person known for horror films?' },
    { key:'work_animation', ar:'هل الشخصية تخرج أفلام رسوم متحركة؟',    en:'Is the person known for animated films?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال تخرج حالياً؟',        en:'Is the person still directing now?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  comedian: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'work_tv',        ar:'هل الشخصية اشتهرت في برنامج تلفزيوني؟',  en:'Is the person famous from a TV show?' },
    { key:'work_standup',   ar:'هل الشخصية تقدم ستاند أب كوميدي؟',       en:'Is the person a stand-up comedian?' },
    { key:'work_movies',    ar:'هل الشخصية تمثل في أفلام كوميدية؟',      en:'Is the person known for comedy films?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال نشطة حالياً؟',        en:'Is the person still active now?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  politician: [
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية؟',                      en:'Is the person Russian?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_turkish',    ar:'هل الشخصية تركية؟',                      en:'Is the person Turkish?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية؟',                    en:'Is the person German?' },
    { key:'nat_chinese',    ar:'هل الشخصية صينية؟',                      en:'Is the person Chinese?' },
    { key:'nat_israeli',    ar:'هل الشخصية إسرائيلية؟',                  en:'Is the person Israeli?' },
    { key:'nat_iranian',    ar:'هل الشخصية إيرانية؟',                    en:'Is the person Iranian?' },
    { key:'nat_iraqi',      ar:'هل الشخصية عراقية؟',                     en:'Is the person Iraqi?' },
    { key:'role_president', ar:'هل الشخصية كانت رئيس/ة دولة؟',          en:'Did the person serve as a country president?' },
    { key:'role_king',      ar:'هل الشخصية ملك/ملكة أو أمير/أميرة؟',    en:'Is the person a king, queen, or prince?' },
    { key:'role_minister',  ar:'هل الشخصية كانت وزيراً أو رئيس وزراء؟', en:'Was the person a prime minister or minister?' },
    { key:'role_general',   ar:'هل الشخصية قائد/ة عسكري/ة؟',            en:'Is the person a military leader?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال في منصبها حالياً؟',   en:'Is the person still in office now?' },
    { key:'historical',     ar:'هل الشخصية تاريخية قديمة؟',              en:'Is it an ancient historical figure?' },
    { key:'pol_war',        ar:'هل الشخصية قادت بلاداً في حرب كبرى؟',    en:'Did the person lead a country during a major war?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  scientist: [
    { key:'historical',     ar:'هل الشخصية تاريخية (قبل 1950م)؟',        en:'Is it a historical figure (before 1950)?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية؟',                    en:'Is the person German?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_polish',     ar:'هل الشخصية بولندية؟',                    en:'Is the person Polish?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_chinese',    ar:'هل الشخصية صينية؟',                      en:'Is the person Chinese?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية؟',                      en:'Is the person Indian?' },
    { key:'nat_italian',    ar:'هل الشخصية إيطالية؟',                    en:'Is the person Italian?' },
    { key:'ach_nobel',      ar:'هل الشخصية فازت بجائزة نوبل؟',           en:'Did the person win a Nobel Prize?' },
    { key:'field_physics',  ar:'هل الشخصية متخصصة في الفيزياء؟',         en:'Is the person known for physics?' },
    { key:'field_chemistry',ar:'هل الشخصية متخصصة في الكيمياء؟',         en:'Is the person known for chemistry?' },
    { key:'field_biology',  ar:'هل الشخصية متخصصة في علم الأحياء؟',      en:'Is the person known for biology?' },
    { key:'field_medicine', ar:'هل الشخصية متخصصة في الطب؟',             en:'Is the person known for medicine?' },
    { key:'field_tech',     ar:'هل الشخصية متخصصة في التكنولوجيا؟',      en:'Is the person known for technology?' },
    { key:'field_math',     ar:'هل الشخصية متخصصة في الرياضيات؟',        en:'Is the person known for mathematics?' },
    { key:'field_astro',    ar:'هل الشخصية متخصصة في الفلك أو الفضاء؟',  en:'Is the person known for astronomy or space?' },
    { key:'work_inventor',  ar:'هل الشخصية اخترعت شيئاً مشهوراً؟',       en:'Did the person invent something famous?' },
    { key:'work_discovery', ar:'هل الشخصية اكتشفت شيئاً علمياً مهماً؟', en:'Did the person make a major scientific discovery?' },
  ],

  business: [
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_chinese',    ar:'هل الشخصية صينية؟',                      en:'Is the person Chinese?' },
    { key:'nat_indian',     ar:'هل الشخصية هندية؟',                      en:'Is the person Indian?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_german',     ar:'هل الشخصية ألمانية؟',                    en:'Is the person German?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_emirati',    ar:'هل الشخصية إماراتية؟',                   en:'Is the person Emirati?' },
    { key:'field_tech',     ar:'هل الشخصية في مجال التكنولوجيا؟',        en:'Is the person in the tech industry?' },
    { key:'field_media',    ar:'هل الشخصية في مجال الإعلام؟',            en:'Is the person in the media industry?' },
    { key:'field_finance',  ar:'هل الشخصية في مجال المال والتمويل؟',     en:'Is the person in finance/banking?' },
    { key:'field_retail',   ar:'هل الشخصية في مجال التجارة والبيع؟',     en:'Is the person in retail/commerce?' },
    { key:'ach_billionaire',ar:'هل الشخصية مليارديرة؟',                  en:'Is the person a billionaire?' },
    { key:'ach_world_richest',ar:'هل الشخصية من أغنى الناس في العالم؟',  en:"Is the person among the world's richest?" },
    { key:'era_active',     ar:'هل الشخصية لا تزال نشطة حالياً؟',        en:'Is the person still active now?' },
    { key:'work_founder',   ar:'هل الشخصية مؤسسة شركة كبرى؟',           en:'Is the person a founder of a major company?' },
    { key:'historical',     ar:'هل الشخصية تاريخية؟',                    en:'Is it a historical figure?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  royalty: [
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_european',   ar:'هل الشخصية أوروبية؟',                    en:'Is the person European?' },
    { key:'nat_saudi',      ar:'هل الشخصية سعودية؟',                     en:'Is the person Saudi?' },
    { key:'nat_emirati',    ar:'هل الشخصية إماراتية؟',                   en:'Is the person Emirati?' },
    { key:'nat_moroccan',   ar:'هل الشخصية مغربية؟',                     en:'Is the person Moroccan?' },
    { key:'nat_jordanian',  ar:'هل الشخصية أردنية؟',                     en:'Is the person Jordanian?' },
    { key:'era_active',     ar:'هل الشخصية لا تزال في منصبها؟',          en:'Is the person still in power?' },
    { key:'role_king',      ar:'هل الشخصية ملك/ملكة؟',                   en:'Is the person a king or queen?' },
    { key:'role_prince',    ar:'هل الشخصية أمير/أميرة؟',                 en:'Is the person a prince or princess?' },
    { key:'historical',     ar:'هل الشخصية تاريخية قديمة؟',              en:'Is it a historical royal figure?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  writer: [
    { key:'nat_arab',       ar:'هل الشخصية عربية؟',                      en:'Is the person Arab?' },
    { key:'nat_british',    ar:'هل الشخصية بريطانية؟',                   en:'Is the person British?' },
    { key:'nat_american',   ar:'هل الشخصية أمريكية؟',                    en:'Is the person American?' },
    { key:'nat_french',     ar:'هل الشخصية فرنسية؟',                     en:'Is the person French?' },
    { key:'nat_russian',    ar:'هل الشخصية روسية؟',                      en:'Is the person Russian?' },
    { key:'nat_egyptian',   ar:'هل الشخصية مصرية؟',                      en:'Is the person Egyptian?' },
    { key:'nat_colombian',  ar:'هل الشخصية كولومبية؟',                   en:'Is the person Colombian?' },
    { key:'nat_spanish',    ar:'هل الشخصية إسبانية؟',                    en:'Is the person Spanish?' },
    { key:'nat_japanese',   ar:'هل الشخصية يابانية؟',                    en:'Is the person Japanese?' },
    { key:'type_novelist',  ar:'هل الشخصية روائية (تكتب روايات)؟',       en:'Is the person a novelist?' },
    { key:'type_poet',      ar:'هل الشخصية شاعر/ة؟',                     en:'Is the person a poet?' },
    { key:'type_playwright',ar:'هل الشخصية كاتبة مسرحيات؟',             en:'Is the person a playwright?' },
    { key:'type_journalist',ar:'هل الشخصية صحفية أو مراسلة؟',           en:'Is the person a journalist?' },
    { key:'ach_nobel',      ar:'هل الشخصية فازت بنوبل للأدب؟',           en:'Did the person win the Nobel Prize in Literature?' },
    { key:'ach_booker',     ar:'هل الشخصية فازت بجائزة بوكر؟',           en:'Did the person win the Booker Prize?' },
    { key:'historical',     ar:'هل الشخصية تاريخية؟',                    en:'Is it a historical figure?' },
    { key:'alive',          ar:'هل الشخصية لا تزال على قيد الحياة؟',     en:'Is the person still alive?' },
  ],

  fictional: [
    { key:'fic_superhero',  ar:'هل الشخصية بطل/ة خارق/ة؟',              en:'Is it a superhero?' },
    { key:'fic_villain',    ar:'هل الشخصية الشرير/ة الرئيسي/ة؟',        en:'Is it a main villain?' },
    { key:'fic_marvel',     ar:'هل الشخصية من عالم مارفل؟',              en:'Is it from Marvel?' },
    { key:'fic_dc',         ar:'هل الشخصية من عالم DC؟',                 en:'Is it from DC Comics?' },
    { key:'fic_disney',     ar:'هل الشخصية من ديزني؟',                   en:'Is it from Disney?' },
    { key:'fic_anime',      ar:'هل الشخصية من أنيمي ياباني؟',            en:'Is it from a Japanese anime?' },
    { key:'fic_movie',      ar:'هل الشخصية من فيلم سينمائي؟',            en:'Is it from a movie?' },
    { key:'fic_series',     ar:'هل الشخصية من مسلسل تلفزيوني؟',          en:'Is it from a TV series?' },
    { key:'fic_game',       ar:'هل الشخصية من لعبة فيديو؟',              en:'Is it from a video game?' },
    { key:'fic_book',       ar:'هل الشخصية من رواية أو كتاب؟',           en:'Is it from a novel or book?' },
    { key:'fic_fly',        ar:'هل تستطيع الشخصية الطيران؟',             en:'Can it fly?' },
    { key:'fic_powers',     ar:'هل تمتلك الشخصية قوى خارقة؟',           en:'Does it have superpowers?' },
    { key:'fic_human',      ar:'هل الشخصية بشرية؟',                      en:'Is it human?' },
    { key:'fic_robot',      ar:'هل الشخصية آلية أو روبوت؟',              en:'Is it a robot or AI?' },
    { key:'fic_animal',     ar:'هل الشخصية حيوان أو مخلوق؟',            en:'Is it an animal or creature?' },
    { key:'fic_pixar',      ar:'هل الشخصية من بيكسار؟',                  en:'Is it from Pixar?' },
    { key:'fic_netflix',    ar:'هل الشخصية من مسلسل نتفليكس مشهور؟',    en:'Is it from a famous Netflix series?' },
    { key:'male',           ar:'هل الشخصية من الجنس الذكوري؟',           en:'Is it male?' },
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
  // Shuffle broad questions so the first question changes every game
  const broadOrder = shuffle(Q.broad.map(q => q.key));
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
    broadOrder,
    cycleCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATE UPDATE
// ─────────────────────────────────────────────────────────────────────────────
function applyAnswer(session, key, answer) {
  const yes = answer === 'yes';
  const no  = answer === 'no';

  if (yes) session.facts[key] = true;
  if (no)  session.facts[key] = false;

  if (!session.domain) {
    if (key === 'athlete'     && yes) session.domain = 'athlete';
    if (key === 'entertainer' && yes) session.domain = 'entertainer';
    if (key === 'politician'  && yes) session.domain = 'politician';
    if (key === 'scientist'   && yes) session.domain = 'scientist';
    if (key === 'business'    && yes) session.domain = 'business';
    if (key === 'royalty'     && yes) session.domain = 'royalty';
    if (key === 'writer'      && yes) session.domain = 'writer';
    if (key === 'fictional'   && yes) session.domain = 'fictional';
  }

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
//  NEXT QUESTION SELECTOR (static bank first)
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
    // Use shuffled broad order for varied first question each game
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
//  AI QUESTION GENERATOR — when static bank is exhausted
// ─────────────────────────────────────────────────────────────────────────────
async function generateAIQuestion(session) {
  if (!openai) return null;

  const ar = session.language === 'ar';
  const domain = session.subDomain ?? session.domain ?? 'general';
  const askedList = Array.from(session.askedKeys).join(', ');
  const factsStr  = factsSummary(session);

  const systemPrompt = ar
    ? `أنت محقق بارع في لعبة التخمين. مهمتك توليد سؤال واحد ذكي يساعد في تضييق نطاق الشخصية.
قواعد صارمة:
- السؤال يجب أن يكون بالعربية فقط
- السؤال يجب أن يكون ذا صلة بمجال: ${domain}
- لا تكرر هذه الأسئلة: [${askedList}]
- الحقائق المعروفة حتى الآن: ${factsStr}
- السؤال يجب أن يقلص القائمة المحتملة للشخصيات
- استخدم صيغة الجنسين: مثل "هل الشخصية مصري/ة؟" أو "هل الشخصية فازت بـ...؟"
- أجب بـ JSON فقط: {"key":"ai_q_1","text":"سؤالك هنا"}`
    : `You are a clever detective in a guessing game. Generate ONE smart yes/no question to narrow down the character.
Strict rules:
- Question must be in English only
- Question must be relevant to domain: ${domain}
- Do NOT repeat these question keys: [${askedList}]
- Known facts so far: ${factsStr}
- Question should eliminate candidates effectively
- Reply with JSON only: {"key":"ai_q_1","text":"Your question here"}`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      max_tokens: 120,
      messages: [{ role: 'system', content: systemPrompt }],
    });
    const raw = resp.choices?.[0]?.message?.content ?? '';
    const m   = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj  = JSON.parse(m[0]);
    const text = String(obj.text ?? '').trim();
    const key  = `ai_${Date.now()}`;
    if (!text) return null;
    return { key, text };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHOULD ASK FILTER
// ─────────────────────────────────────────────────────────────────────────────
function shouldAsk(key, session) {
  const f = session.facts;

  const nationKeys = [
    'nat_arab','nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian','nat_dutch',
    'nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin','nat_egyptian',
    'nat_saudi','nat_kuwaiti','nat_emirati','nat_moroccan','nat_algerian','nat_lebanese',
    'nat_iraqi','nat_syrian','nat_turkish','nat_chinese','nat_indian','nat_japanese',
    'nat_korean','nat_iranian','nat_israeli','nat_jordanian','nat_mexican','nat_filipino',
    'nat_kazakh','nat_colombian','nat_polish','nat_jamaican','nat_kenyan',
    'nat_ethiopian','nat_african','nat_canadian','nat_s_american','nat_european',
    'nat_croatian','nat_belgian',
  ];
  const knownNat = nationKeys.find(k => f[k] === true);
  if (knownNat && nationKeys.includes(key) && key !== knownNat) return false;

  if (f['nat_arab'] === true && ['nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian',
    'nat_dutch','nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin',
    'nat_chinese','nat_japanese','nat_korean','nat_indian','nat_turkish'].includes(key)) return false;
  if (f['nat_arab'] === false && ['nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati',
    'nat_moroccan','nat_algerian','nat_lebanese','nat_iraqi','nat_syrian','nat_jordanian'].includes(key)) return false;
  if (f['nat_s_american'] === true && ['nat_french','nat_spanish','nat_british','nat_german',
    'nat_italian','nat_dutch','nat_russian'].includes(key)) return false;
  if (f['nat_european'] === true && ['nat_american','nat_arab','nat_latin','nat_chinese',
    'nat_japanese','nat_korean','nat_indian'].includes(key)) return false;

  const sportKeys = ['sport_football','sport_basketball','sport_tennis','sport_boxing',
    'sport_swimming','sport_golf','sport_athletics','sport_cycling','sport_mma','sport_other'];
  const knownSport = sportKeys.find(k => f[k] === true);
  if (knownSport && sportKeys.includes(key) && key !== knownSport) return false;

  const entKeys = ['ent_actor','ent_singer','ent_director','ent_comedian','ent_presenter','ent_model','ent_producer'];
  const knownEnt = entKeys.find(k => f[k] === true);
  if (knownEnt && entKeys.includes(key) && key !== knownEnt) return false;

  if (f['alive'] === true  && key === 'historical') return false;
  if (f['alive'] === false && key === 'era_active')  return false;
  if (f['historical'] === true && key === 'era_active') return false;

  if (f['era_active'] === true && ['era_90s','era_80s','era_00s','era_10s'].includes(key)) return false;
  if (f['era_90s']    === true && ['era_80s','era_00s','era_10s'].includes(key)) return false;
  if (f['era_80s']    === true && ['era_90s','era_00s','era_10s'].includes(key)) return false;

  if (f['real'] === true && ['fictional','fic_marvel','fic_dc','fic_disney','fic_anime',
    'fic_superhero','fic_villain','fic_fly','fic_powers','fic_game','fic_movie',
    'fic_human','fic_robot','fic_animal','fic_pixar','fic_netflix','fic_series','fic_book'].includes(key)) return false;
  if (f['fictional'] === true && ['real','athlete','entertainer','politician','scientist',
    'business','royalty','writer'].includes(key)) return false;

  if (f['fic_marvel'] === true  && ['fic_dc','fic_disney','fic_anime','fic_pixar'].includes(key)) return false;
  if (f['fic_dc']     === true  && ['fic_marvel','fic_disney','fic_anime','fic_pixar'].includes(key)) return false;
  if (f['fic_disney'] === true  && ['fic_marvel','fic_dc','fic_anime'].includes(key)) return false;
  if (f['fic_anime']  === true  && ['fic_marvel','fic_dc','fic_disney','fic_pixar'].includes(key)) return false;

  const domainKeys = ['athlete','entertainer','politician','scientist','business','royalty','writer','fictional'];
  const knownDomain = domainKeys.find(k => f[k] === true);
  if (knownDomain && domainKeys.includes(key) && key !== knownDomain) return false;

  const weightKeys = ['weight_heavy','weight_middle','weight_light'];
  if (!session.subDomain && weightKeys.includes(key)) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FACTS SUMMARY for GPT guess prompt
// ─────────────────────────────────────────────────────────────────────────────
function factsSummary(session) {
  const f = session.facts;
  const parts = [];
  const add = (cond, label) => { if (cond) parts.push(label); };

  add(session.subDomain,                      `sub-domain: ${session.subDomain}`);
  add(session.domain && !session.subDomain,   `domain: ${session.domain}`);
  add(f.male    === true,  'male');
  add(f.male    === false, 'female');
  add(f.alive   === true,  'alive');
  add(f.alive   === false, 'deceased');
  add(f.historical === true, 'historical figure');
  add(f.nat_arab === true,      'Arab');
  add(f.nat_american === true,  'American');
  add(f.nat_british === true,   'British');
  add(f.nat_french === true,    'French');
  add(f.nat_spanish === true,   'Spanish');
  add(f.nat_portuguese === true,'Portuguese');
  add(f.nat_argentine === true, 'Argentine');
  add(f.nat_brazilian === true, 'Brazilian');
  add(f.nat_german === true,    'German');
  add(f.nat_italian === true,   'Italian');
  add(f.nat_russian === true,   'Russian');
  add(f.nat_australian === true,'Australian');
  add(f.nat_swiss === true,     'Swiss');
  add(f.nat_serbian === true,   'Serbian');
  add(f.nat_latin === true,     'Latin American');
  add(f.nat_egyptian === true,  'Egyptian');
  add(f.nat_saudi === true,     'Saudi');
  add(f.nat_kuwaiti === true,   'Kuwaiti');
  add(f.nat_emirati === true,   'Emirati');
  add(f.nat_moroccan === true,  'Moroccan');
  add(f.nat_algerian === true,  'Algerian');
  add(f.nat_lebanese === true,  'Lebanese');
  add(f.nat_iraqi === true,     'Iraqi');
  add(f.nat_turkish === true,   'Turkish');
  add(f.nat_chinese === true,   'Chinese');
  add(f.nat_indian === true,    'Indian');
  add(f.nat_japanese === true,  'Japanese');
  add(f.nat_korean === true,    'Korean');
  add(f.nat_iranian === true,   'Iranian');
  add(f.nat_mexican === true,   'Mexican');
  add(f.nat_canadian === true,  'Canadian');
  add(f.nat_jamaican === true,  'Jamaican');
  add(f.nat_kenyan === true,    'Kenyan');
  add(f.nat_ethiopian === true, 'Ethiopian');
  add(f.ach_worldcup === true,  'won World Cup');
  add(f.ach_ballondor === true, "won Ballon d'Or");
  add(f.ach_ucl === true,       'won Champions League');
  add(f.ach_oscar === true,     'won Oscar');
  add(f.ach_emmy === true,      'won Emmy');
  add(f.ach_grammy === true,    'won Grammy');
  add(f.ach_nobel === true,     'won Nobel Prize');
  add(f.ach_olympics === true,  'won Olympic medal');
  add(f.ach_grandslam === true, 'won Grand Slam');
  add(f.ach_nba_champ === true, 'won NBA Championship');
  add(f.ach_mvp === true,       'won MVP');
  add(f.ach_afcon === true,     'won Africa Cup');
  add(f.ach_euro === true,      'won Euros');
  add(f.ach_billionaire === true,'billionaire');
  add(f.era_active === true,    'still active now');
  add(f.era_90s === true,       'rose to fame in 90s');
  add(f.era_80s === true,       'rose to fame in 80s');
  add(f.era_00s === true,       'rose to fame in 2000s');
  add(f.era_10s === true,       'rose to fame in 2010s');
  add(f.nat_s_american === true,'South American');
  add(f.nat_european === true,  'European');
  add(f.pos_striker === true,   'striker/forward');
  add(f.pos_goalkeeper === true,'goalkeeper');
  add(f.pos_midfielder === true,'midfielder');
  add(f.pos_defender === true,  'defender');
  add(f.club_real === true,     'played for Real Madrid');
  add(f.club_barca === true,    'played for Barcelona');
  add(f.club_manu === true,     'played for Man United');
  add(f.club_liver === true,    'played for Liverpool');
  add(f.club_city === true,     'played for Man City');
  add(f.club_chelsea === true,  'played for Chelsea');
  add(f.club_juve === true,     'played for Juventus');
  add(f.club_psg === true,      'played for PSG');
  add(f.club_alnassr === true,  'plays for Al-Nassr');
  add(f.work_action === true,   'known for action movies/films');
  add(f.work_superhero === true,'played superhero role');
  add(f.work_tv === true,       'famous from TV show/series');
  add(f.work_comedy === true,   'known for comedy');
  add(f.work_drama === true,    'known for drama');
  add(f.work_horror === true,   'known for horror');
  add(f.work_scifi === true,    'known for sci-fi');
  add(f.work_standup === true,  'stand-up comedian');
  add(f.work_founder === true,  'company founder');
  add(f.style_pop === true,     'pop singer');
  add(f.style_band === true,    'part of a band');
  add(f.style_rap === true,     'rapper');
  add(f.style_rnb === true,     'R&B singer');
  add(f.style_rock === true,    'rock artist');
  add(f.style_tarab === true,   'traditional Arabic singer');
  add(f.fic_marvel === true,    'from Marvel');
  add(f.fic_dc === true,        'from DC');
  add(f.fic_disney === true,    'from Disney');
  add(f.fic_anime === true,     'from anime');
  add(f.fic_superhero === true, 'superhero');
  add(f.fic_villain === true,   'villain');
  add(f.fic_fly === true,       'can fly');
  add(f.fic_powers === true,    'has superpowers');
  add(f.fic_game === true,      'from a video game');
  add(f.fic_robot === true,     'robot/AI character');
  add(f.fic_animal === true,    'animal/creature character');
  add(f.field_physics === true,   'physics');
  add(f.field_chemistry === true, 'chemistry');
  add(f.field_biology === true,   'biology');
  add(f.field_medicine === true,  'medicine');
  add(f.field_tech === true,      'technology');
  add(f.field_math === true,      'mathematics');
  add(f.field_astro === true,     'astronomy/space');
  add(f.weight_heavy === true,    'heavyweight boxer');
  add(f.role_president === true,  'served as president/head of state');
  add(f.role_king === true,       'king/queen/prince');
  add(f.role_minister === true,   'prime minister or minister');
  add(f.role_general === true,    'military leader');
  add(f.type_novelist === true,   'novelist');
  add(f.type_poet === true,       'poet');
  add(f.type_playwright === true, 'playwright');

  const allNatKeys = [
    'nat_arab','nat_american','nat_british','nat_french','nat_spanish',
    'nat_portuguese','nat_argentine','nat_brazilian','nat_german','nat_italian',
    'nat_dutch','nat_russian','nat_australian','nat_swiss','nat_serbian','nat_latin',
    'nat_egyptian','nat_saudi','nat_kuwaiti','nat_emirati','nat_moroccan','nat_algerian',
    'nat_lebanese','nat_iraqi','nat_turkish','nat_chinese','nat_indian','nat_japanese','nat_korean',
  ];
  const noNats = allNatKeys.filter(k => f[k] === false).map(k => k.replace('nat_',''));
  if (noNats.length) parts.push(`NOT: ${noNats.join(', ')}`);

  return parts.join(' | ') || 'no confirmed facts yet';
}

// ─────────────────────────────────────────────────────────────────────────────
//  WIKIPEDIA — fetch photo + bio (with English fallback for image)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWiki(name, lang) {
  const primaryLang = lang === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(String(name).replace(/ /g, '_'));

  async function fetchFromLang(l) {
    const res = await fetch(
      `https://${l}.wikipedia.org/api/rest_v1/page/summary/${title}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error(`${l} wiki not found`);
    return res.json();
  }

  try {
    let j = await fetchFromLang(primaryLang);
    let imageURL = j.thumbnail?.source ?? null;

    if (!imageURL && primaryLang === 'ar') {
      try {
        const enJ = await fetchFromLang('en');
        imageURL = enJ.thumbnail?.source ?? null;
      } catch { /* ignore */ }
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
      } catch { /* both failed */ }
    }
    return {
      title:      name,
      extract:    lang === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL:   null,
      articleURL: `https://${primaryLang}.wikipedia.org/wiki/${title}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSE JSON from AI response safely (no response_format dependency)
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
//  GPT GUESS — uses GPT ONLY for the final name
// ─────────────────────────────────────────────────────────────────────────────
async function makeGuess(session) {
  const ar = session.language === 'ar';
  const fallback = {
    type: 'guess',
    name: ar ? 'شخصية غير معروفة' : 'Unknown character',
    confidence: 0.2,
    wiki: null,
  };

  if (!openai) {
    console.error('makeGuess: openai not configured');
    return fallback;
  }

  const summary  = factsSummary(session);
  const rejected = session.rejectedGuesses;
  const qa = session.turns.map((t, i) => `Q${i + 1}: ${t.question} → ${t.answer}`).join('\n');

  const system = ar
    ? `أنت خبير في تحديد الشخصيات. بناءً على الحقائق المؤكدة، خمّن الشخصية الأكثر احتمالاً.
قواعد صارمة:
- اسم واحد فقط كما هو معروف (مثال: "محمد صلاح"، "فيروز"، "رونالدو")
- لا تكرر هذه الأسماء: [${rejected.join(', ') || 'لا شيء'}]
- أجب بـ JSON فقط بدون أي نص إضافي: {"name":"...","confidence":0.9}`
    : `You are a character identification expert. Based ONLY on confirmed facts, name the single most likely character.
Strict rules:
- Full name as commonly known (e.g. "Lionel Messi", "Tom Hanks", "Iron Man")
- NEVER repeat: [${rejected.join(', ') || 'none'}]
- Respond with JSON ONLY, no other text: {"name":"...","confidence":0.9}`;

  const user = `Confirmed facts: ${summary}
Full Q&A:
${qa || 'none yet'}
Rejected guesses: ${rejected.join(', ') || 'none'}
Output your single best guess as JSON now.`;

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      max_tokens: 100,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content ?? '';
    console.log('makeGuess raw response:', raw);

    const parsed = parseGuessJSON(raw);
    if (!parsed) {
      console.error('makeGuess: failed to parse JSON from:', raw);
      return fallback;
    }

    const { name, confidence } = parsed;
    if (rejected.map(r => r.toLowerCase()).includes(name.toLowerCase())) {
      console.log('makeGuess: rejected name returned again:', name);
      return fallback;
    }

    const wiki = await fetchWiki(name, session.language);
    console.log('makeGuess: guessed', name, '| imageURL:', wiki?.imageURL ?? 'none');

    return { type: 'guess', name, confidence, wiki };
  } catch (e) {
    console.error('makeGuess error:', e?.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────
async function runEngine(session) {
  const { questionsThisPhase: qCount, minQ, maxQ } = session;

  if (qCount >= maxQ) {
    return makeGuess(session);
  }

  if (qCount < minQ) {
    // Try static question first
    const q = nextQuestion(session);
    if (q) {
      session.pendingKey = q.key;
      return { type: 'question', text: q.text };
    }
    // Static bank exhausted — use AI question generator
    const aiQ = await generateAIQuestion(session);
    if (aiQ) {
      session.pendingKey = aiQ.key;
      return { type: 'question', text: aiQ.text };
    }
    return makeGuess(session);
  }

  const q = nextQuestion(session);
  if (!q) {
    const aiQ = await generateAIQuestion(session);
    if (aiQ) {
      session.pendingKey = aiQ.key;
      return { type: 'question', text: aiQ.text };
    }
    return makeGuess(session);
  }

  const f = session.facts;
  const readyToGuess = session.subDomain
    && (f.nat_arab === true || f.nat_american === true || f.nat_british === true ||
        f.nat_french === true || f.nat_portuguese === true || f.nat_argentine === true ||
        f.nat_brazilian === true || f.nat_spanish === true || f.nat_german === true ||
        f.nat_egyptian === true || f.nat_saudi === true || f.nat_kuwaiti === true ||
        f.nat_emirati === true || f.nat_australian === true || f.nat_russian === true ||
        f.nat_moroccan === true || f.nat_algerian === true || f.nat_lebanese === true ||
        f.nat_jamaican === true || f.nat_kenyan === true)
    && (f.ach_worldcup === true || f.ach_ballondor === true || f.ach_ucl === true ||
        f.ach_oscar === true || f.ach_grammy === true || f.ach_nobel === true ||
        f.ach_olympics === true || f.ach_grandslam === true || f.ach_nba_champ === true ||
        f.era_active != null || f.era_90s != null || f.era_80s != null || f.era_00s != null);

  if (readyToGuess && qCount >= minQ) {
    return makeGuess(session);
  }

  session.pendingKey = q.key;
  return { type: 'question', text: q.text };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, hasOpenAI: Boolean(openai) });
});

// POST /api/game/start
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session = newSession(language);
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('start:', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// POST /api/start  (alias)
app.post('/api/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();
    const session = newSession(language);
    sessions.set(sessionId, session);
    const result = await runEngine(session);
    return res.json({ sessionId, ...result });
  } catch (e) {
    console.error('start:', e);
    return res.status(500).json({ error: 'Failed to start game' });
  }
});

// POST /api/game/answer
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

    applyAnswer(session, key, normAnswer);

    return res.json(await runEngine(session));
  } catch (e) {
    console.error('answer:', e);
    return res.status(500).json({ error: 'Failed to process answer' });
  }
});

// POST /api/next  (alias)
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
      session.turns.push({ key, question: String(question ?? session.pendingKey ?? ''), answer: normAnswer });
      session.questionsThisPhase += 1;
      applyAnswer(session, key, normAnswer);
    }

    const result = await runEngine(session);
    return res.json({ result });
  } catch (e) {
    console.error('next:', e);
    return res.status(500).json({ error: 'Failed to process' });
  }
});

// POST /api/game/guess-confirm
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (correct) {
      const wiki = await fetchWiki(String(guessName ?? ''), session.language);
      return res.json({ type: 'revealed', guessName, wiki });
    }

    if (guessName) session.rejectedGuesses.push(String(guessName));
    session.guessStreak += 1;

    if (session.guessStreak < MAX_GUESSES) {
      return res.json(await makeGuess(session));
    }

    // All 3 guesses exhausted — go back to more questions in the same domain
    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;
    session.cycleCount += 1;

    return res.json(await runEngine(session));
  } catch (e) {
    console.error('guess-confirm:', e);
    return res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

// POST /api/guess-result  (alias)
app.post('/api/guess-result', async (req, res) => {
  try {
    const { sessionId, correct, guessedName } = req.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.expiresAt = Date.now() + SESSION_TTL;

    if (correct) {
      const wiki = await fetchWiki(String(guessedName ?? ''), session.language);
      sessions.delete(sessionId);
      return res.json({ ok: true, won: true, wiki });
    }

    const name = String(guessedName || '').trim();
    if (name && !session.rejectedGuesses.includes(name)) session.rejectedGuesses.push(name);
    session.guessStreak += 1;

    if (session.guessStreak >= MAX_GUESSES) {
      // Continue with more questions in same domain
      session.guessStreak = 0;
      session.questionsThisPhase = 0;
      session.minQ = FOLLOWUP_MIN;
      session.maxQ = FOLLOWUP_MAX;
      session.cycleCount += 1;
      return res.json({ ok: true, won: false, gaveUp: false, continuePlaying: true });
    }

    session.guessStreak = 0;
    session.questionsThisPhase = 0;
    session.minQ = FOLLOWUP_MIN;
    session.maxQ = FOLLOWUP_MAX;

    return res.json({ ok: true, won: false, gaveUp: false });
  } catch (e) {
    console.error('guess-result:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/wiki?name=...&language=ar|en
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name ?? '');
    const lang = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name is required' });
    return res.json(await fetchWiki(name, lang));
  } catch (e) {
    console.error('wiki:', e);
    return res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// GET /api/session/:id  (debug)
app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    sessionId:          req.params.id,
    language:           s.language,
    turns:              s.turns.length,
    domain:             s.domain,
    subDomain:          s.subDomain,
    rejectedGuesses:    s.rejectedGuesses,
    guessStreak:        s.guessStreak,
    questionsThisPhase: s.questionsThisPhase,
    phase:              { min: s.minQ, max: s.maxQ },
    cycleCount:         s.cycleCount,
    facts:              s.facts,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Magic Ball server → port ${PORT}`);
  console.log(`Model: ${MODEL} | OpenAI: ${Boolean(openai)}`);
  console.log(`Phase 1: ${INITIAL_MIN}–${INITIAL_MAX} questions | Phase 2: ${FOLLOWUP_MIN}–${FOLLOWUP_MAX}`);
});