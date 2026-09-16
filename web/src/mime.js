// 자막 형식을 가리키는 이름표.
//
// 컨테이너 해석기(container.js)와 자막 뽑기(extract.js)가 같이 쓰므로
// 서로 불러오다 엉키지 않도록 따로 두었다.

export const MIME = {
  PGS: 'application/pgs',
  VOBSUB: 'application/vobsub',
  DVBSUBS: 'application/dvbsubs',
  SUBRIP: 'application/x-subrip',
  SSA: 'text/x-ssa',
  VTT: 'text/vtt',
  TX3G: 'application/x-quicktime-tx3g',
};
