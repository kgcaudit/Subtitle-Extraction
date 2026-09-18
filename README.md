# subex — 영상 자막 추출기

영상 파일 안에 들어 있는 **자막 트랙을 SRT 파일로** 뽑아냅니다.
자막이 이미지(PGS·VobSub)로 들어 있으면 **OCR 로 글자로 바꿔서** SRT 를 만듭니다.
글자 줄마다 잘라 읽고, 기울어진 글자는 바로 세우며, 노래 자막의 음표(♪)는
그림에서 찾아 되살립니다.

```
$ subex movie.mkv
movie.mkv
  트랙 #0  eng  SubRip
    -> movie.eng.srt  (872줄, 0.1초)
  트랙 #1  ko  VobSub (DVD 이미지 자막)  [default]
    이미지 준비 1578/1578 (100%)
    OCR(글자 줄) 2518/2518 (100%)
    -> movie.ko.srt  (1577줄, 48.5초)

완료: 2개 성공
```

> OCR 은 자막 덩이가 아니라 **글자 줄** 단위로 셉니다. 자막 1,578개가 글자 줄
> 2,518개로 갈린 것이라, 마지막의 `1577줄`(자막 수)과 수가 다릅니다.

## 무엇을 하고, 무엇을 못 하나

| 영상 안의 자막 상태 | 처리 | 결과 |
|---|---|---|
| 텍스트 자막 (SubRip, ASS/SSA, mov_text, WebVTT …) | ffmpeg 로 변환 | ✅ SRT (거의 즉시) |
| **PGS** 이미지 자막 (Blu-ray, mkv) | 비트맵 복원 → OCR | ✅ SRT |
| **VobSub** 이미지 자막 (DVD, `.idx`/`.sub`) | 비트맵 복원 → OCR | ✅ SRT |
| DVB 자막 / 텔레텍스트 | — | ❌ 미지원 (트랙 목록에 표시만) |
| 화면에 새겨진 자막 (번인/하드섭) | — | ❌ 범위 밖 |
| 자막 없이 음성만 | — | ❌ 범위 밖 (음성인식이 필요) |

컨테이너는 ffmpeg 가 읽을 수 있으면 무엇이든 됩니다 — mkv, mp4, mov, avi, ts, webm,
그리고 `.sup`·`.idx`/`.sub` 파일 자체를 바로 넣어도 됩니다.

## 설치

### 1. 외부 프로그램

| | ffmpeg (필수) | tesseract (이미지 자막일 때만) |
|---|---|---|
| Windows | `winget install Gyan.FFmpeg` | `winget install UB-Mannheim.TesseractOCR` |
| macOS | `brew install ffmpeg` | `brew install tesseract tesseract-lang` |
| Ubuntu/Debian | `sudo apt install ffmpeg` | `sudo apt install tesseract-ocr tesseract-ocr-kor` |

텍스트 자막만 뽑을 거라면 tesseract 는 필요 없습니다.

### 2. subex

```bash
pip install .
```

파이썬 쪽 의존성은 **Pillow 하나**뿐입니다. 설치하지 않고 바로 쓰려면:

```bash
pip install pillow
python -m subex movie.mkv
```

## 사용법

```bash
subex movie.mkv                      # 자막 트랙을 전부 SRT 로
subex movie.mkv --list               # 어떤 자막이 들어 있는지만 확인
subex movie.mkv -t 1 -o korean.srt   # 1번 트랙만 지정한 이름으로
subex *.mkv --lang kor               # 여러 파일에서 한국어 트랙만
subex movie.mkv --encoding cp949     # 구형 플레이어용 인코딩
subex bluray.sup --ocr-lang kor      # .sup 파일을 바로
```

기본 출력 이름은 `<영상이름>.<언어>.srt` 이고, 강제자막·청각장애인용 트랙은
`movie.kor.forced.srt` 처럼 꼬리표가 붙습니다.

### 옵션

| 옵션 | 설명 |
|---|---|
| `--list` | 자막 트랙 목록만 보여주고 끝낸다 |
| `-t, --track N` | 추출할 트랙 번호(`--list` 의 `#` 값). 여러 번 지정 가능 |
| `--lang CODE` | 해당 언어 트랙만 (`kor`, `eng` …) |
| `-o, --output FILE` | 출력 파일 (트랙 하나일 때) |
| `--outdir DIR` | 출력 폴더 |
| `--ocr-lang LANGS` | OCR 언어. 기본 `kor+eng` |
| `--psm N` | Tesseract 페이지 분할 모드. 기본 `7` (자막을 줄마다 따로 넣으므로 '한 줄') |
| `--line-height N` | OCR 에 넣을 글자 한 줄 높이. 기본 `28` (큰 글자만 줄이고 키우지는 않는다). `0` 이면 원본 크기 그대로 |
| `-j, --jobs N` | OCR 동시 실행 개수. 기본은 CPU 수 |
| `--encoding ENC` | 출력 인코딩. 기본 `utf-8` |
| `--bom` | UTF-8 BOM 추가 |
| `--keep-styling` | ASS 스타일 태그(`{\an8}` 등)를 지우지 않는다 |
| `--overwrite` | 기존 출력 파일 덮어쓰기 |
| `-q, --quiet` | 진행 상황을 출력하지 않는다 |

## 동작 방식

```
영상 ──ffprobe──> 자막 트랙 목록
                      │
        ┌─────────────┴─────────────┐
   텍스트 자막                  이미지 자막
        │                           │
   ffmpeg -c:s srt          PGS: .sup 세그먼트 파싱 → RLE 디코딩
        │                   VobSub: SPU 제어 시퀀스 + 2비트 RLE 디코딩
        │                           │
        │                    글자 주변으로 잘라내기
        │                    → 검은 배경 합성 → 흑백 반전
        │                    → 기울기 바로 세우기
        │                    → 글자 줄마다 자르기
        │                    → 음표(♪) 찾아 떼어내기
        │                    → 크기 맞추기 (큰 것만 줄임)
        │                           │
        │                     Tesseract (줄 단위, 병렬)
        └─────────────┬─────────────┘
              후처리 (대화 표시 띄어쓰기 · 빈 줄 · 겹침 · 중복)
                            │
                          SRT
```

이미지 자막의 OCR 전처리는 자막 비트맵이 대개 *밝은 글자 + 어두운 테두리 + 투명 배경*
이라는 점을 이용합니다. 검은 배경에 합성하면 글자만 밝게 남고, 그걸 반전시키면
테두리와 배경이 함께 흰색으로 사라지면서 **흰 바탕 위 검은 글자**만 남습니다.

그 뒤가 정확도를 크게 좌우합니다. 실제 영화 자막으로 재어 가며 정한 것들입니다.

| 단계 | 왜 |
|---|---|
| 기울기 바로 세우기 | 기울어진 노래 가사를 인식기가 거의 못 읽습니다 (한글 31.6% → 92.8%) |
| 글자 줄마다 자르기 | 통째로 넣으면 가운데 맞춤 여백을 글자로 오해해 없는 점을 만들고 한 줄을 흘립니다 |
| 음표(♪) 찾기 | 인식기 글자 목록에 ♪ 가 아예 없어 **글자로는 절대 못 얻습니다** |
| 크기 맞추기 | 크게 넣을수록 나빠집니다. 특히 ㅈ 을 ㅅ 으로 읽는 실수 (14개 → 0개) |

자세한 근거와 실측값은 [`web/README.md`](web/README.md) 에 정리해 두었습니다.
전처리는 파이썬판과 브라우저판이 같은 규칙을 씁니다.

## 성능과 정확도

4코어 환경 기준:

| 작업 | 속도 |
|---|---|
| 텍스트 자막 | 사실상 즉시 (1000줄 0.1초 미만) |
| 이미지 자막 OCR | 글자 줄 하나에 20~25밀리초 → 영화 한 편(자막 1,578줄) **약 30초** |

정확도는 **실제 한글 DVD 자막 영화 한 편**(1,578줄, 1920x1080)을 손으로 받아 적은
정답지 64줄과 맞춰 재었습니다.

| | 글자정확도 | 완전히 맞은 자막 |
|---|---|---|
| 전처리를 손보기 전 | 91.53% | 39/64 |
| **지금** | **99.55%** | **60/64** |

남은 것은 `고맙네`→`고맘네` 처럼 글자 하나가 어긋나는 네 군데뿐입니다.
자세한 내역은 [`web/README.md`](web/README.md) 에 있습니다.

> Tesseract 는 기본적으로 CPU 코어 수만큼 OpenMP 스레드를 띄웁니다. 프로세스를
> 여러 개 병렬로 돌리면 이게 서로 겹쳐 **수십 배 느려지므로**, subex 는 각
> Tesseract 프로세스를 `OMP_THREAD_LIMIT=1` 로 묶고 프로세스 단위로만 병렬화합니다.
> (이 한 줄로 같은 작업이 62초 → 0.6초가 됐습니다.)

## 개발

```bash
pip install -e ".[dev]"
pytest
```

테스트는 45개이고, ffmpeg/tesseract 가 없으면 해당 항목만 자동으로 건너뜁니다.

ffmpeg 는 **텍스트 자막을 이미지 자막으로 인코딩하지 못하기 때문에**(dvdsub 인코더는
bitmap→bitmap 만 받습니다) PGS·VobSub 테스트 자료는 `tests/pgs_writer.py`,
`tests/vobsub_writer.py` 가 규격대로 직접 만듭니다. 그 픽스처가 진짜 규격에 맞는지는
**ffmpeg 자신의 디코더로 렌더링해서 교차 검증**합니다 — 우리 파서와 인코더가
똑같이 틀리는 상황을 막기 위해서입니다.

## 라이선스

MIT.

## 브라우저판 (권장)

**바로 쓰기: https://kgcaudit.github.io/Subtitle-Extraction/**

설치 없이 브라우저에서 쓰려면 `web/` 폴더를 보세요. 안드로이드·아이폰·PC·맥 어디서든
동작하고, 영상을 서버로 올리지 않습니다. MKV·WebM·MP4·MOV 와 .sup 자막 파일,
그리고 DVD 자막 **.idx + .sub 짝**(하나씩 차례로 골라도 됩니다)을 읽습니다.

```bash
cd web && npm install && npm run vendor && npm run serve
```

브라우저판은 이 파이썬판을 정답지로 삼아 검증합니다. 진짜 크로미움에서 영상을 끝까지
돌려 만들어진 SRT 가 파이썬판 결과와 바이트 단위로 같은지 확인합니다(`cd web && npm test`,
39개). 기준 자료는 `python3 tests/make_web_fixtures.py` 와
`python3 tests/make_parity_golden.py` 로 다시 만들 수 있습니다.

실제 영화 자막 한 편으로 양쪽을 맞춰 보면 **자막 수와 시각이 완전히 같고**
(1,577줄 모두 밀리초까지), 그림 해독은 **픽셀 하나까지 같으며**(605만 픽셀 대조,
차이 0), 글자는 **99.91%** 일치합니다. 남은 차이는 인식 엔진이 서로 달라
(WebAssembly 대 네이티브) 생기는 것입니다.
