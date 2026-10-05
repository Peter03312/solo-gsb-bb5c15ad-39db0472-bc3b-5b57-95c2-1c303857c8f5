/* 导演：共享道具目录 + 按时段批量预约；演员：我参与时段的道具清单 */

/** 409 PROP_INVENTORY_CONFLICT：把道具、冲突时段与缺口格式化为可读提示 */
function propInventoryErr(err) {
  const conflicts = err?.data?.details?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length) {
    const lines = conflicts.map((c) => {
      const scheds = c.schedules
        .map((s) => `${s.rehearsalName ? `「${s.rehearsalName}」` : ''}${s.sceneTitle || ''} ${fmtTime(s.startAt)}→${fmtTime(s.endAt)}`)
        .join('；');
      return `道具「${c.propName}」库存 ${c.stock}，峰值需 ${c.peakUsage}，缺口 ${c.shortage}（冲突时段：${scheds}）`;
    });
    return `${err.message}：${lines.join(' ｜ ')}`;
  }
  return err.message;
}

/* ---------------- 导演：共享道具页 ---------------- */
async function loadPropsTab() {
  const panel = document.getElementById('tab-props');
  panel.innerHTML = '<p class="muted">加载中…</p>';
  let props;
  let schedules;
  try {
    ([{ props }, { schedules }] = await Promise.all([
      api('GET', '/api/props'),
      api('GET', '/api/schedules'),
    ]));
  } catch (err) {
    panel.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    return;
  }

  // —— 登记/修改目录 ——
  const cat = el(`
    <div class="card">
      <h2>共享道具目录</h2>
      <div class="muted">全剧团共享，按有效排练时段占用库存；端点相接可复用。仅有效时段占用，取消/待调整释放。</div>
      <div class="propRows" style="margin-top:8px"></div>
      <form class="flex propForm" style="margin-top:8px">
        <input name="code" placeholder="短码（可选，唯一）" style="max-width:150px" />
        <input name="name" placeholder="道具名称（必填）" required style="max-width:180px" />
        <input name="totalCount" type="number" min="0" step="1" value="0" required style="max-width:110px" title="总件数（非负整数）" />
        <button class="btn small primary propSubmit" type="submit">登记道具</button>
        <button class="btn small propCancelEdit hidden" type="button">放弃修改</button>
      </form>
      <div class="muted">总件数为非负整数；下调总件数若不足以覆盖现有有效时段预约，整次修改不生效。</div>
    </div>`);
  const form = cat.querySelector('.propForm');
  const submitBtn = cat.querySelector('.propSubmit');
  const cancelBtn = cat.querySelector('.propCancelEdit');
  let editingId = null;
  const resetEdit = () => {
    editingId = null;
    submitBtn.textContent = '登记道具';
    cancelBtn.classList.add('hidden');
    form.reset();
    form.totalCount.value = '0';
  };
  cancelBtn.addEventListener('click', resetEdit);

  const rowsBox = cat.querySelector('.propRows');
  function renderRows() {
    rowsBox.innerHTML = props.length
      ? `<table><tr><th>短码</th><th>道具</th><th>总件数</th><th>已登记（含不占用）</th><th>操作</th></tr>
        ${props
          .map(
            (p) => `<tr>
            <td>${p.code ? esc(p.code) : '<span class="muted">—</span>'}</td>
            <td>${esc(p.name)}</td>
            <td>${p.totalCount}</td>
            <td>${p.reservedStored}</td>
            <td><button class="btn small editProp" data-id="${p.id}">修改</button></td>
          </tr>`
          )
          .join('')}</table>`
      : '<span class="muted">尚未登记共享道具</span>';
    rowsBox.querySelectorAll('.editProp').forEach((b) =>
      b.addEventListener('click', () => {
        const p = props.find((x) => String(x.id) === b.dataset.id);
        if (!p) return;
        editingId = p.id;
        form.code.value = p.code || '';
        form.name.value = p.name;
        form.totalCount.value = p.totalCount;
        submitBtn.textContent = '保存修改';
        cancelBtn.classList.remove('hidden');
      })
    );
  }
  renderRows();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      code: String(fd.get('code') || '').trim(),
      name: fd.get('name'),
      totalCount: Number(fd.get('totalCount')),
    };
    try {
      if (editingId) {
        await api('PATCH', `/api/props/${editingId}`, body);
        toast('道具已更新');
      } else {
        await api('POST', '/api/props', body);
        toast('道具已登记');
      }
      resetEdit();
      loadPropsTab();
    } catch (err) {
      toast(propInventoryErr(err), true);
    }
  });
  panel.appendChild(cat);

  // —— 按时段批量预约 ——
  const activeSchedules = schedules.filter((s) => s.status === 'active');
  const batch = el(`
    <div class="card" style="margin-top:12px">
      <h2>按排练时段预约道具</h2>
      <div class="muted">一次可添加多条“时段 × 道具 × 件数”，跨排练亦可；件数为非负整数，0 表示撤销。
        按整批最终状态校验：任一时刻库存不足则整批不生效，并给出道具、冲突时段与缺口。</div>
      <form class="propBatchForm" style="margin-top:8px">
        <div class="batchPropRows"></div>
        <div class="flex" style="margin-top:6px">
          <button class="btn small addPropRow" type="button">＋ 添加一行</button>
          <button class="btn small primary submitPropBatch" type="submit">整批提交</button>
        </div>
      </form>
      <div class="batchPropResult muted" style="margin-top:8px"></div>
    </div>`);
  const rows = batch.querySelector('.batchPropRows');
  const resultBox = batch.querySelector('.batchPropResult');
  const propOptions = props
    .map((p) => `<option value="${p.id}">${esc(p.name)}（库存 ${p.totalCount}${p.code ? ` · ${esc(p.code)}` : ''}）</option>`)
    .join('');
  const schedOptions = activeSchedules
    .map(
      (s) =>
        `<option value="${s.id}">#${s.id} ${esc(s.rehearsalName)} · ${esc(s.sceneTitle)} · ${fmtTime(s.startAt)}→${fmtTime(s.endAt)}</option>`
    )
    .join('');

  function addRow() {
    const row = el(`
      <div class="flex propRow" style="margin-top:6px">
        <select class="rSchedule" style="max-width:340px" required>${schedOptions}</select>
        <select class="rProp" style="max-width:200px">${propOptions}</select>
        <input class="rQty" type="number" min="0" step="1" value="1" required style="max-width:90px" title="目标件数（0=撤销）" />
        <button class="btn small danger delRow" type="button">删除</button>
      </div>`);
    row.querySelector('.delRow').addEventListener('click', () => row.remove());
    rows.appendChild(row);
  }
  batch.querySelector('.addPropRow').addEventListener('click', addRow);
  addRow();

  batch.querySelector('.propBatchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = [...batch.querySelectorAll('.propRow')].map((r) => ({
      scheduleId: Number(r.querySelector('.rSchedule').value),
      propId: Number(r.querySelector('.rProp').value),
      quantity: Number(r.querySelector('.rQty').value),
    }));
    if (!items.length) {
      toast('请至少添加一行', true);
      return;
    }
    try {
      const data = await api('POST', '/api/prop-reservations/batch', { items });
      resultBox.textContent = `已生效 ${data.results.length} 条：` +
        data.results
          .map((r) => `#${r.scheduleId}「${r.propName}」×${r.quantity}（${{ set: '新建', updated: '调整', revoked: '撤销' }[r.action]}）`)
          .join('；');
      toast('整批预约已生效');
      loadPropsTab();
    } catch (err) {
      toast(propInventoryErr(err), true);
      resultBox.textContent = '';
    }
  });
  panel.appendChild(batch);
}

/* ---------------- 演员：我参与时段的道具清单 ---------------- */
async function renderMyPropsCard() {
  const card = el(`
    <div class="card">
      <h2>我的时段道具</h2>
      <div class="myPropRows muted">加载中…</div>
      <div class="muted">仅显示你当前参与的有效时段已预约的共享道具与件数；取消或待调整时段不显示。</div>
    </div>`);
  const box = card.querySelector('.myPropRows');
  let rehearsals;
  try {
    ({ rehearsals } = await api('GET', '/api/rehearsals'));
  } catch (err) {
    box.textContent = err.message;
    return card;
  }
  const slots = [];
  for (const r of rehearsals) {
    let data;
    try {
      data = await api('GET', `/api/rehearsals/${r.id}/schedules`);
    } catch {
      continue;
    }
    for (const s of data.schedules || []) {
      if ((s.propReservations || []).length) {
        slots.push({ rehearsalName: r.name, s });
      }
    }
  }
  slots.sort((a, b) => new Date(a.s.startAt) - new Date(b.s.startAt));
  box.innerHTML = slots.length
    ? `<table><tr><th>排练 / 场次</th><th>时间</th><th>道具</th></tr>
      ${slots
        .map(
          ({ rehearsalName, s }) => `<tr>
        <td>${esc(rehearsalName)}<div class="muted">${esc(s.sceneCode)} ${esc(s.sceneTitle)}</div></td>
        <td>${fmtTime(s.startAt)} → ${fmtTime(s.endAt)}</td>
        <td>${s.propReservations.map((p) => `${esc(p.propName)} ×${p.quantity}`).join('、')}</td>
      </tr>`
        )
        .join('')}</table>`
    : '<span class="muted">你当前参与的有效时段暂无道具预约</span>';
  return card;
}
