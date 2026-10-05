const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 剧团共享道具：导演按排练时段预约共享道具库存。
 *
 * 核心规则：
 *   - 道具目录为全剧团共享：导演登记 name/code 与“非负整数总件数” totalCount。
 *   - 每个“时段 × 道具”至多一条预约（upsert）：目标件数为非负整数，0 表示撤销。
 *   - 仅 status='active' 的时段预约占用库存；已取消、待调整时段的预约保留但不占用：
 *       取消时段 / 换版转待调整 -> 释放占用（记录仍保留，随时段移动）；
 *       待调整时段恢复有效（单条/批量调期）-> 预约随之落回新时段并重新校验库存。
 *   - 库存按“带时区时段归一化后的半开区间 [start, end)”计算：端点相接可复用；
 *     同一道具任一时刻的预约总量不得超过总件数。
 *   - 导演可一次修改多个时段的预约（跨排练），按整批最终状态校验；任一时刻不足则
 *     整批不生效（409 PROP_INVENTORY_CONFLICT），并返回道具、冲突时段与缺口。
 *   - 单条/批量调期时既有预约随时段移动，移动后库存不足则整个排期操作不生效
 *     （在 schedules.js 的事务中调用 assertPropInventoryAfterScheduleChanges）。
 *   - 下调道具总量同样校验全部有效预约；演员只能查看自己当前参与的有效时段的
 *     道具清单（只列道具与该时段件数），不能读取其他预约与余量信息。
 *
 * 依赖方向：props.js 不依赖 schedules.js（参与判定直接查表）；schedules.js 反向引用
 * 本模块导出的纯校验函数，无循环依赖。
 */

const router = express.Router();
router.use(authRequired);

// ---- 基础读取 ----
function getPropOrThrow(id) {
  const p = db.prepare('SELECT * FROM props WHERE id = ?').get(id);
  if (!p) throw notFound('道具不存在');
  return p;
}

function getScheduleOrThrow(scheduleId) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s) throw notFound('日程时段不存在');
  return s;
}

/** 预约行的“目标时段”引用（冲突详情用） */
function slotBrief(scheduleId, override = null) {
  const ov = override && override[scheduleId];
  const s = ov || db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s) return { id: scheduleId };
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(s.scene_id);
  const rehearsal = db.prepare('SELECT id, name FROM rehearsals WHERE id = ?').get(s.rehearsal_id);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    rehearsalName: rehearsal?.name ?? null,
    sceneId: s.scene_id,
    sceneTitle: scene ? `${scene.code} ${scene.title}` : null,
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
  };
}

/** 某道具当前存储的预约总量（含不占用的时段，仅作目录页展示） */
function reservedStoredCount(propId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM schedule_prop_reservations WHERE prop_id = ?')
    .get(propId);
  return row.n;
}

function serializeProp(p) {
  return {
    id: p.id,
    code: p.code || null,
    name: p.name,
    totalCount: p.total_count,
    reservedStored: reservedStoredCount(p.id),
    createdAt: p.created_at,
  };
}

// ---- 入参校验 ----
function parsePropName(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw badRequest('道具名称 name 必填');
  return name;
}

function parsePropCode(body, existing = '') {
  const raw = body?.code;
  const code = raw == null ? existing : String(raw).trim();
  return code;
}

function parseNonNegInt(value, field) {
  // 必须是非负整数：拒绝布尔、小数、负数、非数字、NaN
  if (typeof value === 'boolean') throw badRequest(`${field} 必须是非负整数`);
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw badRequest(`${field} 必须是非负整数`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`${field} 必须是非负整数`);
  return n;
}

/** 建/改道具时校验短码唯一（排除自身） */
function assertCodeUnique(code, exceptId = null) {
  if (!code) return;
  const row = db.prepare('SELECT id FROM props WHERE code = ?').get(code);
  if (row && row.id !== exceptId) throw badRequest(`已存在短码为「${code}」的道具`);
}

// ---- 库存计算（核心） ----
/**
 * 构造一组“假想状态”下的有效时段集合及其预约，用于按整批最终状态校验库存。
 *
 *   scheduleChanges: Map<scheduleId, { start_at, end_at, status }>
 *       单条/批量调期、恢复有效时，给出调后的时段（含状态）；不在表中的时段取库内值。
 *   reservationOverrides: Map<`${scheduleId}:${propId}`, quantity>
 *       单时段/批量预约提交：给出该组合的最终目标件数；0 等同撤销（行删除）。
 *       不传时全部取库内值（如仅调期、仅下调库存）。
 *
 * 返回：{ props: [{ id, name, code, total, bookings: [{scheduleId, qty, start, end}] }] }
 * 只包含 active 时段（调后/库内）的正整数预约。
 */
function buildPropState({ scheduleChanges = new Map(), reservationOverrides = null, stockOverrides = new Map() } = {}) {
  const props = db.prepare('SELECT * FROM props ORDER BY id').all();
  const reservations = db
    .prepare('SELECT * FROM schedule_prop_reservations ORDER BY id')
    .all();
  const scheduleCache = new Map();
  const effectiveSchedule = (scheduleId) => {
    if (scheduleCache.has(scheduleId)) return scheduleCache.get(scheduleId);
    let s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
    const ch = scheduleChanges.get(scheduleId);
    if (s && ch) {
      s = {
        ...s,
        start_at: ch.start_at ?? s.start_at,
        end_at: ch.end_at ?? s.end_at,
        status: ch.status ?? s.status,
      };
    }
    scheduleCache.set(scheduleId, s || null);
    return s;
  };

  const out = props.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code || null,
    total: stockOverrides.has(p.id) ? stockOverrides.get(p.id) : p.total_count,
    bookings: [],
  }));
  const byProp = new Map(out.map((p) => [p.id, p]));

  for (const r of reservations) {
    let qty = r.quantity;
    if (reservationOverrides) {
      const v = reservationOverrides.get(`${r.schedule_id}:${r.prop_id}`);
      if (v === 0) continue; // 撤销
      if (v != null) qty = v;
    }
    if (qty <= 0) continue;
    const s = effectiveSchedule(r.schedule_id);
    if (!s || s.status !== 'active') continue; // 已取消/待调整不占用
    const prop = byProp.get(r.prop_id);
    if (!prop) continue;
    prop.bookings.push({
      scheduleId: s.id,
      qty,
      start: Date.parse(s.start_at),
      end: Date.parse(s.end_at),
    });
  }

  // reservationOverrides 中可能包含库内尚无行的新组合
  if (reservationOverrides) {
    for (const [key, qty] of reservationOverrides) {
      if (qty == null || qty <= 0) continue;
      const [sidStr, pidStr] = key.split(':');
      const scheduleId = Number(sidStr);
      const propId = Number(pidStr);
      const exists = reservations.some((r) => r.schedule_id === scheduleId && r.prop_id === propId);
      if (exists) continue; // 已在上面处理
      const s = effectiveSchedule(scheduleId);
      if (!s || s.status !== 'active') continue;
      const prop = byProp.get(propId);
      if (!prop) continue;
      prop.bookings.push({
        scheduleId: s.id,
        qty,
        start: Date.parse(s.start_at),
        end: Date.parse(s.end_at),
      });
    }
  }
  return out;
}

/**
 * 扫面线：计算一组半开区间 [start, end) 在观察窗口内的峰值同时占用总量及构成时段。
 *   winStart/winEnd：观察窗口；窗口外的区间裁剪掉。
 * 同一时刻端点相接（前一个 end == 后一个 start）允许复用：
 *   事件排序中同一时间点先处理“结束（-q）”再处理“开始（+q）”。
 * 返回 { peak, members:[scheduleId,...], peakStart, peakEnd }（members 为峰值时刻在租时段，去重）。
 */
function windowPeak(bookings, winStart = -Infinity, winEnd = Infinity) {
  const events = [];
  for (const b of bookings) {
    const s = Math.max(b.start, winStart);
    const e = Math.min(b.end, winEnd);
    if (s >= e) continue;
    // type: 0=结束（先），1=开始（后）
    events.push({ t: s, type: 1, b });
    events.push({ t: e, type: 0, b });
  }
  events.sort((a, b) => (a.t - b.t || a.type - b.type));
  let current = 0;
  let active = new Map(); // scheduleId -> qty
  let peak = 0;
  let members = [];
  let peakStart = null;
  let peakEnd = null;
  let peakStartIdx = -1;
  // 峰值区间：从成为峰值的“开始事件”到下一个事件时间点
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 0) {
      current -= ev.b.qty;
      active.delete(ev.b.scheduleId);
    } else {
      current += ev.b.qty;
      active.set(ev.b.scheduleId, (active.get(ev.b.scheduleId) ?? 0) + ev.b.qty);
      if (current > peak) {
        peak = current;
        members = [...active.keys()];
        peakStart = ev.t;
        peakStartIdx = i;
      }
    }
  }
  if (peakStartIdx >= 0) {
    for (let i = peakStartIdx + 1; i < events.length; i++) {
      if (events[i].t > events[peakStartIdx].t) {
        peakEnd = events[i].t;
        break;
      }
    }
  }
  return { peak, members, peakStart, peakEnd };
}

/**
 * 按整批最终状态检测道具库存冲突。
 * 返回冲突列表：[{ propId, propName, propCode, stock, peakUsage, shortage,
 *                  windowStart, windowEnd, schedules:[时段引用] }]
 */
function findPropConflicts({ scheduleChanges, reservationOverrides, stockOverrides } = {}) {
  const state = buildPropState({ scheduleChanges, reservationOverrides, stockOverrides });
  const conflicts = [];
  for (const prop of state) {
    const { peak, members, peakStart, peakEnd } = windowPeak(prop.bookings);
    if (peak > prop.total) {
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        propCode: prop.code,
        stock: prop.total,
        peakUsage: peak,
        shortage: peak - prop.total,
        windowStart: peakStart != null ? new Date(peakStart).toISOString() : null,
        windowEnd: peakEnd != null ? new Date(peakEnd).toISOString() : null,
        schedules: members
          .slice()
          .sort((a, b) => a - b)
          .map((sid) => slotBrief(sid, scheduleChanges)),
      });
    }
  }
  return conflicts;
}

/** 校验库存，不足则抛 409 PROP_INVENTORY_CONFLICT（调用方事务随之回滚，整批不生效） */
function assertPropInventory(hypo, message) {
  const conflicts = findPropConflicts(hypo);
  if (conflicts.length) throw conflict('PROP_INVENTORY_CONFLICT', message, { conflicts });
}

/**
 * 单条 / 批量调期后（在 schedules.js 的事务内调用）：
 *   既有预约随时段移动，按调后的有效时段集合重算库存；不足则抛 409，整个调期操作回滚。
 *   changedSchedules: Map<scheduleId, { start_at, end_at, status }>
 */
function assertPropInventoryAfterScheduleChanges(changedSchedules, message = '调期后共享道具库存不足，本次操作未生效') {
  assertPropInventory({ scheduleChanges: changedSchedules }, message);
}

// ---- 时段视图：本时段预约 + 时段内库存余量 ----
/**
 * 计算某时段窗口内、各道具的峰值占用与最低余量。
 * includeOwn=false：排除该时段自身（用于查看“该时段之外在这段时间的占用”）。
 */
function windowUsageByProp(scheduleId, includeOwn) {
  const sched = db.prepare('SELECT start_at, end_at FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  const winStart = Date.parse(sched.start_at);
  const winEnd = Date.parse(sched.end_at);
  const rows = db
    .prepare(
      `SELECT r.prop_id, r.schedule_id, r.quantity, s.start_at, s.end_at
         FROM schedule_prop_reservations r
         JOIN rehearsal_schedules s ON s.id = r.schedule_id
        WHERE s.status = 'active' AND r.quantity > 0
          ${includeOwn ? '' : 'AND r.schedule_id <> ?'}
          AND s.start_at < ? AND ? < s.end_at`
    )
    .all(...(includeOwn ? [] : [scheduleId]), winEnd, winStart);
  const byProp = new Map();
  for (const r of rows) {
    if (!byProp.has(r.prop_id)) byProp.set(r.prop_id, []);
    byProp.get(r.prop_id).push({
      scheduleId: r.schedule_id,
      qty: r.quantity,
      start: Date.parse(r.start_at),
      end: Date.parse(r.end_at),
    });
  }
  return { winStart, winEnd, byProp };
}

/** 该时段各道具的本时段件数（库内存储值，不区分时段是否有效） */
function reservationsForSchedule(scheduleId) {
  return db
    .prepare(
      `SELECT r.*, p.name AS prop_name, p.code AS prop_code, p.total_count
         FROM schedule_prop_reservations r
         JOIN props p ON p.id = r.prop_id
        WHERE r.schedule_id = ? ORDER BY p.id`
    )
    .all(scheduleId);
}

/** 日程列表摘要：本时段已登记的道具与件数（导演/演员视图共用；演员侧仅在自己参与时由调用方暴露） */
function slotReservationsSummary(scheduleId) {
  return reservationsForSchedule(scheduleId)
    .filter((r) => r.quantity > 0)
    .map((r) => ({
      propId: r.prop_id,
      propCode: r.prop_code || null,
      propName: r.prop_name,
      quantity: r.quantity,
    }));
}

/**
 * 导演视角：时段预约与“时段内最低余量”。
 * 余量按半开区间计算（端点相接可复用），统计“除本时段外”其他有效时段在本时段窗口内的
 * 峰值占用；minRemaining = 总件数 - 峰值占用。
 */
function slotPropViewForDirector(scheduleId) {
  const s = getScheduleOrThrow(scheduleId);
  const own = new Map(reservationsForSchedule(scheduleId).map((r) => [r.prop_id, r]));
  const { byProp } = windowUsageByProp(scheduleId, false);
  const allProps = db.prepare('SELECT * FROM props ORDER BY id').all();
  const items = allProps.map((p) => {
    const ownQty = own.get(p.id)?.quantity ?? 0;
    const others = byProp.get(p.id) || [];
    const { peak, members } = windowPeak(others, Date.parse(s.start_at), Date.parse(s.end_at));
    return {
      propId: p.id,
      propCode: p.code || null,
      propName: p.name,
      totalCount: p.total_count,
      reserved: ownQty, // 本时段预约件数（0/未预约不返回行时也显式给 0）
      otherPeakUsage: peak, // 时段内其他有效时段的峰值占用
      minRemaining: p.total_count - peak, // 时段内最低余量（不含本时段）
      peakSchedules: members.slice().sort((a, b) => a - b).map((sid) => slotBrief(sid)),
    };
  });
  return {
    schedule: slotBrief(scheduleId),
    items,
  };
}

/** 演员视角：仅返回自己当前参与的有效时段“已预约”的道具清单（不暴露余量/其他时段） */
function slotPropViewForActor(scheduleId, actorId) {
  const s = getScheduleOrThrow(scheduleId);
  if (s.status !== 'active') throw forbidden('该时段当前不是有效时段');
  // 参与判定：排练当前固定版本中本场次有台词的角色，且已派给该演员（动态计算）
  const isParticipant = db
    .prepare(
      `SELECT 1
         FROM version_lines vl
         JOIN rehearsal_cast c ON c.rehearsal_id = ? AND c.role_id = vl.role_id AND c.actor_id = ?
        WHERE vl.version_id = (SELECT version_id FROM rehearsals WHERE id = ?)
          AND vl.scene_id = ?
        LIMIT 1`
    )
    .get(s.rehearsal_id, actorId, s.rehearsal_id, s.scene_id);
  if (!isParticipant) throw forbidden('你当前未参与该时段，不能查看其道具清单');
  const rows = reservationsForSchedule(scheduleId).filter((r) => r.quantity > 0);
  return {
    schedule: { id: s.id, rehearsalId: s.rehearsal_id, sceneId: s.scene_id, startAt: s.start_at, endAt: s.end_at },
    items: rows.map((r) => ({
      propId: r.prop_id,
      propCode: r.prop_code || null,
      propName: r.prop_name,
      quantity: r.quantity,
    })),
  };
}

// ---- 预约条目解析（单时段 / 批量共用） ----
function parseQuantity(raw, where) {
  // 严格非负整数
  if (typeof raw === 'boolean' || raw === null || raw === undefined || raw === '') {
    throw badRequest(`${where}：quantity 必填且为非负整数（0 表示撤销）`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || String(raw).trim() === '') {
    throw badRequest(`${where}：quantity 必须是非负整数（0 表示撤销）`);
  }
  return n;
}

/**
 * 校验并解析一批预约条目：
 *   [{ scheduleId, propId, quantity }]
 * - 同批重复的“时段 × 道具”组合 -> 400；
 * - 时段不存在 -> 404；道具不存在 -> 404（批量跨时段，无法由路径提供归属，统一 404）；
 * - 仅有效时段可登记预约；已取消/待调整 -> 400；
 * - quantity 非负整数；同一 scheduleId 下重复 propId 也按重复组合拒绝。
 * 返回归一化后的条目列表。
 */
function parseReservationItems(items, { requireMin = 1 } = {}) {
  if (!Array.isArray(items)) {
    throw badRequest('请求体须为 items 数组（每项含 scheduleId、propId 与非负整数 quantity）');
  }
  if (items.length < requireMin) {
    throw badRequest(
      requireMin > 1
        ? `批量预约一次至少提交 ${requireMin} 条`
        : '预约条目不能为空'
    );
  }
  const seen = new Set();
  const parsed = [];
  items.forEach((item, idx) => {
    const where = `第 ${idx + 1} 条`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`${where}：条目必须是对象`);
    }
    const scheduleId = Number(item.scheduleId);
    const propId = Number(item.propId);
    if (!Number.isInteger(scheduleId)) throw badRequest(`${where}：scheduleId 必填且为整数`);
    if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
    const key = `${scheduleId}:${propId}`;
    if (seen.has(key)) {
      throw badRequest(`${where}：批次中存在重复的时段与道具组合（时段 #${scheduleId} × 道具 #${propId}）`);
    }
    seen.add(key);
    const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
    if (!s) throw notFound(`${where}：时段 #${scheduleId} 不存在`);
    const p = db.prepare('SELECT * FROM props WHERE id = ?').get(propId);
    if (!p) throw notFound(`${where}：道具 #${propId} 不存在`);
    if (s.status === 'cancelled') {
      throw badRequest(`${where}：时段 #${scheduleId} 已取消，不能登记道具预约`);
    }
    if (s.status === 'needs_adjustment') {
      throw badRequest(`${where}：时段 #${scheduleId} 为待调整状态，恢复有效后才能登记道具预约`);
    }
    const quantity = parseQuantity(item.quantity, where);
    parsed.push({ scheduleId, propId, quantity });
  });
  return parsed;
}

/** 应用一批预约（upsert；quantity=0 删除行），不做冲突校验（调用方负责在同事务内断言）。
 *  返回每条的动作（按写入前是否已有行判定）：set=新建 / updated=改写 / revoked=撤销。 */
function applyReservationItems(parsed, actorId) {
  const exists = db.prepare(
    'SELECT 1 FROM schedule_prop_reservations WHERE schedule_id = ? AND prop_id = ?'
  );
  const upsert = db.prepare(
    `INSERT INTO schedule_prop_reservations (schedule_id, prop_id, quantity, created_by, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (schedule_id, prop_id)
     DO UPDATE SET quantity = excluded.quantity, updated_by = excluded.updated_by, updated_at = datetime('now')`
  );
  const del = db.prepare('DELETE FROM schedule_prop_reservations WHERE schedule_id = ? AND prop_id = ?');
  const outcomes = [];
  for (const x of parsed) {
    const had = !!exists.get(x.scheduleId, x.propId);
    let action;
    if (x.quantity === 0) {
      del.run(x.scheduleId, x.propId);
      action = 'revoked';
    } else {
      upsert.run(x.scheduleId, x.propId, x.quantity, actorId, actorId);
      action = had ? 'updated' : 'set';
    }
    outcomes.push({ ...x, action });
  }
  return outcomes;
}

/** 批量/单条响应逐条结果（附道具名/短码与最终件数） */
function formatResult(r) {
  const p = db.prepare('SELECT name, code FROM props WHERE id = ?').get(r.propId);
  return {
    scheduleId: r.scheduleId,
    propId: r.propId,
    propName: p.name,
    propCode: p.code || null,
    quantity: r.quantity,
    action: r.action,
  };
}

// ============================ 路由 ============================

function directorOnly(req) {
  if (req.user.role !== 'director') throw forbidden('仅导演可管理共享道具');
}

// ---- 道具目录：列表（导演） ----
router.get(
  '/props',
  wrap((req, res) => {
    directorOnly(req);
    const props = db.prepare('SELECT * FROM props ORDER BY id').all();
    res.json({ props: props.map(serializeProp) });
  })
);

// ---- 登记道具（导演） ----
router.post(
  '/props',
  wrap((req, res) => {
    directorOnly(req);
    const name = parsePropName(req.body);
    const code = parsePropCode(req.body, '');
    const totalCount = parseNonNegInt(req.body?.totalCount ?? 0, 'totalCount');
    assertCodeUnique(code);
    const id = transaction(() =>
      db
        .prepare('INSERT INTO props (code, name, total_count, created_by) VALUES (?, ?, ?, ?)')
        .run(code, name, totalCount, req.user.id).lastInsertRowid
    );
    res.status(201).json({ prop: serializeProp(getPropOrThrow(id)) });
  })
);

// ---- 修改道具：名称/短码/总件数（导演；下调总件数须校验有效预约） ----
router.patch(
  '/props/:id',
  wrap((req, res) => {
    directorOnly(req);
    const p = getPropOrThrow(req.params.id);
    const body = req.body || {};
    if (['name', 'code', 'totalCount'].every((k) => body[k] === undefined)) {
      throw badRequest('没有需要修改的字段（name/code/totalCount）');
    }
    const name = body.name !== undefined ? parsePropName(body) : p.name;
    const code = body.code !== undefined ? parsePropCode(body, p.code || '') : p.code || '';
    const totalCount =
      body.totalCount !== undefined ? parseNonNegInt(body.totalCount, 'totalCount') : p.total_count;
    assertCodeUnique(code, p.id);
    transaction(() => {
      // 下调（或任意设置）总件数：以最终总件数校验全部有效预约，不足则整体不生效
      if (body.totalCount !== undefined) {
        assertPropInventory(
          { stockOverrides: new Map([[p.id, totalCount]]) },
          '下调后的道具总件数无法满足现有有效时段预约，本次修改未生效'
        );
      }
      db.prepare('UPDATE props SET name = ?, code = ?, total_count = ? WHERE id = ?').run(
        name,
        code,
        totalCount,
        p.id
      );
    });
    res.json({ prop: serializeProp(getPropOrThrow(p.id)) });
  })
);

// ---- 简洁的时段索引（导演）：用于跨排练批量预约时选择时段 ----
router.get(
  '/schedules',
  wrap((req, res) => {
    directorOnly(req);
    const rows = db
      .prepare(
        `SELECT s.*, r.name AS rehearsal_name, sc.code AS scene_code, sc.title AS scene_title
           FROM rehearsal_schedules s
           JOIN rehearsals r ON r.id = s.rehearsal_id
           JOIN scenes sc ON sc.id = s.scene_id
          ORDER BY s.start_at, s.id`
      )
      .all();
    res.json({
      schedules: rows.map((s) => ({
        id: s.id,
        rehearsalId: s.rehearsal_id,
        rehearsalName: s.rehearsal_name,
        sceneId: s.scene_id,
        sceneTitle: `${s.scene_code} ${s.scene_title}`,
        startAt: s.start_at,
        endAt: s.end_at,
        status: s.status,
      })),
    });
  })
);

// ---- 单时段：查看预约与时段内最低余量（导演）/ 已预约道具清单（演员） ----
router.get(
  '/schedules/:scheduleId/props',
  wrap((req, res) => {
    if (req.user.role === 'director') {
      return res.json(slotPropViewForDirector(req.params.scheduleId));
    }
    res.json(slotPropViewForActor(req.params.scheduleId, req.user.id));
  })
);

// ---- 单时段：为该时段登记/调整多个道具的预约（导演；0 表示撤销） ----
router.put(
  '/rehearsals/:id/schedules/:scheduleId/props',
  wrap((req, res) => {
    directorOnly(req);
    const rehearsal = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(req.params.id);
    if (!rehearsal) throw notFound('排练不存在');
    const s = db
      .prepare('SELECT * FROM rehearsal_schedules WHERE id = ? AND rehearsal_id = ?')
      .get(req.params.scheduleId, rehearsal.id);
    if (!s) throw notFound('日程时段不存在');
    if (s.status !== 'active') {
      throw badRequest(
        s.status === 'cancelled'
          ? '该时段已取消，不能登记道具预约'
          : '该时段为待调整状态，恢复有效后才能登记道具预约'
      );
    }

    // 兼容 { items:[...] } 与单条扁平对象 { propId, quantity }
    const rawItems = Array.isArray(req.body?.items)
      ? req.body.items
      : req.body && req.body.propId != null
        ? [req.body]
        : req.body?.items;
    const parsed0 = parseReservationItems(
      Array.isArray(rawItems)
        ? rawItems.map((x) => ({ ...x, scheduleId: x.scheduleId ?? s.id }))
        : rawItems,
      { requireMin: 1 }
    );
    // 路径已限定时段：拒绝跨时段条目
    if (parsed0.some((x) => x.scheduleId !== s.id)) {
      throw badRequest('该接口只能为本时段登记道具预约；跨时段请使用批量预约接口');
    }

    const overrides = new Map(parsed0.map((x) => [`${x.scheduleId}:${x.propId}`, x.quantity]));
    const results = transaction(() => {
      const applied = applyReservationItems(parsed0, req.user.id);
      assertPropInventory(
        { reservationOverrides: overrides },
        '道具库存不足，本次预约未生效'
      );
      return applied;
    });
    res.json({ ok: true, results: results.map(formatResult), slot: slotPropViewForDirector(s.id) });
  })
);

// ---- 批量：一次修改多个时段的道具预约（导演，可跨排练；按整批最终状态校验） ----
router.post(
  '/prop-reservations/batch',
  wrap((req, res) => {
    directorOnly(req);
    const parsed = parseReservationItems(req.body?.items ?? req.body, { requireMin: 1 });
    const overrides = new Map(parsed.map((x) => [`${x.scheduleId}:${x.propId}`, x.quantity]));
    const results = transaction(() => {
      const applied = applyReservationItems(parsed, req.user.id);
      assertPropInventory(
        { reservationOverrides: overrides },
        '批量预约后存在道具库存不足，本次整批预约未生效'
      );
      return applied;
    });
    // 受影响时段的导演视图
    const slotIds = [...new Set(parsed.map((x) => x.scheduleId))].sort((a, b) => a - b);
    res.json({
      ok: true,
      results: results.map(formatResult),
      slots: slotIds.map((sid) => slotPropViewForDirector(sid)),
    });
  })
);

module.exports = {
  router,
  findPropConflicts,
  assertPropInventory,
  assertPropInventoryAfterScheduleChanges,
  buildPropState,
  windowPeak,
  slotReservationsSummary,
};
