// word-prompts.js — memory-joggers so contributors never face a blank box.
// Every prompt is about the celebration person; "{name}" is interpolated with
// the honoree's name (falls back to "בעלת השמחה"). Pure data + helpers.

export const CATEGORIES = [
  {
    id: 'people',
    label: 'אנשים',
    emoji: '👯',
    questions: [
      'איך {name} קוראת לבן/בת הזוג?',
      'מי החברה הכי ותיקה של {name}?',
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
      'איפה {name} גדלה?',
      'לאן {name} הכי חולמת לטוס?',
      'המקום הקבוע של {name} לקפה',
      'איפה {name} הכי אוהבת לבלות בלילה?',
    ],
  },
  {
    id: 'jokes',
    label: 'בדיחות פנימיות',
    emoji: '😂',
    questions: [
      'משפט שרק אתן מבינות עם {name}',
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
      'מה {name} עושה כשהיא בלחץ?',
      'ההרגל הכי מצחיק של {name}',
      'מה {name} עושה כל בוקר בלי יוצא דופן?',
      'הדבר ש{name} שוכחת כל פעם מחדש',
    ],
  },
  {
    id: 'food',
    label: 'אוכל',
    emoji: '🍕',
    questions: [
      'המנה ש{name} מזמינה בכל מסעדה',
      'האוכל ש{name} לא נוגעת בו בחיים',
      'מה {name} מכינה הכי טוב?',
      'הפינוק האשם של {name}',
    ],
  },
  {
    id: 'work',
    label: 'עבודה ולימודים',
    emoji: '💼',
    questions: ['מה {name} עושה בעבודה?', 'מקצוע ש{name} תמיד חלמה עליו', 'הסיפור מהצבא של {name}'],
  },
  {
    id: 'childhood',
    label: 'ילדות',
    emoji: '🧸',
    questions: [
      'הצעצוע האהוב של {name} בילדות',
      'מה {name} רצתה להיות כשתהיה גדולה?',
      'הסדרה ש{name} גדלה עליה',
    ],
  },
  {
    id: 'sayings',
    label: 'ביטויים שהיא אומרת',
    emoji: '💬',
    questions: [
      'המילה ש{name} משתמשת בה יותר מדי',
      'משפט שתמיד יוצא ל{name}',
      'הקללה האהובה של {name}',
    ],
  },
  {
    id: 'culture',
    label: 'סדרות, שירים וסלבס',
    emoji: '🎬',
    questions: [
      'הסדרה ש{name} בינג׳ה לאחרונה',
      'השיר ש{name} שרה בקריוקי',
      'הסלב ש{name} מתה עליו',
    ],
  },
  {
    id: 'vacations',
    label: 'חופשות',
    emoji: '✈️',
    questions: ['הטיול הכי טוב של {name}', 'מה {name} תמיד שוכחת לארוז', 'יעד החלומות של {name}'],
  },
  {
    id: 'loves',
    label: 'אהבות וטרנדים',
    emoji: '💖',
    questions: [
      'הטרנד ש{name} נדבקה אליו',
      'חיית המחמד (או החלום) של {name}',
      'התחביב החדש של {name}',
    ],
  },
];

// Flat bank of prompts derived from the categories, each with a stable id.
export const PROMPTS = CATEGORIES.flatMap((cat) =>
  cat.questions.map((text, i) => ({ id: `${cat.id}-${i}`, cat: cat.id, text }))
);

const FALLBACK_NAME = 'בעלת השמחה';

/** Replace {name} in a prompt with the honoree name (or a gentle fallback). */
export function fillName(text, name) {
  const n = (name == null ? '' : String(name)).trim() || FALLBACK_NAME;
  return String(text == null ? '' : text).replace(/\{name\}/g, n);
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
