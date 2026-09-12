"""subex - 영상에 들어 있는 자막 트랙을 SRT로 추출한다.

텍스트 자막(SubRip/ASS/mov_text/WebVTT 등)은 그대로 변환하고,
이미지 자막(PGS, VobSub)은 비트맵을 복원한 뒤 OCR을 거쳐 텍스트로 만든다.
"""

__version__ = "0.1.0"
