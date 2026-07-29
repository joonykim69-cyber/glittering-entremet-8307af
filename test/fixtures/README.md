# test/fixtures

여기 있는 바이너리는 **우리 코드가 만들지 않았다.** 파서를 우리 writer로 만든 파일로 검증하면
둘이 같은 오해를 공유해도 통과한다(순환 검증). 그 고리를 끊기 위해 제3자 구현으로 생성한
진짜 파일을 커밋해 두었다.

| 파일 | 생성 도구 | 검증 대상 |
|---|---|---|
| `sample-compressed.hwp` | SheetJS [`cfb`](https://www.npmjs.com/package/cfb) (CFB/OLE2 독립 구현) + Node `zlib` | `lib/hwp.js` — 압축 섹션, 다중 섹션 순서, PARA_TEXT(67)만 추출 |
| `sample-uncompressed.hwp` | 〃 (FileHeader 압축 플래그 off) | 비압축 경로 |
| `sample-encrypted.hwp` | 〃 (암호 플래그 on) | 암호 문서를 **추측 복호화하지 않고 정직하게 실패**하는지 |
| `sample-longrecord.hwp` | 〃 (본문 6,000바이트) | 레코드 size 0xFFF → 확장 헤더(uint32) 경로 |
| `sample.hwpx` | 시스템 `zip` 명령 (ZIP 독립 구현) | HWPX = ZIP + `Contents/section*.xml`의 `<hp:t>` 추출 |

`.hwp` 본문은 HWP 5.0 레코드 사양대로 조립했다 — 헤더 `tagID(10b) | level(10b) | size(12b)`,
본문 UTF-16LE, 무시돼야 하는 다른 태그(66 PARA_HEADER, 70) 혼입.

## 재생성

`cfb`는 **테스트 실행에 필요하지 않다**(고정된 산출물을 커밋했으므로). 픽스처를 바꿔야 할 때만
일회성으로 설치해서 다시 만든다:

```bash
npm i --no-save cfb        # 제3자 CFB 구현
# 생성 스크립트는 test/fixtures/gen-hwp.js 참조
node test/fixtures/gen-hwp.js
```
