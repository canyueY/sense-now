/**
 * loop.js — 常驻看屏幕：起钟、看有没有新图、到点叫醒模型。照搬 `watch-together/watch-loop.js` 的骨架。
 *
 * ## 为什么必须有这一层
 *
 * 最早这里是"模型调 `watch(20s)` → 拿一张图 → 回话 → 再调一次"。实测跑不住：
 * **模型拿到图、回完话就结束了**，用户看到"它答一句就没下文了"。
 * 模型没有理由主动再调一次 —— 它不知道下一次该什么时候调，也没人提醒它。
 *
 * 钟必须在插件里：
 *
 *   每 2 秒   本地判定（读一眼队列深度、窗还在不在），纯算术，几乎不花钱
 *   真该看时  叫醒模型（往会话投一条消息 = 模型跑一轮，这才贵）
 *
 * 用户看两小时 ≈ 几十次唤醒，不是几千次。
 *
 * ## 三个停下来的条件
 *
 * 1. **用户关掉悬浮窗** —— 那是"我不看了"最直接的意思。落一条 hangup，之后不再唤醒。
 * 2. **模型调 `stop`** —— 明确说不看了。
 * 3. **采集真的死了**（ffmpeg 退出、源断了）或**连续叫不醒**。
 *
 * ## 刻意不接 `exec.signal`
 *
 * 以前这里接的是工具调用的 signal，`aborted` 就停。那是**单次调用**的通知
 * （宿主类型注释：`abort signal shared by the step`），不是"一直看下去"这件事的状态。
 * 接上去的结果是：这一轮以任何方式结束，常驻循环就跟着死 —— 用户看到的就是
 * "它答一句就完了"。取消/超时的处理放在 `runner.watch()` 自己的等待循环里。
 */

import { startTicker, wakeWithRetry } from './timer.js';
import { windowAlive, windowPidAlive } from './window.js';
import { appendSpoken, chatWatcherShared, chatWaiterCount, lastSaidNote } from './chat.js';
import { noteInterjected } from './interject.js';

/** 两次叫醒之间至少隔这么久（叫醒一次 = 模型跑一轮，很贵） */
const WAKE_COOLDOWN_MS = 3000;

/**
 * 心跳过期连续几拍才判 stalled（不 hangUp）。
 * 心跳本来是 6 秒算过期，用来决定"要不要重开窗"合适；但机器睡醒 /
 * 主线程卡几秒也会过期，不能当成用户关窗。
 */
export const WINDOW_GONE_TICKS = 3;

/**
 * 窗"没了"该怎么判 —— 纯函数，好测也好读。
 *
 * @returns {'closed'|'stalled'|null}
 *   - `closed`：进程真没了 → 停 + 挂断
 *   - `stalled`：进程还在、只是心跳断了 → 连续够多拍才停，**且不挂断**
 */
export function windowVerdict({
  wasOpen = false, alive = false, pidAlive = false, goneTicks = 0,
} = {}) {
  if (!wasOpen || alive) return null;
  if (!pidAlive) return 'closed';
  return goneTicks >= WINDOW_GONE_TICKS ? 'stalled' : null;
}

/**
 * 两张图之间至少隔这么久才叫醒模型。
 *
 * 动态画面 2~3 秒就出一张，按出图节奏叫，模型会每 3 秒说一句 —— 那是刷屏，不是陪看。
 * 8 秒是"不快于一口气说完两句话"的下限；真该说的时候（用户插话）不受这个限制。
 */
const WAKE_MIN_GAP_MS = 8000;
const TICK_MS = 2000;
/** 连续这么多次叫不醒就停：会话没了还每 8 秒烧一次模型，是最贵的失败模式 */
const WAKE_FAILS_MAX = 2;

/** 没开悬浮窗、用户又这么久没说话 → 认为没人看，收工 */
export const IDLE_STOP_MS = 3 * 60 * 1000;
/** 连续这么多次自动唤醒都没有用户搭理 → 收工（防"窗开着但人走了"/模型自己读图循环） */
export const MAX_AUTONOMOUS_WAKES = 8;

/**
 * 该不该因为「没人在看」收工 —— 抽成纯函数，好测也好读。
 *
 * 社区实报「装上后卡读图循环」：常驻循环原来**只有"采集停了"一个退出条件**，
 * 屏幕一直动（放视频、刷网页）就会每 15 秒叫醒模型一次，永远不停。
 */
export function shouldGoIdle({ wakesSinceUser = 0, now = Date.now(), lastUserAt = now, windowOpen = false } = {}) {
  if (wakesSinceUser >= MAX_AUTONOMOUS_WAKES) return true;
  // 悬浮窗开着 = 有人在陪看，中途不说话是正常的，只靠"叫太多次"兜底
  if (!windowOpen && now - lastUserAt > IDLE_STOP_MS) return true;
  return false;
}

/**
 * 关窗说明。**不投 followup**（那会进排队消息区），由 `runner.note()` 挂着，
 * 下一次工具结果带走 —— 和陪看的 `markHungUp` 同一个路子。
 */
export const HANGUP_NOTE = '[看屏幕·挂断] 悬浮窗被关掉了 —— 用户关它就是在说「不看了」。\n'
  + '采集已经停，不会再出图。**不要再调 sense_now**，也不要再说话。\n'
  + '只回一句短的（用 `say`，否则他看不到），比如"好，先停在这儿"。\n'
  + '他要接着看时会自己说一声，那时候再重新调 `sense_now({action:"watch"})`。';

/**
 * 起一个常驻循环。
 *
 * @param {object} o
 * @param {object} o.ctx 宿主上下文（叫醒要用）
 * @param {string} o.sessionId **起循环时的那个会话**。不能每次现取：多开会话时
 *   `session/event` 会被任何一个会话更新，现取会把话投给别人。
 * @param {() => string|null} [o.getSessionId] 兜底（起循环时还没拿到 id 的情况）
 * @param {object} o.runner createRunner() 的返回值
 * @param {(m:string)=>void} [o.log]
 * @param {(reason:string)=>void} [o.onStop] 停下来时回调（落挂断说明之类）
 * @param {number} [o.wakeMinGapSec] 两张图之间的最小叫醒间隔
 * @returns {{dispose:()=>void, state:()=>object, stopped:()=>boolean}}
 */
export function startLoop({
  ctx, sessionId = null, getSessionId = () => null, runner,
  log = () => {}, onStop = () => {}, wakeMinGapSec = WAKE_MIN_GAP_MS / 1000,
  // 逐帧模式：唤醒文案要说"换画面了，说一句这是什么"，而不是"有新画面了"。
  scene = false,
} = {}) {
  let disposed = false;
  let lastWakeAt = 0;
  let wakeFailures = 0;
  let consecutiveFails = 0;
  let wakeCount = 0;
  let stopReason = null;
  /** 起循环时的会话（一旦定下就不再变，见参数注释） */
  const owner = sessionId ?? getSessionId() ?? null;
  /** 上一张已经叫过的图（`#序号` 或 `p脉冲`），同一张永不重复叫 */
  let lastKey = null;
  /** pending 0→1 的脉冲计数：拿不到出图序号时靠它认"新的一张" */
  let pendingPulse = 0;
  let lastPending = 0;
  /** 采集停掉之后已经过了几拍 —— 用来给"队列里剩下的图"一个播报窗口，然后收工 */
  let deadTicks = 0;
  let lastWakeOk = null;
  /**
   * 「没人在看」的收工线（判据见 `shouldGoIdle`）。
   *
   * 社区实报「装上后会卡读图循环」—— 因为常驻循环**只有"采集停了"一个退出条件**。
   * 只要屏幕一直在动（放视频、刷网页），它就会每 `wakeMinGapSec` 叫一次模型、
   * 模型看一眼图回一句、下一张再叫一次，**永远不停**。用户什么都没问，会话却在
   * 一轮一轮读图。
   *
   * 两条收工线，互为兜底：
   *   - `IDLE_STOP_MS`：**没开悬浮窗**（没人看那个小窗）且用户超过 3 分钟没说话 → 停。
   *     悬浮窗开着就不判 —— 那是陪看场景，2 小时的电影中途不说话是正常的。
   *   - `MAX_AUTONOMOUS_WAKES`：连续叫了这么多次都没人搭理 → 停。
   */
  let lastUserAt = Date.now();
  let wakesSinceUser = 0;
  /** 窗"看起来没了"连续几拍（判据见 `windowVerdict`） */
  let windowGoneTicks = 0;

  /**
   * 自己盯 chat.jsonl 里的新用户消息。
   *
   * **不能靠 `pendingInterjected()`**：那个东西在提醒过一次之后就被标记成"念过了"，
   * 于是用户再说一句它也看不见。而且常驻模式下 `runner.watch()` 早就返回了 ——
   * 那里面的插话检测根本没机会跑。所以循环必须自己有一双眼睛。
   */
  const pollChat = chatWatcherShared();
  /** 还没被处理掉的插话（一次只处理一条，剩下的留着下一拍） */
  const queue = [];

  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`循环停了：${reason}`);
    // 自动收工要在窗口里留一行灰字，不然用户只会觉得"它突然哑了"
    if (reason === 'idle') {
      try { appendSpoken('meta', '（有一阵没人说话了，我先停一停；要看再说一声。）', { speak: false }); } catch { /* 写不进不影响停 */ }
    }
    try { onStop(reason); } catch { /* 停不下来也要停 */ }
    dispose();
  };

  /** 上一句说过什么（给唤醒文案用）：别让它在同一个屏幕上把同一句感慨说两遍 */
  function lastSaidHint() {
    return lastSaidNote({ maxAgeSec: 300, clipLen: 70 });
  }

  async function wake(text, { cooldownMs = WAKE_MIN_GAP_MS } = {}) {
    lastWakeAt = Date.now();
    const r = await wakeWithRetry({
      ctx, sessionId: owner, text, log,
      appendMeta: (m) => appendSpoken('meta', m, { speak: false }),
    });
    lastWakeOk = Boolean(r?.ok);
    if (r?.ok) {
      wakeCount += 1;
      consecutiveFails = 0;
      return true;
    }
    wakeFailures += 1;
    consecutiveFails += 1;
    if (consecutiveFails >= WAKE_FAILS_MAX) {
      // 会话可能已经关了：再叫下去只是每 8 秒白烧一次模型
      stop('wake-failed');
    }
    return false;
  }

  const ticker = startTicker({
    everyMs: TICK_MS,
    tick: async () => {
      if (disposed) return;

      // ⓪ 有阻塞等待者时**不许碰这条通道**。
      //    工具调用正卡在 `watch()` 里等用户说话，poll 是消费型的 —— 我们一吃，
      //    那边的等待就永远看不见这句话，用户侧表现是"我在窗口里说话，它一动不动"。
      //    等待者拿到话会直接返回工具结果，那才是唯一能把人从阻塞里叫出来的路。
      const waiting = chatWaiterCount() > 0;
      const fresh = waiting ? [] : pollChat();
      for (const e of fresh) {
        if (e?.role === 'user' && String(e.text ?? '').trim()) {
          queue.push(String(e.text).trim());
          lastUserAt = Date.now();
          wakesSinceUser = 0;
        }
      }

      // ① 窗被关掉 = 用户不想看了。**先判这个**：窗都没了，出图也没人在看。
      //    只在"窗确实开过"之后才判 —— 窗开不起来（没有 python）时不该被当成用户关窗。
      //    **进程没了才算关**；只是心跳过期只累加拍数，够数才 stalled 且不挂断。
      const wasOpen = runner.windowWasOpen();
      const winAlive = wasOpen ? windowAlive() : false;
      if (!wasOpen || winAlive) {
        windowGoneTicks = 0;
      } else {
        windowGoneTicks += 1;
        const verdict = windowVerdict({
          wasOpen,
          alive: winAlive,
          pidAlive: windowPidAlive(),
          goneTicks: windowGoneTicks,
        });
        if (verdict === 'closed') { stop('window-closed'); return; }
        if (verdict === 'stalled') { stop('window-stalled'); return; }
      }

      // ② 采集自己停了（源断了、ffmpeg 挂了）。
      //    **续命放在这之前**：静态画面下 60 秒不出图，宽限期会把采集收走，
      //    那时 `!running` 是"没人来取"而不是"坏了"，不能当成停。
      const st = runner.status();
      const alive = runner.touch?.() ?? st.running;
      /**
       * 采集已经停了：**最多再给两拍**把队列里剩下的图报出来，然后收工。
       *
       * 以前这里是 `!alive && !st.pending` —— 只要还有没取走的图就永远不自杀。
       * 文件回放一次能塞几十张进去，循环就被这些"永远取不完"的 pending 吊住，
       * 模型每拍被叫醒一次，用户看到的就是"一直弹有新画面、关窗都停不干净"。
       */
      if (!alive) {
        deadTicks += 1;
        if (!st.pending || deadTicks > 2) { stop('capture-stopped'); return; }
      } else if (deadTicks) deadTicks = 0;

      // ③ 有人在阻塞等的时候，整条叫醒路径都让开 —— 那一轮本来就还没结束，
      //    `followup` 投进去只会排队到这一轮之后，纯属插队无效还容易串话。
      if (waiting) return;

      // ④ 用户插话 —— **优先于一切**，不等攒满一张、不看队列深度
      if (queue.length) {
        if (Date.now() - lastWakeAt < WAKE_COOLDOWN_MS) return;
        const said = queue.shift();
        noteInterjected(said);          // 记待回执：没带 say 回的话下一轮会被顶
        const text = `[看屏幕·用户插话] 「${said}」\n`
          + '**先说话，再干活** —— 用 `say` 回他（普通回复他一个字都看不到，也不会被念）。'
          + '要同时看一眼就调 `sense_now({action:"peek"})`，图马上给你。';
        await wake(text, { cooldownMs: WAKE_COOLDOWN_MS });
        return;
      }

      // ④.5 没人在看就收工（社区实报「卡读图循环」的止血线，判据见 shouldGoIdle）
      if (shouldGoIdle({ wakesSinceUser, lastUserAt, windowOpen: windowAlive() })) {
        stop('idle');
        return;
      }

      // ⑤ 攒够一张**新的**图了 —— 这才是常态唤醒。
      // **必须按出图序号判重**：以前只看 `pending > 0`，而模型要是没调 `peek`
      // （比如它直接回了一句话），pending 一直是 1 —— 于是每 3 秒叫一次，
      // 一路叫到用户把它关掉。`pending` 只说明"队列里有一张"，不说明"是新的"。
      const pending = Number(st.pending) || 0;
      if (pending > 0 && lastPending === 0) pendingPulse += 1;
      lastPending = pending;
      const sheetSeq = Number(st.sheets ?? st.stats?.sheets ?? 0);
      const key = pending > 0 ? (sheetSeq > 0 ? `#${sheetSeq}` : `p${pendingPulse}`) : null;
      if (!key || key === lastKey) return;
      if (Date.now() - lastWakeAt < Math.max(0, wakeMinGapSec) * 1000) return;   // 下一拍再来

      // 叫醒了才算"这张已经叫过"。**失败不能记账**：记了的话下一拍看到 key 没变
      // 就不再重试，连续失败计数永远到不了上限 —— 于是"叫不醒"既不会重试也不会停。
      const text = scene
        ? '[看屏幕·逐场景] 换画面了。\n'
          + '调 `sense_now({action:"peek"})` 拿这一张（逐帧模式下它只有一帧、铺满整张图），'
          + '然后用 `say` **一句话**说清现在是什么场景 —— 用户要的就是"换一次说一次"，别省略。\n'
          + '一句话就行：说清画面里是什么，不要展开成段落，也不要重复上一句。'
          + lastSaidHint()
        : `[看屏幕] 有新画面了（这一张攒了 ${st.secondsSinceWake ?? '?'} 秒）。\n`
          + '调 `sense_now({action:"peek"})` 拿图看一眼，然后：值得说就用 `say` 说一句，'
          + '不值得说就什么都别做（沉默是允许的，别为了刷存在感而说话）。'
          + lastSaidHint();
      const ok = await wake(text);
      if (ok) { lastKey = key; wakesSinceUser += 1; }
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    ticker.dispose();
  }

  return {
    dispose,
    stopped: () => stopReason !== null,
    state: () => ({
      stopped: stopReason !== null,
      reason: stopReason,
      session: owner,
      wakes: wakeCount,
      wakeFailures,
      lastWakeAt: lastWakeAt || null,
      lastWakeOk,
      lastSheet: lastKey,
    }),
  };
}
