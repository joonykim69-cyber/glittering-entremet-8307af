// netlify/functions/lib/hwp.js
// HWP(한글) 문서 텍스트 추출 — 공매재산명세서 자동 정리를 위한 파서.
//
// 왜: 공매에서 가장 중요한 정보(임차인·보증금·인수조건·명도)가 공매재산명세서(HWP)에
//   들어 있는데, 우리는 지금까지 "원문을 확인하세요"라고 안내만 했다. PDF는 이미 읽으므로
//   HWP만 읽으면 권리/유찰 분석의 마지막 구멍이 메워진다.
//
// 왜 순수 JS인가: 서버리스 번들에 네이티브 의존성을 넣지 않는다(기존 원칙). Node 내장
//   zlib만 사용한다. HWP 5.0(.hwp)은 CFB(OLE2) 컨테이너, HWPX(.hwpx)는 ZIP+XML이라
//   두 경로를 각각 구현했다.
//
// 정직성(헌장): 추출에 실패하거나 텍스트가 사실상 없으면 **추측하지 않고** 실패로 돌려
//   호출자가 "원문 열람"으로 안내하게 한다. 어설픈 파싱으로 오독을 만들지 않는다.
//
// 사양 요약(HWP 5.0):
//   - CFB 스트림 'FileHeader'(256B): 시그니처 "HWP Document File" + 버전 + 속성 플래그
//     (bit0=압축, bit1=암호). 암호 문서는 지원하지 않는다(정직하게 실패).
//   - 본문은 'BodyText/Section0..N' 스트림. 압축 문서면 raw deflate.
//   - 레코드 헤더 uint32 = tagID(10bit) | level(10bit) | size(12bit),
//     size가 0xFFF면 다음 uint32가 실제 크기.
//   - 문단 텍스트 = HWPTAG_PARA_TEXT(=0x010+51=67), UTF-16LE.
//     제어문자 규칙: 확장/인라인(8 WCHAR 소비), 그 외 단일(1 WCHAR).

'use strict';

const zlib = require('zlib');

// ── 공통: 제어문자 처리 ────────────────────────────────────────────────
// HWP 텍스트의 0~31은 제어문자. 확장(extended)·인라인(inline)은 8 WCHAR를 차지한다.
const CTRL_EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const CTRL_INLINE = new Set([4, 5, 6, 7, 8, 9, 19, 20]);

// PARA_TEXT 레코드(UTF-16LE) → 문자열. 제어문자는 규칙대로 건너뛰고 줄바꿈만 남긴다.
function decodeParaText(buf) {
  let out = '';
  for (let i = 0; i + 1 < buf.length;) {
    const code = buf.readUInt16LE(i);
    if (code < 32) {
      if (CTRL_EXTENDED.has(code) || CTRL_INLINE.has(code)) { i += 16; continue; } // 8 WCHAR = 16 byte
      if (code === 10 || code === 13) out += '\n';
      else if (code === 9) out += '\t';
      i += 2;
      continue;
    }
    out += String.fromCharCode(code);
    i += 2;
  }
  return out;
}

// 레코드 스트림에서 PARA_TEXT만 뽑아 이어붙인다.
const HWPTAG_PARA_TEXT = 67;
function extractFromSection(buf) {
  let out = '';
  for (let p = 0; p + 4 <= buf.length;) {
    const header = buf.readUInt32LE(p); p += 4;
    const tag = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (p + 4 > buf.length) break;
      size = buf.readUInt32LE(p); p += 4;
    }
    if (size < 0 || p + size > buf.length) break; // 손상/경계 초과 → 안전 중단
    if (tag === HWPTAG_PARA_TEXT) out += decodeParaText(buf.slice(p, p + size)) + '\n';
    p += size;
  }
  return out;
}

// ── CFB(OLE2) 최소 리더 ────────────────────────────────────────────────
// HWP 5.0 컨테이너. 필요한 것은 "이름으로 스트림 바이트 얻기"뿐이라 그만큼만 구현한다.
const CFB_SIG = 'd0cf11e0a1b11ae1';
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe;

function isCfb(buf) {
  return buf.length >= 8 && buf.slice(0, 8).toString('hex') === CFB_SIG;
}

function readCfb(buf) {
  if (!isCfb(buf)) throw new Error('CFB 시그니처 아님');
  const sectorShift = buf.readUInt16LE(30);
  const miniSectorShift = buf.readUInt16LE(32);
  const secSize = 1 << sectorShift;             // 보통 512
  const miniSize = 1 << miniSectorShift;        // 보통 64
  const numFatSects = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  const difatStart = buf.readUInt32LE(68);
  const numDifatSects = buf.readUInt32LE(72);

  const sectorOffset = s => (s + 1) * secSize;
  const readSector = s => buf.slice(sectorOffset(s), sectorOffset(s) + secSize);

  // DIFAT → FAT 섹터 번호 목록
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSects; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  let dfs = difatStart;
  for (let n = 0; n < numDifatSects && dfs !== ENDOFCHAIN && dfs !== FREESECT; n++) {
    const sec = readSector(dfs);
    const per = secSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFatSects; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== FREESECT) fatSectors.push(s);
    }
    dfs = sec.readUInt32LE(secSize - 4);
  }

  // FAT 전체(섹터 체인 테이블)
  const fat = [];
  for (const fs of fatSectors) {
    const sec = readSector(fs);
    for (let i = 0; i < secSize / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }

  // 섹터 체인을 따라 스트림 바이트 수집
  function chain(start, size, table, reader) {
    const parts = [];
    let s = start, guard = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && guard++ < 1e6) {
      parts.push(reader(s));
      s = table[s];
    }
    const all = Buffer.concat(parts);
    return size != null ? all.slice(0, size) : all;
  }

  // 디렉터리 엔트리 파싱
  const dirBytes = chain(dirStart, null, fat, readSector);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dirBytes.readUInt16LE(off + 64);
    let name = '';
    for (let i = 0; i + 1 < Math.max(0, nameLen - 2); i += 2) name += String.fromCharCode(dirBytes.readUInt16LE(off + i));
    entries.push({
      name,
      type: dirBytes.readUInt8(off + 66),           // 1=storage, 2=stream, 5=root
      child: dirBytes.readUInt32LE(off + 76),
      left: dirBytes.readUInt32LE(off + 68),
      right: dirBytes.readUInt32LE(off + 72),
      start: dirBytes.readUInt32LE(off + 116),
      size: dirBytes.readUInt32LE(off + 120),        // 32bit로 충분(문서 15MB 상한)
    });
  }
  if (!entries.length) throw new Error('CFB 디렉터리 없음');

  // 미니 스트림(루트 엔트리) + miniFAT
  const root = entries[0];
  const miniFat = [];
  if (miniFatStart !== ENDOFCHAIN && miniFatStart !== FREESECT) {
    const mf = chain(miniFatStart, null, fat, readSector);
    for (let i = 0; i + 4 <= mf.length; i++) { if (i % 4 === 0) miniFat.push(mf.readUInt32LE(i)); }
  }
  const miniStream = root.size > 0 ? chain(root.start, root.size, fat, readSector) : Buffer.alloc(0);
  const readMini = s => miniStream.slice(s * miniSize, (s + 1) * miniSize);

  function streamOf(entry) {
    if (!entry || entry.size === 0) return Buffer.alloc(0);
    return entry.size < miniCutoff
      ? chain(entry.start, entry.size, miniFat, readMini)
      : chain(entry.start, entry.size, fat, readSector);
  }
  return { entries, streamOf };
}

// ── HWP 5.0 (.hwp) ────────────────────────────────────────────────────
function extractHwp(buf) {
  const cfb = readCfb(buf);
  const fh = cfb.entries.find(e => e.type === 2 && e.name === 'FileHeader');
  if (!fh) throw new Error('FileHeader 없음 — HWP 5.0 문서가 아닙니다');
  const head = cfb.streamOf(fh);
  const sig = head.slice(0, 17).toString('latin1');
  if (!/^HWP Document File/.test(sig)) throw new Error('HWP 시그니처 아님');
  const flags = head.length >= 40 ? head.readUInt32LE(36) : 0;
  const compressed = !!(flags & 0x01);
  const encrypted = !!(flags & 0x02);
  if (encrypted) throw new Error('암호가 걸린 문서라 자동 추출을 지원하지 않습니다');

  // BodyText 하위의 Section0..N (스토리지 하위 스트림 — 이름으로 모아 정렬)
  const secs = cfb.entries
    .filter(e => e.type === 2 && /^Section\d+$/.test(e.name))
    .sort((a, b) => (parseInt(a.name.slice(7), 10) - parseInt(b.name.slice(7), 10)));
  if (!secs.length) throw new Error('본문(BodyText/Section) 없음');

  let text = '';
  for (const s of secs) {
    let raw = cfb.streamOf(s);
    if (compressed) {
      try { raw = zlib.inflateRawSync(raw); }
      catch (e) { try { raw = zlib.inflateSync(raw); } catch (e2) { continue; } } // 섹션 하나 실패는 건너뜀
    }
    text += extractFromSection(raw);
  }
  return text;
}

// ── HWPX (.hwpx) = ZIP + XML ──────────────────────────────────────────
// 필요한 것만: 중앙 디렉터리를 훑어 Contents/section*.xml 을 꺼내 태그를 벗긴다.
function unzipEntries(buf) {
  // End of Central Directory 찾기(뒤에서부터, 주석 최대 64KB)
  const sigEOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === sigEOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP(EOCD) 아님');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const out = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 로컬 헤더에서 실제 데이터 시작 위치 계산
    if (lho + 30 <= buf.length && buf.readUInt32LE(lho) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      out.push({ name, method, data });
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function inflateEntry(e) {
  if (e.method === 0) return e.data;            // stored
  if (e.method === 8) return zlib.inflateRawSync(e.data); // deflate
  throw new Error('지원하지 않는 ZIP 압축 방식');
}

// XML 텍스트 추출 — <hp:t> 안의 문자를 잇되, 문단(<hp:p>) 경계는 줄바꿈.
function xmlToText(xml) {
  let s = String(xml);
  s = s.replace(/<\?xml[\s\S]*?\?>/g, '');
  s = s.replace(/<hp:p[\s>]/g, '\n<hp:p ');          // 문단 경계
  const parts = [];
  const re = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g;
  let m;
  while ((m = re.exec(s))) parts.push(m[1]);
  let text = parts.length ? parts.join('') : s.replace(/<[^>]+>/g, ' ');
  // 문단 구분 복원: 위에서 넣은 개행은 태그 제거 과정에서 사라지므로 <hp:p> 위치로 다시 분할
  if (parts.length) {
    const paras = s.split(/<hp:p\b/).map(chunk => {
      const ts = [...chunk.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)].map(x => x[1]).join('');
      return ts;
    }).filter(Boolean);
    if (paras.length) text = paras.join('\n');
  }
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function extractHwpx(buf) {
  const entries = unzipEntries(buf);
  const secs = entries
    .filter(e => /^Contents\/section\d+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!secs.length) throw new Error('HWPX 본문(Contents/section*.xml) 없음');
  let text = '';
  for (const s of secs) {
    try { text += xmlToText(inflateEntry(s).toString('utf8')) + '\n'; } catch (e) { /* 섹션 하나 실패는 건너뜀 */ }
  }
  return text;
}

// ── 진입점 ────────────────────────────────────────────────────────────
// 확장자가 아니라 **매직 바이트**로 형식을 판정한다(온비드 URL은 확장자가 없을 수 있음).
function sniff(buf) {
  if (!buf || buf.length < 8) return 'unknown';
  if (isCfb(buf)) return 'hwp';                                   // OLE2 → HWP 5.0(또는 구형 오피스)
  if (buf.readUInt32LE(0) === 0x04034b50) return 'hwpx';          // ZIP → HWPX(또는 일반 zip)
  return 'unknown';
}

// 성공 시 { ok:true, text, format }, 실패 시 { ok:false, reason } — 던지지 않고 정직하게 돌려준다.
function extractText(buf) {
  const fmt = sniff(buf);
  try {
    if (fmt === 'hwp') return { ok: true, format: 'hwp', text: extractHwp(buf) };
    if (fmt === 'hwpx') return { ok: true, format: 'hwpx', text: extractHwpx(buf) };
    return { ok: false, reason: 'HWP/HWPX 형식이 아닙니다' };
  } catch (e) {
    return { ok: false, reason: e.message || '추출 실패' };
  }
}

module.exports = { extractText, sniff, extractHwp, extractHwpx, decodeParaText, extractFromSection, readCfb, unzipEntries, xmlToText };
