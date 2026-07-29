// netlify/functions/doc-extract.js
// 관련문서(감정평가서 PDF 등) 텍스트 추출 + AI 요약 — 2026-07-26 착수(창업자 지시).
//
// 왜: 유찰 원인의 보고(임차인·인수조건·특이사항)가 첨부 문서 안에 있다. 온비드 API는
// 파일 URL까지만 주므로, 우리가 PDF 텍스트를 추출해 확인된 사실만 정리해 보여준다.
// 신탁/NPL 물건 분석의 기반 작업이기도 하다(공매재산명세서·신탁계약 문서와 동성격).
//
// 정직성 원칙:
//   - 스캔본(이미지 PDF)은 텍스트가 없다 → "스캔본 — 텍스트 추출 불가, 원문 열람" 정직 안내(OCR 날조 금지).
//   - hwp/hwpx는 1단계 미지원 → unsupported 명시(엉터리 파싱으로 오독 유발 금지).
//   - 요약은 추출된 텍스트에 있는 사실만(claude.js 프록시, 문서에 없으면 "기재 없음").
//
// 보안: URL 허용 호스트 = 온비드(*.onbid.co.kr)만 (SSRF 가드). 15MB·20초 상한.
// 캐시: doc/{sha1(url)} = 추출 결과, docsum/{sha1(url)} = 요약 — 문서당 1회 비용.
//
// 사용: GET ?url=<온비드 파일 URL>[&summarize=1][&debug=1]

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const MAX_BYTES = 15 * 1024 * 1024; // 15MB
const TEXT_MIN_CHARS = 200;         // 이보다 짧으면 사실상 스캔본으로 판정
const SUMMARY_TEXT_CAP = 12000;     // Claude에 보낼 텍스트 상한(문자)

// 온비드 파일 서버만 허용 — 그 외 호스트는 프록시하지 않는다(SSRF 가드)
function isAllowedUrl(u) {
  try {
    const p = new URL(String(u));
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
    return /(^|\.)onbid\.co\.kr$/i.test(p.hostname);
  } catch (e) { return false; }
}

function classifyKind(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length >= TEXT_MIN_CHARS ? 'text' : 'scan';
}

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__; // fixture 검증용(런타임 미사용)
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 신형 런타임 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

// 문서 요약 — 추출 텍스트에 있는 사실만 (claude.js 프록시, Haiku). 법률 자문 아님 강제.
const SUM_SYSTEM = `당신은 신호등옥션의 "공매 문서 정리" 도우미입니다. 온비드 공매 첨부 문서(감정평가서·공매재산명세서 등)에서 추출된 텍스트가 주어집니다. 아래 항목별로, 텍스트에 명시된 사실만 간결하게 정리하세요:
① 임대차·임차인(성명 일부/보증금/차임/전입·확정일자) ② 매수인이 인수하는 권리·조건(말소되지 않는 권리, 명도 책임 등) ③ 면적·구조·용도 ④ 감정평가액과 산출 근거 요점 ⑤ 그 밖의 유의사항(공부와 현황 불일치, 제시외 건물, 체납관리비 등).
규칙: 텍스트에 없는 항목은 반드시 "기재 없음"으로 표시하고 추측하지 마세요. 금액·날짜는 원문 그대로. 법률 판단("안전하다/문제없다")은 금지. 한국어 존댓말, 항목별 불릿. 첫 문장에 "문서에 기재된 내용의 요약이며 법률 자문이 아닙니다"를 포함하세요.`;

exports._test = { isAllowedUrl, classifyKind }; // 검증 테스트용(런타임 미사용)

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'GET only' } }) };

  const qs = event.queryStringParameters || {};
  const url = String(qs.url || '');
  if (!isAllowedUrl(url)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: '온비드(onbid.co.kr) 문서 URL만 지원합니다.' } }) };
  }
  // (2026-07-29) HWP/HWPX 지원 추가 — 확장자로 미리 막지 않고 **매직 바이트**로 판정한다.
  // 온비드 다운로드 URL은 확장자가 없는 경우가 많으므로 실제 내용으로 분기해야 한다.

  const hash = crypto.createHash('sha1').update(url).digest('hex');
  try {
    const store = await openLedger(event);

    // 요약 캐시 히트면 즉시 반환
    if (qs.summarize) {
      const cachedSum = await store.get(`docsum/${hash}`, { type: 'json' });
      if (cachedSum) return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cachedSum, cached: true }) };
    }

    // 추출 (캐시 우선)
    let doc = await store.get(`doc/${hash}`, { type: 'json' });
    if (!doc) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      let buf;
      try {
        const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        if (!r.ok) throw new Error('원본 HTTP ' + r.status);
        const ab = await r.arrayBuffer();
        if (ab.byteLength > MAX_BYTES) throw new Error('문서가 15MB를 초과합니다');
        buf = Buffer.from(ab);
      } finally { clearTimeout(timer); }
      // ── PDF가 아니면 HWP/HWPX 경로 시도 (공매재산명세서가 주로 HWP) ──
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
        const hwp = require('./lib/hwp.js');
        const fmt = hwp.sniff(buf);
        if (fmt === 'hwp' || fmt === 'hwpx') {
          const res = hwp.extractText(buf);
          if (!res.ok) {
            // 추출 실패는 추측하지 않고 정직하게 원문 안내(헌장: 어설픈 파싱 금지)
            return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'unsupported', kind: 'hwp', message: `HWP 문서를 읽지 못했습니다(${res.reason}) — 온비드에서 원문을 열람하세요.` }) };
          }
          // PDF 경로와 같은 스키마로 저장(뒤쪽 스캔 판정·요약 로직이 그대로 동작하도록)
          const hText = String(res.text || '');
          const hKind = classifyKind(hText); // 텍스트가 사실상 없으면 'scan'과 동일 취급
          doc = {
            status: 'ok', kind: hKind, pages: 0, format: res.format,
            chars: hText.replace(/\s+/g, ' ').trim().length,
            text: hKind === 'text' ? hText.slice(0, SUMMARY_TEXT_CAP) : '',
            at: new Date().toISOString(), url,
          };
          await store.setJSON(`doc/${hash}`, doc);
        } else {
          return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'unsupported', kind: 'not-pdf', message: 'PDF·HWP가 아닌 문서입니다 — 온비드에서 원문을 열람하세요.' }) };
        }
      }
      if (!doc) {
      // index.js가 아니라 lib를 직접 require — pdf-parse@1.1.1 index.js의 `!module.parent` 디버그 블록이
      // esbuild 번들에선 항상 참이 되어 './test/data/05-versions-space.pdf'를 읽다 ENOENT로 죽는 버그 우회
      // (프로덕션 실클릭에서 발견, 2026-07-27 — 감정평가서(등촌동).pdf).
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const parsed = await pdfParse(buf, { max: 40 }); // 최대 40쪽 — 감정평가서 커버, 폭주 방지
      const text = String(parsed.text || '');
      const kind = classifyKind(text);
      doc = {
        status: 'ok', kind, pages: parsed.numpages || 0,
        chars: text.replace(/\s+/g, ' ').trim().length,
        text: kind === 'text' ? text.slice(0, SUMMARY_TEXT_CAP) : '',
        at: new Date().toISOString(), url,
      };
      await store.setJSON(`doc/${hash}`, doc);
      } // ← PDF 경로 끝 (HWP 경로에서 이미 doc이 채워졌으면 건너뜀)
    }

    if (doc.kind === 'scan') {
      // HWP는 "스캔본"이라 단정할 수 없다(본문이 이미지·표 객체로만 구성된 경우 등) — 형식별로 정직하게 표현
      const scanMsg = (doc.format === 'hwp' || doc.format === 'hwpx')
        ? '이 한글 문서에서는 읽을 수 있는 본문 텍스트를 찾지 못했습니다(이미지·표 개체로만 구성된 경우) — 온비드에서 원문을 직접 열람하세요.'
        : '스캔본(이미지) 문서라 텍스트를 추출할 수 없습니다 — 온비드에서 원문을 직접 열람하세요.';
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'scan', kind: 'scan', pages: doc.pages, format: doc.format || 'pdf', message: scanMsg }) };
    }

    if (!qs.summarize) {
      const out = { status: 'ok', kind: doc.kind, pages: doc.pages, chars: doc.chars };
      if (qs.debug) out.excerpt = doc.text.slice(0, 800);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
    }

    // 요약 생성 (문서당 1회 캐시)
    const base = process.env.URL || '';
    const res = await fetch(`${base}/.netlify/functions/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: SUM_SYSTEM,
        messages: [{ role: 'user', content: `추출된 문서 텍스트(${doc.pages}쪽):\n${doc.text}\n\n위 텍스트에 기재된 사실만 항목별로 정리해 주세요.` }],
        max_tokens: 900,
      }),
    });
    if (!res.ok) throw new Error('claude proxy HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'claude proxy error');
    const summary = Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() : '';
    if (!summary) throw new Error('빈 요약');

    const out = {
      status: 'ok', kind: 'text', pages: doc.pages, chars: doc.chars, summary,
      disclaimer: '문서에 기재된 내용의 자동 정리이며 원문 열람을 대체하지 않습니다. 법률 자문이 아니며, 입찰 전 원문·등기부 확인이 필요합니다.',
      generatedAt: new Date().toISOString(), cached: false,
    };
    await store.setJSON(`docsum/${hash}`, out);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: '문서 처리 실패: ' + e.message } }) };
  }
};
