// Быстрая локальная оценка тональности без внешнего API.
const POSITIVE = new Set('любовь любимый успех успешный выигрыш выиграл рост выросла выросло выросли прибыль прибыльный польза полезный лучший лучше отличн отличн добр полож позитив поддерж поддержал поддержка соглас согласен рад радует радость побед победа достиж достижение открыл открыла открыло развив развитие улучш улучшил улучшение безопас безопасн качествен качество рекоменд рекомендует довер доверие благодар благодарность'.split(' '));
const NEGATIVE = new Set('проблем проблемн убыт убыток потер потеря пад падение сниз сниж ухудш ухудшил ухудшение плох плохо худш худший ошиб ошибк скандал кризис кризисн риск опас опасн угроз угроза авар авария ущерб вред вредн жалоб жалоба конфликт конфлик недоволь недовольн отказ отказал провал провальн банкрот банкротство мошен мошеннич обман обманул наруш нарушен штраф санкц критик критика негативн смерть погиб погибл больн'.split(' '));

function stemToken(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 12);
}

function scoreText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u).map(stemToken).filter(Boolean)
    .reduce((score, token) => {
      const match = set => [...set].some(word => token.startsWith(word));
      return score + (match(POSITIVE) ? 1 : match(NEGATIVE) ? -1 : 0);
    }, 0);
}

function classifySentiment(value) {
  const score = scoreText(value);
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

function sentimentLabel(value) {
  return { positive: 'Положительная', neutral: 'Нейтральная', negative: 'Отрицательная' }[value] || 'Нейтральная';
}

module.exports = { classifySentiment, sentimentLabel, scoreText };
