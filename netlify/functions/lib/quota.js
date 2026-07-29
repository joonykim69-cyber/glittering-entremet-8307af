// netlify/functions/lib/quota.js
// 외부 API 일일 호출 예산 가드 (data.go.kr 온비드 계열).
//
// 왜 필요한가: data.go.kr 인증키는 **서비스별 일일 호출 한도(온비드 계열 1,000회)**가 있고,
//   한도를 넘기면 그날 남은 호출이 전부 실패한다. 그런데 우리 호출자는 두 종류다.
//     ① 사용자 화면(물건검색·지도·캘린더·상세) — 실패하면 **서비스가 죽은 것처럼 보인다**
//     ② 백그라운드 수집기(collect-backfill·collect-history) — 실패해도 다음 실행이 이어받는다
//   즉 한도를 다 쓰는 쪽은 거의 항상 ②인데, 그 대가를 치르는 쪽은 ①이다. 그래서 수집기에게
//   **상한을 두고, 사용자 몫을 먼저 떼어 놓는다**(liveReserve). 예산이 떨어지면 수집기는
//   실패가 아니라 **깨끗하게 중단**하고 커서를 남긴다 — 다음 날 이어서 하면 되는 일이므로.
//
// 티어:
//   'critical' — 예측 봉인/채점(predict-daily·score-daily). 하루 수십 콜이고 원장의 근간이라
//                **막지 않는다**. 다만 사용량은 똑같이 기록해 예산 계산에 반영한다.
//   'bulk'     — 대량 수집기. 남은 예산이 사용자 몫(liveReserve)까지 내려오면 중단한다.
//
// 정직성: 이 카운터는 **우리 예약 함수가 실제로 쏜 호출만** 센다. 사용자 화면의 직접 호출은
//   세지 않는다(요청마다 Blobs 쓰기를 넣으면 응답이 느려진다). 따라서 liveReserve는
//   "측정값"이 아니라 "사용자용으로 비워 두는 몫"이며, 이 사실을 scoreboard에도 그대로 적는다.

'use strict';

const DEFAULT_CAP = 1000;      // data.go.kr 온비드 계열 일일 한도
const DEFAULT_RESERVE = 250;   // 사용자 화면용으로 남겨 두는 몫

// KST 기준 날짜(YYYYMMDD) — 한도는 한국 시간 자정에 리셋된다고 보수적으로 가정.
function kstDay(now) {
  const d = new Date((now instanceof Date ? now.getTime() : (now || Date.now())) + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const quotaKey = (service, day) => `_quota/${service}/${day}`;

function envInt(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * 하루치 호출 예산을 연다.
 * @param store Blobs 스토어(ledger)
 * @param opts  { service='onbid', tier='bulk', now, cap, reserve }
 * @returns Budget
 */
async function openBudget(store, opts = {}) {
  const service = opts.service || 'onbid';
  const tier = opts.tier === 'critical' ? 'critical' : 'bulk';
  const day = kstDay(opts.now);
  const cap = opts.cap != null ? opts.cap : envInt('ONBID_DAILY_QUOTA', DEFAULT_CAP);
  const reserve = opts.reserve != null ? opts.reserve : envInt('ONBID_LIVE_RESERVE', DEFAULT_RESERVE);
  const key = quotaKey(service, day);

  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (e) { rec = null; }
  const start = Math.max(0, Number(rec && rec.n) || 0);

  // bulk가 쓸 수 있는 상한 = 전체 한도 − 사용자 몫. critical은 전체 한도까지.
  const limit = tier === 'critical' ? cap : Math.max(0, cap - reserve);

  return {
    service, day, tier, cap, reserve, limit, key,
    used: start,          // 오늘 지금까지(모든 예약 함수 합산)
    spent: 0,             // 이번 실행이 쓴 양
    stopped: false,       // 예산 때문에 멈췄는가
    _unflushed: 0,        // 아직 저장하지 않은 이번 실행분

    /** n회를 쓸 수 있으면 차감하고 true, 예산 밖이면 false(호출하지 말 것). */
    take(n) {
      const need = Math.max(1, Number(n) || 1);
      if (this.used + need > this.limit) { this.stopped = true; return false; }
      this.used += need; this.spent += need; this._unflushed += need;
      return true;
    },

    /** critical 티어용 — 막지 않고 사용량만 기록한다. */
    note(n) {
      const need = Math.max(1, Number(n) || 1);
      this.used += need; this.spent += need; this._unflushed += need;
    },

    remaining() { return Math.max(0, this.limit - this.used); },

    /**
     * 카운터를 저장한다(실행 끝 또는 주기적으로). 저장 직전에 다시 읽어 **그 사이 다른 함수가
     * 쓴 양 위에 이번 실행분만 더한다** — 두 함수가 겹쳐 돌아도 서로의 사용량을 지우지 않는다.
     * 실패해도 던지지 않는다(가드는 보조장치이지, 수집을 막는 장치가 아니다).
     */
    async flush() {
      if (!this._unflushed) return;
      const add = this._unflushed;
      try {
        const cur = await store.get(key, { type: 'json' });
        const base = Math.max(0, Number(cur && cur.n) || 0);
        await store.setJSON(key, { n: base + add, at: new Date().toISOString(), day, cap, reserve });
        this._unflushed = 0;
      } catch (e) { /* 카운터 저장 실패가 수집을 막지는 않는다 */ }
    },

    summary() {
      return { service, day, tier, cap, reserve, limit, used: this.used, spent: this.spent, remaining: this.remaining(), stopped: this.stopped };
    },
  };
}

/** 오늘 사용량 조회(읽기 전용 — scoreboard 노출용). */
async function readUsage(store, service = 'onbid', now) {
  const day = kstDay(now);
  let rec = null;
  try { rec = await store.get(quotaKey(service, day), { type: 'json' }); } catch (e) { rec = null; }
  const cap = envInt('ONBID_DAILY_QUOTA', DEFAULT_CAP);
  const reserve = envInt('ONBID_LIVE_RESERVE', DEFAULT_RESERVE);
  const used = Math.max(0, Number(rec && rec.n) || 0);
  return {
    service, day, cap, reserve, used,
    bulkLimit: Math.max(0, cap - reserve),
    remaining: Math.max(0, cap - used),
    at: (rec && rec.at) || null,
    note: '예약 함수(수집·봉인·채점)가 쏜 호출만 집계합니다. 사용자 화면의 직접 조회는 포함되지 않습니다.',
  };
}

module.exports = { openBudget, readUsage, kstDay, quotaKey, DEFAULT_CAP, DEFAULT_RESERVE };
