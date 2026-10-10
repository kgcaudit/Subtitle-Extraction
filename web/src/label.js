// 트랙을 사람 말로 적는다 — 언어 이름과 자막 종류 표시.
//
// 화면에 'ko', 'en' 같은 코드만 있으면 무엇을 뽑는지 알 수가 없다. 특히 영어
// 자막이 다섯 개씩 들어 있는 파일에서는 코드만으로 고를 수가 없다.

/**
 * 브라우저가 가진 언어 이름표를 쓴다.
 *
 * `Intl.DisplayNames` 는 두 글자(ko) · 세 글자(kor) 코드는 물론 서지용 코드
 * (ger·fre·chi 처럼 deu·fra·zho 와 다른 옛 표기. 마트로스카가 실제로 쓴다)와
 * 지역·문자까지 붙은 BCP 47 태그(pt-BR, zh-Hans)도 받아 준다. 실제로 재어 보고
 * 확인했다 — 180여 개 언어를 손으로 적어 둘 이유가 없다.
 */
let displayNames = null;
function namer() {
  if (displayNames === null) {
    try {
      displayNames = new Intl.DisplayNames(['ko'], { type: 'language', fallback: 'none' });
    } catch {
      displayNames = false;   // 아주 오래된 브라우저
    }
  }
  return displayNames || null;
}

/**
 * 이름표가 모르는 코드들.
 *
 * `und`·`mul`·`zxx` 는 언어가 아니라 '언어를 밝히지 않음' 같은 표시라
 * 이름이 없고, `tib`(티베트어 서지용)는 이름표에 빠져 있다. 서지용/전문용이
 * 갈리는 20개 언어를 다 재어 보고 빠진 것은 이것 하나였다.
 */
const SPECIAL = {
  und: '언어 미지정',
  mis: '분류되지 않은 언어',
  mul: '여러 언어',
  zxx: '언어 없음',
  tib: '티베트어',
  bod: '티베트어',
};

/** 언어 코드를 우리말 이름으로. 모르는 코드는 코드 그대로 돌려준다. */
export function languageName(code) {
  const tag = (code || '').trim();
  if (!tag) return SPECIAL.und;
  const special = SPECIAL[tag.toLowerCase()];
  if (special) return special;
  try {
    return namer()?.of(tag) || tag;
  } catch {
    return tag;   // 코드 모양이 아니면 Intl 이 던진다
  }
}

/**
 * 자막 종류 표시.
 *
 * 마트로스카가 트랙마다 달아 두는 표시들이다(실제 mkvmerge 가 쓴 파일에서
 * 요소 번호를 확인했다). 파일에 적혀 있는 것만 보여 준다 — 이름에 'SDH' 라고
 * 적혀 있다고 짐작해서 붙이지는 않는다. 짐작이 틀리면 엉뚱한 자막을 뽑게 된다.
 * 대신 트랙에 붙은 이름은 그대로 함께 보여 준다.
 */
const BADGES = [
  ['forced', '강제'],
  ['hearingImpaired', '청각장애인용'],
  ['visualImpaired', '시각장애인용'],
  ['textDescriptions', '화면 해설'],
  ['commentary', '코멘터리'],
  ['original', '원어'],
  ['default', '기본'],
];

export function trackBadges(track, { showDefault = true } = {}) {
  return BADGES
    .filter(([key]) => track?.[key] && (key !== 'default' || showDefault))
    .map(([, text]) => text);
}

/**
 * '기본' 을 보여 줄 만한가.
 *
 * 마트로스카는 FlagDefault 가 없으면 1 로 친다. mkvmerge 는 이 요소를 아예 쓰지
 * 않기도 해서, 그런 파일은 모든 트랙이 '기본' 이 된다. 전부에 붙는 표시는
 * 아무것도 가려 주지 못하므로 그때는 빼는 게 낫다.
 */
export function defaultIsMeaningful(tracks) {
  return tracks.some((track) => track.default) && tracks.some((track) => !track.default);
}

/** 목록 한 줄의 머리글: `#0 한국어 · SubRip` */
export function trackHeadline(track, formatName) {
  return `#${track.subtitleIndex} ${languageName(track.language)} · ${formatName}`;
}
