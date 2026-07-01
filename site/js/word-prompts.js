// word-prompts.js — memory-joggers so contributors never face a blank box.
// Every prompt is about the celebration person; "{name}" is interpolated with
// the honoree's name (falls back to "בעל/ת השמחה", gendered). Prompts also carry
// gender-aware phrasing via a "{female|male}" alternation token, resolved by
// renderQuestion(). Pure data + helpers.

export const CATEGORIES = [
  {
    id: 'people',
    label: 'אנשים',
    emoji: '👯',
    questions: [
      'איך {name} {קוראת|קורא} לבן/בת הזוג?',
      'מי {החברה|החבר} הכי {ותיקה|ותיק} של {name}?',
      'כינוי שרק במשפחה קוראים ל{name}',
      'שם של אקס מפורסם של {name}',
      'מי תמיד מצליח/ה להרגיע את {name}?',
    ],
  },
  {
    id: 'places',
    label: 'מקומות',
    emoji: '📍',
    questions: [
      'איפה {name} {גדלה|גדל}?',
      'לאן {name} הכי {חולמת|חולם} לטוס?',
      'המקום הקבוע של {name} לקפה',
      'איפה {name} הכי {אוהבת|אוהב} לבלות בלילה?',
    ],
  },
  {
    id: 'jokes',
    label: 'בדיחות פנימיות',
    emoji: '😂',
    questions: [
      'משפט שרק {אתן מבינות|אתם מבינים} עם {name}',
      'הסיפור הכי מביך של {name}',
      'בדיחה פנימית מטיול עם {name}',
      'הכינוי שנדבק ל{name} בטעות',
    ],
  },
  {
    id: 'habits',
    label: 'הרגלים וטיקים',
    emoji: '🌀',
    questions: [
      'מה {name} עושה {כשהיא|כשהוא} בלחץ?',
      'ההרגל הכי מצחיק של {name}',
      'מה {name} עושה כל בוקר בלי יוצא דופן?',
      'הדבר ש{name} {שוכחת|שוכח} כל פעם מחדש',
    ],
  },
  {
    id: 'food',
    label: 'אוכל',
    emoji: '🍕',
    questions: [
      'המנה ש{name} {מזמינה|מזמין} בכל מסעדה',
      'האוכל ש{name} לא {נוגעת|נוגע} בו בחיים',
      'מה {name} {מכינה|מכין} הכי טוב?',
      'הפינוק האשם של {name}',
    ],
  },
  {
    id: 'work',
    label: 'עבודה ולימודים',
    emoji: '💼',
    questions: [
      'מה {name} עושה בעבודה?',
      'מקצוע ש{name} תמיד {חלמה|חלם} עליו',
      'הסיפור מהצבא של {name}',
    ],
  },
  {
    id: 'childhood',
    label: 'ילדות',
    emoji: '🧸',
    questions: [
      'הצעצוע האהוב של {name} בילדות',
      'מה {name} {רצתה להיות כשתהיה גדולה|רצה להיות כשיהיה גדול}?',
      'הסדרה ש{name} {גדלה|גדל} עליה',
    ],
  },
  {
    id: 'sayings',
    label: 'ביטויים קבועים',
    emoji: '💬',
    questions: [
      'המילה ש{name} {משתמשת|משתמש} בה יותר מדי',
      'משפט שתמיד יוצא ל{name}',
      'הקללה האהובה של {name}',
    ],
  },
  {
    id: 'culture',
    label: 'סדרות, שירים וסלבס',
    emoji: '🎬',
    questions: [
      'הסדרה ש{name} {בינג׳תה|בינג׳ה} לאחרונה',
      'השיר ש{name} {שרה|שר} בקריוקי',
      'הסלב ש{name} {מתה|מת} עליו',
    ],
  },
  {
    id: 'vacations',
    label: 'חופשות',
    emoji: '✈️',
    questions: [
      'הטיול הכי טוב של {name}',
      'מה {name} תמיד {שוכחת|שוכח} לארוז',
      'יעד החלומות של {name}',
    ],
  },
  {
    id: 'loves',
    label: 'אהבות וטרנדים',
    emoji: '💖',
    questions: [
      'הטרנד ש{name} {נדבקה|נדבק} אליו',
      'חיית המחמד (או החלום) של {name}',
      'התחביב החדש של {name}',
    ],
  },
];

// Flat bank of prompts derived from the categories, each with a stable id.
export const PROMPTS = CATEGORIES.flatMap((cat) =>
  cat.questions.map((text, i) => ({ id: `${cat.id}-${i}`, cat: cat.id, text }))
);

// Extra, higher-depth memory-joggers unlocked AFTER payment. Same shape as
// PROMPTS ({id, cat, text} with {name} + {female|male} phrasing). Drawn alongside
// PROMPTS to give paying owners much more variety so they can reach 100+ words.
export const PREMIUM_PROMPTS = [
  {
    id: 'premium-0',
    cat: 'people',
    text: 'מי האדם ש{name} {מתקשרת|מתקשר} אליו ראשון כשקורה משהו?',
  },
  {
    id: 'premium-1',
    cat: 'people',
    text: 'הכינוי ש{name} {נותנת|נותן} לאנשים ש{name} {אוהבת|אוהב}',
  },
  { id: 'premium-2', cat: 'jokes', text: 'הפאדיחה של {name} שכולם עדיין מזכירים' },
  { id: 'premium-3', cat: 'jokes', text: 'מם או סרטון שמזכיר לכם מיד את {name}' },
  { id: 'premium-4', cat: 'habits', text: 'מה {name} עושה ראשון {כשהיא נכנסת|כשהוא נכנס} הביתה?' },
  { id: 'premium-5', cat: 'habits', text: 'האפליקציה ש{name} {פותחת|פותח} הכי הרבה בטלפון' },
  { id: 'premium-6', cat: 'habits', text: 'הדבר ש{name} {מתעקשת|מתעקש} עליו שמשגע את כולם' },
  { id: 'premium-7', cat: 'food', text: 'המשקה הקבוע של {name} ביציאה' },
  {
    id: 'premium-8',
    cat: 'food',
    text: 'מה {name} {מזמינה|מזמין} כשמגיע {אליה|אליו} משלוח בלילה?',
  },
  { id: 'premium-9', cat: 'work', text: 'הבוס או הקולגה ש{name} הכי {מספרת|מספר} עליו' },
  { id: 'premium-10', cat: 'culture', text: 'הסרט ש{name} {ראתה|ראה} מיליון פעם' },
  { id: 'premium-11', cat: 'culture', text: 'הזמר/ת ש{name} תמיד {שמה|שם} ברכב' },
  { id: 'premium-12', cat: 'loves', text: 'הקנייה המיותרת ש{name} הכי {גאה בה|גאה בו}' },
  { id: 'premium-13', cat: 'loves', text: 'התחביב ש{name} {התחילה ולא המשיכה|התחיל ולא המשיך}' },
  { id: 'premium-14', cat: 'places', text: 'המקום שבו {name} {מרגישה|מרגיש} הכי בבית' },
  { id: 'premium-15', cat: 'vacations', text: 'הסיפור מהטיול שתמיד עולה כש{name} {מספרת|מספר}' },
  { id: 'premium-16', cat: 'sayings', text: 'המשפט ש{name} {שולחת|שולח} בוואטסאפ כל הזמן' },
  { id: 'premium-17', cat: 'childhood', text: 'הזיכרון מבית הספר ש{name} הכי {אוהבת|אוהב} לספר' },
];

const FALLBACK_NAME = 'בעלת השמחה';
const FALLBACK_NAME_MALE = 'בעל השמחה';

/** Replace {name} in a prompt with the honoree name (or a gentle fallback). */
export function fillName(text, name) {
  const n = (name == null ? '' : String(name)).trim() || FALLBACK_NAME;
  // Function replacement so the name is inserted LITERALLY — a name containing
  // $&, $`, $', or $$ must not be treated as a special replacement pattern.
  return String(text == null ? '' : text).replace(/\{name\}/g, () => n);
}

/**
 * Render a question with gender-aware phrasing.
 * - `{name}` → the honoree name, or a gendered fallback
 *   ('בעלת השמחה' for female / 'בעל השמחה' for male).
 * - `{female|male}` → the first form when gender is 'female' (the DEFAULT when
 *   gender is null/undefined/anything-not-'male'), the second when 'male'.
 * @param {string} text
 * @param {string} [name]
 * @param {('female'|'male'|null)} [gender] defaults to feminine phrasing
 * @returns {string}
 */
export function renderQuestion(text, name, gender) {
  const male = gender === 'male';
  const fallback = male ? FALLBACK_NAME_MALE : FALLBACK_NAME;
  const n = (name == null ? '' : String(name)).trim() || fallback;
  return (
    String(text == null ? '' : text)
      .replace(/\{([^{}|]*)\|([^{}]*)\}/g, (_, f, m) => (male ? m : f))
      // Function replacement so the name is inserted LITERALLY — a name containing
      // $&, $`, $', or $$ must not be treated as a special replacement pattern.
      .replace(/\{name\}/g, () => n)
  );
}

/**
 * Pick the next prompt, avoiding ids in `seenIds` (recent prompts) so it doesn't
 * immediately repeat. When all prompts have been seen, it resets and picks any.
 * @param {string[]} seenIds
 * @param {() => number} [rng] injectable for tests; defaults to Math.random
 * @returns {{id:string, cat:string, text:string}}
 */
export function nextPrompt(seenIds = [], rng = Math.random) {
  const seen = new Set(seenIds);
  let pool = PROMPTS.filter((p) => !seen.has(p.id));
  if (pool.length === 0) pool = PROMPTS;
  return pool[Math.floor(rng() * pool.length)];
}
