const SCENES = Object.freeze([
  'ambient',
  'whisper',
  'tease',
  'contact',
  'rhythm',
  'surge',
  'afterglow',
]);

const DIMENSIONS = Object.freeze([
  'intensity',
  'intimacy',
  'breath',
  'motion',
  'tension',
  'tenderness',
  'dominance',
  'climax',
]);

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function fnv1a(source) {
  let hash = 0x811c9dc5;
  const text = String(source ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── Heuristic fallback (deprecated, disabled by default) ────────
//
// The previous LEXICON-based keyword matching has been explicitly
// rejected by the user as insufficient for true content understanding.
// It is preserved here only as a disabled fallback. The site should
// read from cloud v2 profiles instead.
//
// To enable: set window.__ENABLE_HEURISTIC_FALLBACK = true
// The UI will display "未分析" when heuristic fallback is active.

const LEXICON = Object.freeze({
  breath: [
    ['耳边', 0.34], ['耳朵', 0.28], ['轻声', 0.3], ['低声', 0.28],
    ['悄悄', 0.24], ['呼吸', 0.38], ['吐息', 0.4], ['喘息', 0.34],
    ['气息', 0.3], ['呢喃', 0.34], ['耳语', 0.46], ['囁き', 0.46],
    ['息', 0.12], ['喘', 0.3], ['呼', 0.16], ['ふー', 0.28],
    ['はぁ', 0.25],
  ],
  intimacy: [
    ['贴近', 0.3], ['靠近', 0.24], ['耳边', 0.28], ['抱', 0.2],
    ['亲吻', 0.34], ['接吻', 0.36], ['吻', 0.18], ['触碰', 0.24],
    ['抚摸', 0.28], ['温度', 0.14], ['身体', 0.14], ['里面', 0.12],
    ['深处', 0.18], ['肌肤', 0.2], ['唇', 0.2], ['舌', 0.2],
    ['嘴', 0.14], ['胸', 0.12], ['乳', 0.15], ['耳', 0.12],
    ['手指', 0.14],
    ['キス', 0.34], ['そば', 0.18],
  ],
  motion: [
    ['继续', 0.16], ['不停', 0.26], ['不要停', 0.34], ['反复', 0.32],
    ['节奏', 0.36], ['速度', 0.26], ['加快', 0.38], ['越来越快', 0.48],
    ['更快', 0.32], ['慢一点', 0.18], ['快', 0.14], ['慢', 0.1],
    ['停', 0.12], ['动', 0.12], ['摇', 0.18], ['顶', 0.18],
    ['插', 0.22], ['抽', 0.2], ['撞', 0.18], ['蹭', 0.18],
    ['进', 0.08], ['出', 0.08],
    ['进出', 0.3], ['抽动', 0.34], ['摩擦', 0.26], ['持续', 0.22],
    ['快点', 0.24], ['再来', 0.2], ['一下', 0.08],
    ['繰り返', 0.34], ['もっと', 0.18], ['速く', 0.36],
  ],
  intensity: [
    ['强烈', 0.34], ['用力', 0.3], ['更深', 0.24], ['受不了', 0.32],
    ['忍不住', 0.28], ['极限', 0.42], ['顶点', 0.44], ['完全', 0.12],
    ['快要', 0.2], ['马上', 0.18], ['激烈', 0.36], ['狠狠', 0.3],
    ['满', 0.12], ['不行', 0.18], ['いっぱい', 0.24],
    ['限界', 0.42], ['激しく', 0.36],
  ],
  tension: [
    ['不安', 0.3], ['害怕', 0.34], ['紧张', 0.34], ['担心', 0.24],
    ['犹豫', 0.26], ['不可以', 0.2], ['不能', 0.16], ['秘密', 0.2],
    ['发现', 0.12], ['看着', 0.12], ['嫉妒', 0.36], ['背叛', 0.38],
    ['痛', 0.2], ['讨厌', 0.24], ['やめ', 0.2], ['怖', 0.32],
  ],
  tenderness: [
    ['温柔', 0.4], ['轻轻', 0.28], ['慢慢', 0.22], ['没关系', 0.34],
    ['放心', 0.28], ['安抚', 0.42], ['休息', 0.34], ['平静', 0.4],
    ['抱着', 0.26], ['喜欢', 0.2], ['爱', 0.18], ['辛苦', 0.2],
    ['乖', 0.16], ['结束了', 0.3], ['好了', 0.14], ['谢谢', 0.18],
    ['睡', 0.2], ['大丈夫', 0.34], ['優しく', 0.4],
  ],
  dominance: [
    ['听话', 0.3], ['命令', 0.4], ['不许', 0.32], ['必须', 0.28],
    ['给我', 0.2], ['照做', 0.32], ['忍住', 0.26], ['别动', 0.34],
    ['看着我', 0.3], ['回答', 0.18], ['说出来', 0.24], ['服从', 0.42],
    ['言うこと', 0.3], ['動くな', 0.36], ['命令', 0.4],
  ],
  climax: [
    ['顶点', 0.54], ['极限', 0.34], ['释放', 0.46], ['爆发', 0.44],
    ['到达', 0.2], ['结束', 0.18], ['最后', 0.16], ['出来', 0.16],
    ['高潮', 0.54], ['射', 0.28], ['精', 0.12], ['去了', 0.16],
    ['要来', 0.28], ['要到了', 0.34], ['出来了', 0.26],
    ['絶頂', 0.54], ['出る', 0.24], ['いく', 0.28],
  ],
  contact: [
    ['抚摸', 0.34], ['触碰', 0.32], ['亲吻', 0.38], ['接吻', 0.4],
    ['舔', 0.3], ['吸', 0.16], ['含', 0.24], ['揉', 0.28],
    ['摸', 0.16], ['按', 0.18],
    ['抱', 0.2], ['贴', 0.18], ['碰', 0.18], ['キス', 0.4],
    ['触', 0.22], ['舐', 0.3],
  ],
  tease: [
    ['逗', 0.3], ['捉弄', 0.36], ['故意', 0.24], ['想要', 0.2],
    ['请求', 0.22], ['说出来', 0.28], ['害羞', 0.22], ['可爱', 0.2],
    ['怎么样', 0.16], ['是不是', 0.14], ['求我', 0.34], ['焦急', 0.22],
    ['じら', 0.38], ['欲しい', 0.24], ['お願い', 0.22],
  ],
});

function occurrenceScore(text, entries) {
  let score = 0;
  for (const [token, weight] of entries) {
    let offset = 0;
    while (offset < text.length) {
      const found = text.indexOf(token, offset);
      if (found === -1) break;
      score += weight;
      offset = found + Math.max(1, token.length);
    }
  }
  return clamp01(score);
}

function classifyScene(values, support) {
  if (
    values.tenderness >= 0.38
    && values.intensity < 0.55
    && values.motion < 0.5
  ) return 'afterglow';
  if (values.climax >= 0.52 || (
    values.climax >= 0.36 && values.intensity >= 0.55
  )) return 'surge';
  if (values.motion >= 0.28 && values.intensity >= 0.24) return 'rhythm';
  if (
    values.breath >= 0.32
    && values.intimacy >= 0.18
    && values.motion < 0.4
    && values.intensity < 0.62
  ) return 'whisper';
  if (support.contact >= 0.16 || (
    values.intimacy >= 0.38 && values.motion < 0.58
  )) return 'contact';
  if (
    support.tease >= 0.16
    || values.dominance >= 0.26
    || (values.tension >= 0.28 && values.intensity < 0.62)
  ) return 'tease';
  return 'ambient';
}

function analyzeCueMeaning(source) {
  const text = String(source ?? '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const support = {
    contact: occurrenceScore(text, LEXICON.contact),
    tease: occurrenceScore(text, LEXICON.tease),
  };
  const exclamation = Math.min(0.24, (text.match(/[!！]/g)?.length ?? 0) * 0.06);
  const ellipsis = Math.min(
    0.24,
    (text.match(/[…。．.]{2,}/g)?.length ?? 0) * 0.06,
  );
  const elongation = Math.min(
    0.2,
    (text.match(/[ー～~…]{2,}/gu)?.length ?? 0) * 0.05,
  );
  const question = Math.min(0.14, (text.match(/[?？]/g)?.length ?? 0) * 0.04);
  const compact = text.replace(/[\s【】\p{P}\p{S}\d]/gu, '');
  const vocalCount = (
    compact.match(/[啊阿呀嗯唔呜哈呵哦噢哎诶哼嘶呼啦]/g) ?? []
  ).length;
  const vocalization = compact.length > 0
    ? clamp01(
      vocalCount / Math.max(2, compact.length) * 2.2
      + Math.min(0.6, vocalCount * 0.12),
    )
    : 0;
  const repeatedPulse = Math.min(
    0.4,
    (
      text.match(
        /([啊呀嗯唔呜哈哦噢哎诶哼嘶])(?:[、,，…~～ー\s]*\1){1,}/gu,
      )?.length ?? 0
    ) * 0.18,
  );
  const intensity = clamp01(
    0.08
    + occurrenceScore(text, LEXICON.intensity) * 0.72
    + occurrenceScore(text, LEXICON.motion) * 0.5
    + exclamation
    + elongation
    + vocalization * 0.22
    + repeatedPulse * 0.34,
  );
  const values = {
    intensity,
    intimacy: clamp01(
      occurrenceScore(text, LEXICON.intimacy)
      + support.contact * 0.24
      + vocalization * 0.38,
    ),
    breath: clamp01(
      occurrenceScore(text, LEXICON.breath)
      + vocalization * 0.58
      + ellipsis * 0.32,
    ),
    motion: clamp01(
      occurrenceScore(text, LEXICON.motion)
      + exclamation * 0.22
      + repeatedPulse * 0.72,
    ),
    tension: clamp01(
      occurrenceScore(text, LEXICON.tension)
      + question
      + exclamation * 0.16,
    ),
    tenderness: occurrenceScore(text, LEXICON.tenderness),
    dominance: occurrenceScore(text, LEXICON.dominance),
    climax: clamp01(
      occurrenceScore(text, LEXICON.climax)
      + Math.max(0, intensity - 0.72) * 0.35
      + vocalization * intensity * 0.22,
    ),
  };
  return {
    ...values,
    scene: classifyScene(values, support),
  };
}

function dominantSide(segments) {
  const sides = new Set(
    (segments ?? [])
      .map((segment) => segment.side)
      .filter((side) => side === 'left' || side === 'right'),
  );
  return sides.size === 1 ? [...sides][0] : 'center';
}

function averageMeanings(meanings) {
  const result = Object.fromEntries(DIMENSIONS.map((dimension) => [
    dimension,
    0,
  ]));
  if (meanings.length === 0) return result;
  for (const dimension of DIMENSIONS) {
    const values = meanings.map((meaning) => meaning[dimension]);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    result[dimension] = average;
  }
  return result;
}

function sceneForVector(vector, meanings) {
  const support = {
    contact: meanings.some((meaning) => meaning.scene === 'contact') ? 0.4 : 0,
    tease: meanings.some((meaning) => meaning.scene === 'tease') ? 0.4 : 0,
  };
  return classifyScene(vector, support);
}

function rounded(value) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function profileEntry(cue) {
  const meanings = (cue.segments ?? []).map((segment) => (
    analyzeCueMeaning(segment.text)
  ));
  const vector = averageMeanings(meanings);
  const result = {
    start: Math.max(0, Number(cue.start) || 0),
    end: Math.max(0, Number(cue.end) || 0),
    scene: sceneForVector(vector, meanings),
    side: dominantSide(cue.segments),
  };
  for (const dimension of DIMENSIONS) result[dimension] = rounded(vector[dimension]);
  return result;
}

function smoothEntries(entries) {
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    const next = entries[index + 1];
    const smoothed = { ...entry };
    for (const dimension of DIMENSIONS) {
      const neighbors = [previous?.[dimension], next?.[dimension]]
        .filter(Number.isFinite);
      const context = neighbors.length
        ? neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length
        : entry[dimension];
      smoothed[dimension] = rounded(entry[dimension] * 0.82 + context * 0.18);
    }
    const originalScene = entry.scene;
    smoothed.scene = classifyScene(smoothed, {
      contact: originalScene === 'contact' ? 0.4 : 0,
      tease: originalScene === 'tease' ? 0.4 : 0,
    });
    return smoothed;
  });
}

function mergeEntries(entries) {
  const merged = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.scene === entry.scene
      && previous.side === entry.side
      && entry.start - previous.end <= 0.25
    ) {
      const previousDuration = Math.max(0.001, previous.end - previous.start);
      const entryDuration = Math.max(0.001, entry.end - entry.start);
      const total = previousDuration + entryDuration;
      for (const dimension of DIMENSIONS) {
        previous[dimension] = rounded(
          (previous[dimension] * previousDuration
            + entry[dimension] * entryDuration) / total,
        );
      }
      previous.end = Math.max(previous.end, entry.end);
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

export function buildSemanticProfile(cues) {
  const entries = smoothEntries((cues ?? [])
    .filter((cue) => Number(cue.end) > Number(cue.start))
    .map(profileEntry));
  const timeline = mergeEntries(entries);
  const aggregate = Object.fromEntries(DIMENSIONS.map((dimension) => {
    if (entries.length === 0) return [dimension, 0];
    return [
      dimension,
      rounded(entries.reduce((sum, entry) => sum + entry[dimension], 0)
        / entries.length),
    ];
  }));
  return {
    version: 1,
    fingerprint: cueFingerprint(cues),
    cueCount: entries.length,
    duration: Math.max(0, ...entries.map((entry) => entry.end)),
    aggregate,
    timeline,
  };
}

// Disabled by default. Only used if window.__ENABLE_HEURISTIC_FALLBACK is true.
export function heuristicFallback(cues) {
  const enabled = (typeof window !== 'undefined' && window.__ENABLE_HEURISTIC_FALLBACK);
  if (!enabled) {
    return {
      version: 1,
      fingerprint: cueFingerprint(cues),
      cueCount: 0,
      duration: 0,
      aggregate: Object.fromEntries(DIMENSIONS.map((d) => [d, 0])),
      timeline: [],
    };
  }
  return buildSemanticProfile(cues);
}

// ── Core query functions (used by cloud v2 and heuristic) ──────────

const AMBIENT_FRAME = Object.freeze({
  start: 0,
  end: 0,
  scene: 'ambient',
  side: 'center',
  intensity: 0.08,
  intimacy: 0,
  breath: 0.12,
  motion: 0.05,
  tension: 0,
  tenderness: 0.12,
  dominance: 0,
  climax: 0,
});

export function semanticFrameAt(timeline, time) {
  const target = Math.max(0, Number(time) || 0);
  const entries = Array.isArray(timeline) ? timeline : [];
  const sceneWeight = {
    ambient: 0,
    afterglow: 0.4,
    whisper: 0.5,
    tease: 0.55,
    contact: 0.6,
    rhythm: 0.8,
    surge: 1.2,
  };
  let selected = null;
  let selectedScore = -1;
  for (const entry of entries) {
    if (entry.start > target) break;
    if (target >= entry.end) continue;
    const score = (sceneWeight[entry.scene] ?? 0)
      + entry.intensity
      + entry.climax * 1.8
      + entry.motion * 0.45
      + entry.breath * 0.25;
    if (score > selectedScore) {
      selected = entry;
      selectedScore = score;
    }
  }
  return selected ?? AMBIENT_FRAME;
}

export function trackProfileKey(workId, trackId) {
  return fnv1a(`${workId}\u0000${trackId}`);
}

export function cueFingerprint(cues) {
  return fnv1a((cues ?? []).map((cue) => (
    `${cue.start}|${cue.end}|${(cue.segments ?? [])
      .map((segment) => `${segment.side}:${segment.text}`)
      .join('\u001f')}`
  )).join('\u001e'));
}

export function selectVisualReference(references, profileKey) {
  if (!Array.isArray(references) || references.length === 0) return null;
  const numeric = Number.parseInt(String(profileKey).slice(0, 8), 16);
  const index = Number.isFinite(numeric) ? numeric % references.length : 0;
  return references[index];
}

export { DIMENSIONS, SCENES };
