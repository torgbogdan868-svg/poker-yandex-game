/**
 * poker-engine.js
 * Покерный движок: работа с колодой, оценка комбинаций, определение победителя.
 * Все функции — чистые (без побочных эффектов), экспортируются через window.PokerEngine.
 */

(function(global) {
  'use strict';

  // ─── Константы ───────────────────────────────────────────────────────────────

  const SUITS = ['♠', '♥', '♦', '♣'];          // масти
  const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

  // Названия комбинаций
  const HAND_NAMES = {
    0: 'Старшая карта',
    1: 'Пара',
    2: 'Две пары',
    3: 'Тройка',
    4: 'Стрит',
    5: 'Флеш',
    6: 'Фул-хаус',
    7: 'Каре',
    8: 'Стрит-флеш',
    9: 'Флеш-рояль'
  };

  // ─── Работа с колодой ─────────────────────────────────────────────────────────

  /** Создаёт и возвращает перемешанную колоду из 52 карт */
  function createDeck() {
    const deck = [];
    for (let s = 0; s < 4; s++) {
      for (let r = 0; r < 13; r++) {
        deck.push({
          suit: SUITS[s],
          suitName: SUIT_NAMES[s],
          rank: RANKS[r],
          value: RANK_VALUES[RANKS[r]],
          id: `${RANKS[r]}_${SUIT_NAMES[s]}`
        });
      }
    }
    return shuffle(deck);
  }

  /** Перемешивает массив методом Фишера–Йейтса */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ─── Оценка комбинаций ────────────────────────────────────────────────────────

  /**
   * Оценивает лучшую из 5-карточных комбинаций из переданных карт (7 или меньше).
   * Возвращает объект { rank, name, cards, kickers, score }
   */
  function evaluateHand(cards) {
    if (!cards || cards.length < 2) return { rank: -1, name: 'Нет карт', cards: [], score: 0 };

    // Генерируем все комбинации из 5 карт
    const combos = combinations(cards, Math.min(5, cards.length));
    let best = null;

    for (const combo of combos) {
      const result = evaluate5(combo);
      if (!best || result.score > best.score) {
        best = result;
      }
    }
    return best;
  }

  /** Все комбинации k элементов из массива arr */
  function combinations(arr, k) {
    if (k === arr.length) return [arr];
    if (k === 1) return arr.map(x => [x]);
    const result = [];
    for (let i = 0; i <= arr.length - k; i++) {
      const rest = combinations(arr.slice(i + 1), k - 1);
      for (const combo of rest) result.push([arr[i], ...combo]);
    }
    return result;
  }

  /**
   * Оценивает ровно 5 карт.
   * Возвращает { rank, name, cards, kickers, score }
   * score — числовое значение для сравнения рук (чем больше, тем лучше).
   */
  function evaluate5(cards) {
    const values = cards.map(c => c.value).sort((a, b) => b - a);
    const suits  = cards.map(c => c.suit);

    const isFlush    = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);
    const counts     = countValues(values);   // { value: count }

    // Группируем по количеству вхождений
    const groups = Object.entries(counts)
      .map(([v, c]) => ({ value: Number(v), count: c }))
      .sort((a, b) => b.count - a.count || b.value - a.value);

    let rank, name, score;

    // Royal Flush
    if (isFlush && isStraight && values[0] === 14 && values[4] === 10) {
      rank = 9; name = HAND_NAMES[9];
      score = computeScore(rank, values);
    }
    // Straight Flush
    else if (isFlush && isStraight) {
      rank = 8; name = HAND_NAMES[8];
      score = computeScore(rank, values);
    }
    // Four of a Kind
    else if (groups[0].count === 4) {
      rank = 7; name = HAND_NAMES[7];
      score = computeScore(rank, [groups[0].value, groups[1].value]);
    }
    // Full House
    else if (groups[0].count === 3 && groups[1].count === 2) {
      rank = 6; name = HAND_NAMES[6];
      score = computeScore(rank, [groups[0].value, groups[1].value]);
    }
    // Flush
    else if (isFlush) {
      rank = 5; name = HAND_NAMES[5];
      score = computeScore(rank, values);
    }
    // Straight
    else if (isStraight) {
      rank = 4; name = HAND_NAMES[4];
      score = computeScore(rank, values);
    }
    // Three of a Kind
    else if (groups[0].count === 3) {
      rank = 3; name = HAND_NAMES[3];
      const kickers = groups.slice(1).map(g => g.value);
      score = computeScore(rank, [groups[0].value, ...kickers]);
    }
    // Two Pair
    else if (groups[0].count === 2 && groups[1].count === 2) {
      rank = 2; name = HAND_NAMES[2];
      const kicker = groups[2] ? groups[2].value : 0;
      score = computeScore(rank, [groups[0].value, groups[1].value, kicker]);
    }
    // One Pair
    else if (groups[0].count === 2) {
      rank = 1; name = HAND_NAMES[1];
      const kickers = groups.slice(1).map(g => g.value);
      score = computeScore(rank, [groups[0].value, ...kickers]);
    }
    // High Card
    else {
      rank = 0; name = HAND_NAMES[0];
      score = computeScore(rank, values);
    }

    return { rank, name, cards, kickers: values, score };
  }

  /** Проверяет наличие стрита (включая «колесо» A-2-3-4-5) */
  function checkStraight(sortedValues) {
    // Обычный стрит
    const unique = [...new Set(sortedValues)];
    if (unique.length < 5) return false;

    const top5 = unique.slice(0, 5);
    if (top5[0] - top5[4] === 4) return true;

    // «Колесо» A-2-3-4-5
    if (unique.includes(14)) {
      const wheel = unique.filter(v => v <= 5);
      if (wheel.length >= 4 && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2)) {
        return true;
      }
    }
    return false;
  }

  /** Подсчитывает вхождения каждого значения */
  function countValues(values) {
    return values.reduce((acc, v) => {
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * Вычисляет числовой score для сравнения рук.
   * Rank занимает старшие позиции, затем идут значения карт.
   */
  function computeScore(rank, values) {
    // Максимум 5 значений, каждое 0–14, упаковываем в число
    let score = rank * (15 ** 6);
    for (let i = 0; i < values.length && i < 5; i++) {
      score += values[i] * (15 ** (4 - i));
    }
    return score;
  }

  // ─── Сравнение рук ────────────────────────────────────────────────────────────

  /**
   * Сравнивает два результата evaluateHand.
   * Возвращает 1 если handA лучше, -1 если handB лучше, 0 при ничье.
   */
  function compareHands(handA, handB) {
    if (handA.score > handB.score) return 1;
    if (handA.score < handB.score) return -1;
    return 0;
  }

  /**
   * Определяет победителей среди массива игроков.
   * players: [{ id, holeCards, communityCards }]
   * Возвращает массив победителей (может быть несколько при ничье).
   */
  function determineWinners(players, communityCards) {
    const evaluated = players.map(p => {
      const allCards = [...(p.holeCards || []), ...(communityCards || [])];
      const hand = evaluateHand(allCards);
      return { ...p, hand };
    });

    evaluated.sort((a, b) => compareHands(b.hand, a.hand));

    const bestScore = evaluated[0].hand.score;
    const winners = evaluated.filter(p => p.hand.score === bestScore);
    return { winners, evaluated };
  }

  // ─── Оценка силы руки (0–1) для ИИ ─────────────────────────────────────────

  /**
   * Оценивает «силу» руки в диапазоне 0..1.
   * Используется ИИ для принятия решений.
   */
  function handStrength(holeCards, communityCards) {
    const allCards = [...(holeCards || []), ...(communityCards || [])];
    const hand = evaluateHand(allCards);

    // Нормализуем rank 0..9 → 0..1, с поправкой на кикеры
    const baseStrength = hand.rank / 9;
    const kickerBonus  = (hand.kickers[0] || 2) / 14 * 0.05;

    // Дополнительная оценка на пре-флопе (только 2 карты)
    if (communityCards.length === 0) {
      return preFlopStrength(holeCards);
    }

    return Math.min(1, baseStrength + kickerBonus);
  }

  /** Упрощённая оценка силы карманных карт до флопа */
  function preFlopStrength(holeCards) {
    if (!holeCards || holeCards.length < 2) return 0.1;
    const [a, b] = holeCards.map(c => c.value).sort((x, y) => y - x);
    const sameSuit = holeCards[0].suit === holeCards[1].suit;
    const isPair   = a === b;
    const gap      = a - b;

    let strength = 0;

    if (isPair) {
      // Пары: от 0.5 (двойки) до 0.95 (тузы)
      strength = 0.5 + (a - 2) / 12 * 0.45;
    } else {
      // Непарные: базовое значение по старшей карте
      strength = 0.1 + (a - 2) / 12 * 0.35;
      // Бонус за малый разрыв (коннекторы)
      if (gap <= 1) strength += 0.08;
      else if (gap <= 2) strength += 0.04;
      // Бонус за одномастность
      if (sameSuit) strength += 0.07;
      // Бонус за туза
      if (a === 14) strength += 0.08;
      // Бонус за туза + король
      if (a === 14 && b === 13) strength += 0.05;
    }

    return Math.min(0.98, strength);
  }

  // ─── Публичный API ─────────────────────────────────────────────────────────────

  global.PokerEngine = {
    createDeck,
    shuffle,
    evaluateHand,
    compareHands,
    determineWinners,
    handStrength,
    preFlopStrength,
    HAND_NAMES,
    RANKS,
    SUITS,
    RANK_VALUES
  };

})(window);
