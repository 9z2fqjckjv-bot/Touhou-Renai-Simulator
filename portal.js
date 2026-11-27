/**
 * 東方Project恋愛シミュレーター 実費分担サポーター＆PayPal定期購読 Webポータル (portal.js v2.1)
 *   - PayPal Live 全10製品グループ (THRENAI-DEPOSIT-500..10000 / THRENAI-VOICE-*)
 *     および全10購読プラン (Billing Plans: P-...) 完全紐づけ
 *   - PayPal サブスクリプション購読登録 (vault=true&intent=subscription / createSubscription)
 *     ＋ 公式ホスト型購読URL直リンク ＋ 1回のみ購入 (intent=capture / createOrder) 切替対応
 */

const portalState = {
  apiBase: "",
  serverOnline: false,
  campaign: null,
  paymentMode: "subscription", // "subscription" | "one_time"
  orderKind: "deposit",        // "deposit" | "voice_direct"
  selectedSku: "",
  comboVoiceId: "",
  comboPromptId: "",
  paypalSdkLoadedKey: "",
  lastReceipt: null,
};

const $ = (id) => document.getElementById(id);

function fmtYen(n) {
  return `¥${Math.round(Number(n || 0)).toLocaleString("ja-JP")}`;
}

function calcFeeAndNet(grossYen, ppCfg) {
  const rate = Number(ppCfg?.fee_rate ?? 0.036);
  const fixed = Number(ppCfg?.fee_fixed_yen ?? 40);
  const fee = Math.floor(grossYen * rate) + fixed;
  return { fee, net: Math.max(0, grossYen - fee) };
}

function formatGrantsShort(grants = {}) {
  const parts = [];
  if (grants.voice_pass_days >= 365) parts.push("1年フルボイスパス");
  else if (grants.voice_pass_days > 0) parts.push(`${grants.voice_pass_days}日フルボイスパス`);
  if (grants.voice_credits > 0) parts.push(`ボイス${grants.voice_credits}枠`);
  if (grants.prompts > 0) parts.push(`AI対話${Number(grants.prompts).toLocaleString()}p`);
  if (grants.deposit_yen > 0) parts.push(`デポジット残高${fmtYen(grants.deposit_yen)}`);
  return parts.join(" ＋ ") || "実費分担サポーター枠";
}

function resolveInitialApiBase() {
  const params = new URLSearchParams(window.location.search);
  const qApi = params.get("api");
  if (qApi) {
    const clean = qApi.replace(/\/$/, "");
    localStorage.setItem("threnai_api_base", clean);
    return clean;
  }
  const saved = localStorage.getItem("threnai_api_base");
  if (saved) return saved.replace(/\/$/, "");
  if (window.location.port === "8096" || window.location.pathname.startsWith("/portal")) {
    return window.location.origin;
  }
  return "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadCampaignData() {
  let snapshot = null;
  try {
    const snapResp = await fetch("./campaign_snapshot.json", { cache: "no-store" });
    if (snapResp.ok) snapshot = await snapResp.json();
  } catch (_) {}

  const candidateBase = portalState.apiBase || snapshot?.public_api_base || "";
  if (candidateBase) {
    try {
      const liveResp = await fetchWithTimeout(`${candidateBase.replace(/\/$/, "")}/api/public/campaign_status`);
      if (liveResp.ok) {
        portalState.apiBase = candidateBase.replace(/\/$/, "");
        portalState.serverOnline = true;
        portalState.campaign = await liveResp.json();
        if ($("inp-api-base")) $("inp-api-base").value = portalState.apiBase;
        return;
      }
    } catch (_) {}
  }

  if (!portalState.apiBase && window.location.protocol === "http:") {
    for (const localCandidate of ["http://127.0.0.1:8096", "http://debian.local:8096"]) {
      try {
        const r = await fetchWithTimeout(`${localCandidate}/api/public/campaign_status`, {}, 1800);
        if (r.ok) {
          portalState.apiBase = localCandidate;
          portalState.serverOnline = true;
          portalState.campaign = await r.json();
          if ($("inp-api-base")) $("inp-api-base").value = portalState.apiBase;
          return;
        }
      } catch (_) {}
    }
  }

  portalState.serverOnline = false;
  if (snapshot) portalState.campaign = snapshot;
}

function renderCampaignUI() {
  const c = portalState.campaign;
  if (!c) return;

  if (c.title) $("hero-title").textContent = c.title;
  if (c.subtitle) $("hero-subtitle").textContent = c.subtitle;
  if (c.guideline_compliance?.statement) {
    $("guideline-statement").textContent = c.guideline_compliance.statement;
  }

  const syncBadge = $("server-sync-badge");
  if (portalState.serverOnline) {
    syncBadge.className = "live-dot";
    syncBadge.textContent = "自宅Debianサーバー(8096) リアルタイム同期中";
  } else {
    syncBadge.className = "live-dot offline";
    syncBadge.textContent = "公開スナップショット表示中 (PayPal Live購読有効)";
  }
  $("meter-period-label").textContent = `対象期間: ${c.period_key || "year_1"}`;

  const vp = c.voice_pool || { target_yen: 157300, collected_yen: 0, remaining_yen: 157300, progress_pct: 0, is_goal_reached: false };
  $("voice-collected-yen").textContent = fmtYen(vp.collected_yen);
  $("voice-target-yen").textContent = fmtYen(vp.target_yen);
  $("voice-remaining-yen").textContent = fmtYen(vp.remaining_yen);
  $("voice-progress-bar").style.width = `${Math.min(100, Number(vp.progress_pct || 0))}%`;
  $("kpi-pct").textContent = vp.is_goal_reached ? "100% 達成!" : `${Number(vp.progress_pct || 0).toFixed(1)}%`;
  $("kpi-ops-yen").textContent = fmtYen(c.ops_fund_collected_yen || 0);
  $("kpi-supporters").textContent = `${Number(c.supporters_count || 0)}件`;

  const miniWrap = $("hero-mini-buckets");
  const detailWrap = $("buckets-detail-grid");
  miniWrap.innerHTML = "";
  detailWrap.innerHTML = "";

  (c.buckets || []).forEach((b) => {
    const mini = document.createElement("div");
    mini.className = "mini-bucket-item";
    const head = document.createElement("div");
    head.className = "mini-bucket-head";
    const lSpan = document.createElement("span");
    lSpan.textContent = b.label;
    const rSpan = document.createElement("span");
    rSpan.textContent = b.target_yen > 0
      ? `${fmtYen(b.collected_yen)} / ${fmtYen(b.target_yen)} (${b.progress_pct}%)`
      : `累計原資 ${fmtYen(b.collected_yen)}`;
    head.append(lSpan, rSpan);

    const bar = document.createElement("div");
    bar.className = "mini-bar";
    const fill = document.createElement("div");
    fill.style.width = `${b.target_yen > 0 ? Math.min(100, Number(b.progress_pct || 0)) : (b.collected_yen > 0 ? 100 : 8)}%`;
    bar.appendChild(fill);
    mini.append(head, bar);
    miniWrap.appendChild(mini);

    const card = document.createElement("article");
    card.className = "info-card";
    const h3 = document.createElement("h3");
    h3.textContent = b.label;
    const amt = document.createElement("div");
    amt.className = "cost-amount";
    amt.textContent = b.target_yen > 0 ? fmtYen(b.target_yen) : `変動費（累計 ${fmtYen(b.collected_yen)}）`;
    const sub = document.createElement("p");
    sub.style.marginBottom = "10px";
    sub.style.fontSize = "0.82rem";
    sub.style.color = b.is_reached ? "#6ee7b7" : "#38bdf8";
    sub.textContent = b.target_yen > 0
      ? (b.is_reached ? "🎉 100%回収達成（自動ストッパー発動済）" : `現在 ${fmtYen(b.collected_yen)} 回収済（残り ${fmtYen(b.remaining_yen)}）`)
      : "定期購読・都度デポジット実効残高から原価充当（APIキー指定モードは¥0）";
    const desc = document.createElement("p");
    desc.textContent = b.description;
    card.append(h3, amt, sub, desc);
    detailWrap.appendChild(card);
  });

  if (c.downloads?.all_os_zip_url) $("link-dl-zip").href = c.downloads.all_os_zip_url;
  if (c.downloads?.repo_url) $("link-dl-repo").href = c.downloads.repo_url;
  if (c.organizer?.handle) {
    $("legal-organizer").textContent = `${c.organizer.type || "個人開発"} — ${c.organizer.handle}`;
  }
  if (c.organizer?.contact_email) {
    $("legal-email").textContent = c.organizer.contact_email;
    $("legal-email").href = `mailto:${c.organizer.contact_email}`;
  }

  renderSubscriptionCatalogTable();
  renderPromptReferenceTable();
  renderProductsSection();
  renderSupportersWall();
}

function selectPlanAndFocusCheckout(kind, sku, forceMode = "subscription") {
  portalState.orderKind = kind;
  portalState.selectedSku = sku;
  if (kind === "deposit") {
    const dep = (portalState.campaign?.deposit_products || []).find((d) => d.sku === sku);
    if (dep) applyRecommendedComboForDeposit(dep);
  }
  const modeChanged = portalState.paymentMode !== forceMode;
  portalState.paymentMode = forceMode;
  renderProductsSection();
  if (modeChanged) {
    setupPayPalButtons();
  }
  const box = $("checkout-panel-box");
  if (box) {
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function renderSubscriptionCatalogTable() {
  const tbody = $("subscription-plans-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const c = portalState.campaign;
  if (!c) return;

  const allItems = [
    ...(c.deposit_products || []).map((d) => ({
      kind: "deposit",
      sku: d.sku,
      planName: d.plan_name || `デポジット ${d.gross_yen.toLocaleString()}円 月額定期チャージ購読プラン`,
      planId: d.plan_id || "-",
      cycleLabel: d.cycle_label || `月額 ${fmtYen(d.gross_yen)}`,
      detail: `実効残高 ${fmtYen(d.net_yen)} / サイクル`,
      subscribeUrl: d.subscribe_url || (d.plan_id ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${d.plan_id}` : "#"),
    })),
    ...(c.voice_products || []).map((v) => {
      const { net } = calcFeeAndNet(v.price_yen, c.paypal);
      return {
        kind: "voice_direct",
        sku: v.sku,
        planName: v.plan_name || `${v.name} 購読プラン`,
        planId: v.plan_id || "-",
        cycleLabel: v.cycle_label || fmtYen(v.price_yen),
        detail: v.days >= 365 ? "365日フルボイス無制限" : (v.days > 0 ? "1ヶ月フルボイス無制限" : `ボイス${v.credits}セリフ枠補充（実効${fmtYen(net)}）`),
        subscribeUrl: v.subscribe_url || (v.plan_id ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${v.plan_id}` : "#"),
      };
    }),
  ];

  allItems.forEach((it) => {
    const tr = document.createElement("tr");

    const tdSku = document.createElement("td");
    tdSku.innerHTML = `<span class="sku-code">${it.sku}</span>`;

    const tdName = document.createElement("td");
    tdName.style.fontWeight = "700";
    tdName.textContent = it.planName;

    const tdPid = document.createElement("td");
    tdPid.innerHTML = `<code class="sku-code">${it.planId}</code>`;

    const tdCycle = document.createElement("td");
    tdCycle.style.color = "var(--gold)";
    tdCycle.style.fontWeight = "700";
    tdCycle.textContent = it.cycleLabel;

    const tdDet = document.createElement("td");
    tdDet.className = "num";
    tdDet.textContent = it.detail;

    const tdAct = document.createElement("td");
    const actWrap = document.createElement("div");
    actWrap.style.display = "flex";
    actWrap.style.gap = "6px";
    actWrap.style.flexWrap = "wrap";

    const btnSel = document.createElement("button");
    btnSel.type = "button";
    btnSel.className = "card-sub-btn";
    btnSel.textContent = "🔄 購読選択";
    btnSel.onclick = () => selectPlanAndFocusCheckout(it.kind, it.sku, "subscription");

    const aDirect = document.createElement("a");
    aDirect.href = it.subscribeUrl;
    aDirect.target = "_blank";
    aDirect.rel = "noopener";
    aDirect.className = "card-sub-link";
    aDirect.textContent = "PayPal購読 ↗";
    aDirect.onclick = () => savePendingCheckoutToLocal(it.kind, it.sku);

    actWrap.append(btnSel, aDirect);
    tdAct.appendChild(actWrap);

    tr.append(tdSku, tdName, tdPid, tdCycle, tdDet, tdAct);
    tbody.appendChild(tr);
  });
}

function renderPromptReferenceTable() {
  const tbody = $("prompt-plans-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  (portalState.campaign?.prompt_plans || []).forEach((p) => {
    const tr = document.createElement("tr");
    const tdId = document.createElement("td");
    tdId.innerHTML = `<span class="sku-code">${p.id}</span>`;
    const tdPrm = document.createElement("td");
    tdPrm.className = "num";
    tdPrm.textContent = `${Number(p.prompts).toLocaleString()} prompt`;
    const tdPrice = document.createElement("td");
    tdPrice.className = "num";
    tdPrice.style.fontWeight = "700";
    tdPrice.textContent = fmtYen(p.price_yen);
    const tdUnit = document.createElement("td");
    tdUnit.className = "num";
    tdUnit.textContent = `¥${Number(p.unit_yen).toFixed(1)} / 回`;
    const tdLimit = document.createElement("td");
    tdLimit.textContent = p.monthly_limit ? `月 ${p.monthly_limit} 回まで` : "制限なし";
    const tdTag = document.createElement("td");
    tdTag.textContent = p.tagline || "";
    tr.append(tdId, tdPrm, tdPrice, tdUnit, tdLimit, tdTag);
    tbody.appendChild(tr);
  });
}

function applyRecommendedComboForDeposit(depSpec) {
  if (!depSpec?.recommended_combo) return;
  const vpPool = portalState.campaign?.voice_pool;
  portalState.comboVoiceId = vpPool?.is_goal_reached ? "" : (depSpec.recommended_combo.voice_plan_id || "");
  portalState.comboPromptId = depSpec.recommended_combo.prompt_plan_id || "";
}

function savePendingCheckoutToLocal(kind, sku) {
  try {
    localStorage.setItem("threnai_pending_sub", JSON.stringify({
      orderKind: kind,
      sku,
      voicePlanId: kind === "deposit" ? portalState.comboVoiceId : "",
      promptPlanId: kind === "deposit" ? portalState.comboPromptId : "",
      supporterName: $("inp-supporter-name")?.value.trim() || "",
      supporterMsg: $("inp-supporter-msg")?.value.trim() || "",
      isPublic: $("chk-supporter-public") ? $("chk-supporter-public").checked : true,
      ts: Date.now(),
    }));
  } catch (_) {}
}

function buildCardActionRow(kind, sku, planId, subUrl) {
  const row = document.createElement("div");
  row.className = "tier-actions-row";

  const metaSpan = document.createElement("span");
  metaSpan.className = "sku-code";
  metaSpan.textContent = planId ? `購読Plan: ${planId}` : `SKU: ${sku}`;

  const btns = document.createElement("div");
  btns.className = "tier-action-btns";

  const btnSub = document.createElement("button");
  btnSub.type = "button";
  btnSub.className = "card-sub-btn";
  btnSub.textContent = "🔄 このプランを購読登録";
  btnSub.onclick = (e) => {
    e.stopPropagation();
    selectPlanAndFocusCheckout(kind, sku, "subscription");
  };

  btns.appendChild(btnSub);

  if (planId && subUrl) {
    const aDirect = document.createElement("a");
    aDirect.href = subUrl;
    aDirect.target = "_blank";
    aDirect.rel = "noopener";
    aDirect.className = "card-sub-link";
    aDirect.textContent = "PayPal購読画面 ↗";
    aDirect.onclick = (e) => {
      e.stopPropagation();
      savePendingCheckoutToLocal(kind, sku);
    };
    btns.appendChild(aDirect);
  }

  row.append(metaSpan, btns);
  return row;
}

function renderProductsSection() {
  const c = portalState.campaign;
  if (!c) return;

  $("tab-deposit").classList.toggle("active", portalState.orderKind === "deposit");
  $("tab-deposit").setAttribute("aria-selected", portalState.orderKind === "deposit" ? "true" : "false");
  $("tab-voice").classList.toggle("active", portalState.orderKind === "voice_direct");
  $("tab-voice").setAttribute("aria-selected", portalState.orderKind === "voice_direct" ? "true" : "false");
  $("deposit-combo-panel").classList.toggle("hidden", portalState.orderKind !== "deposit");

  $("btn-paymode-sub").classList.toggle("active", portalState.paymentMode === "subscription");
  $("btn-paymode-sub").setAttribute("aria-selected", portalState.paymentMode === "subscription" ? "true" : "false");
  $("btn-paymode-once").classList.toggle("active", portalState.paymentMode === "one_time");
  $("btn-paymode-once").setAttribute("aria-selected", portalState.paymentMode === "one_time" ? "true" : "false");

  const wrap = $("products-container");
  wrap.innerHTML = "";

  const isSub = portalState.paymentMode === "subscription";

  if (portalState.orderKind === "deposit") {
    const deps = c.deposit_products || [];
    if (!deps.some((d) => d.sku === portalState.selectedSku)) {
      const defDep = deps.find((d) => d.recommended) || deps[0];
      if (defDep) {
        portalState.selectedSku = defDep.sku;
        applyRecommendedComboForDeposit(defDep);
      }
    }

    deps.forEach((dep) => {
      const isSel = dep.sku === portalState.selectedSku;
      const card = document.createElement("div");
      card.className = `tier-card${isSel ? " selected" : ""}${dep.recommended ? " recommended" : ""}`;
      card.tabIndex = 0;

      const top = document.createElement("div");
      top.className = "tier-top";
      const left = document.createElement("div");
      const nm = document.createElement("span");
      nm.className = "tier-name";
      nm.textContent = isSub
        ? (dep.plan_name || `デポジット ${dep.gross_yen.toLocaleString()}円 月額定期チャージ購読`)
        : `デポジット ${dep.gross_yen.toLocaleString()}円 単発チャージ`;
      left.appendChild(nm);
      if (dep.badge) {
        const b = document.createElement("span");
        b.className = "tier-badge";
        b.textContent = dep.badge;
        left.appendChild(b);
      }
      const pr = document.createElement("div");
      pr.className = "tier-price";
      pr.textContent = isSub ? `${fmtYen(dep.gross_yen)} / 月` : fmtYen(dep.gross_yen);
      top.append(left, pr);

      const desc = document.createElement("p");
      desc.className = "tier-desc";
      desc.textContent = `PayPal手数料 ${fmtYen(dep.fee_yen)} 差引 → 1回あたりゲーム内実効チャージ額 ${fmtYen(dep.net_yen)}（製品グループ: ${dep.sku}）`;

      const subUrl = dep.subscribe_url || (dep.plan_id ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${dep.plan_id}` : "");
      const actRow = buildCardActionRow("deposit", dep.sku, dep.plan_id || "", subUrl);

      const selectFn = () => {
        portalState.selectedSku = dep.sku;
        applyRecommendedComboForDeposit(dep);
        renderProductsSection();
      };
      card.onclick = selectFn;
      card.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectFn();
        }
      };

      card.append(top, desc, actRow);
      wrap.appendChild(card);
    });

    populateComboSelectors();
  } else {
    const vprods = c.voice_products || [];
    if (!vprods.some((v) => v.sku === portalState.selectedSku)) {
      const defV = vprods.find((v) => v.recommended) || vprods[0];
      if (defV) portalState.selectedSku = defV.sku;
    }

    vprods.forEach((vp) => {
      const isSel = vp.sku === portalState.selectedSku;
      const card = document.createElement("div");
      card.className = `tier-card${isSel ? " selected" : ""}${vp.recommended ? " recommended" : ""}`;
      card.tabIndex = 0;

      const top = document.createElement("div");
      top.className = "tier-top";
      const left = document.createElement("div");
      const nm = document.createElement("span");
      nm.className = "tier-name";
      nm.textContent = isSub ? (vp.plan_name || vp.name) : vp.name;
      left.appendChild(nm);
      if (vp.recommended) {
        const b = document.createElement("span");
        b.className = "tier-badge";
        b.textContent = "定番おすすめ";
        left.appendChild(b);
      }
      const suffix = vp.interval_unit === "YEAR" ? " / 年" : " / 月";
      const pr = document.createElement("div");
      pr.className = "tier-price";
      pr.textContent = isSub ? `${fmtYen(vp.price_yen)}${suffix}` : fmtYen(vp.price_yen);
      top.append(left, pr);

      const desc = document.createElement("p");
      desc.className = "tier-desc";
      desc.textContent = `${vp.desc}（製品グループ: ${vp.sku}）`;

      const subUrl = vp.subscribe_url || (vp.plan_id ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${vp.plan_id}` : "");
      const actRow = buildCardActionRow("voice_direct", vp.sku, vp.plan_id || "", subUrl);

      const selectFn = () => {
        portalState.selectedSku = vp.sku;
        renderProductsSection();
      };
      card.onclick = selectFn;
      card.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectFn();
        }
      };

      card.append(top, desc, actRow);
      wrap.appendChild(card);
    });
  }

  updateCheckoutSummary();
}

function populateComboSelectors() {
  const c = portalState.campaign;
  const dep = (c.deposit_products || []).find((d) => d.sku === portalState.selectedSku);
  const netYen = dep ? dep.net_yen : 0;
  const vRem = Number(c.voice_pool?.remaining_yen ?? 157300);

  const selV = $("sel-combo-voice");
  const selP = $("sel-combo-prompt");
  selV.innerHTML = "";
  selP.innerHTML = "";

  const optVNone = document.createElement("option");
  optVNone.value = "";
  optVNone.textContent = vRem <= 0 ? "選択不要（今年度100%達成・全員無料開放中！）" : "同時適用しない（¥0）";
  selV.appendChild(optVNone);

  if (vRem > 0) {
    (c.voice_products || []).forEach((vp) => {
      const effCost = Math.min(vp.price_yen, vRem);
      const opt = document.createElement("option");
      opt.value = vp.voice_plan_id;
      opt.disabled = effCost > netYen;
      opt.textContent = `${vp.name} (${fmtYen(effCost)})${effCost > netYen ? " [残高不足]" : ""}`;
      selV.appendChild(opt);
    });
  }
  if ([...selV.options].some((o) => o.value === portalState.comboVoiceId && !o.disabled)) {
    selV.value = portalState.comboVoiceId;
  } else {
    portalState.comboVoiceId = "";
    selV.value = "";
  }

  const chosenVoiceObj = (c.voice_products || []).find((v) => v.voice_plan_id === portalState.comboVoiceId);
  const voiceCost = chosenVoiceObj && vRem > 0 ? Math.min(chosenVoiceObj.price_yen, vRem) : 0;
  const maxForPrompt = Math.max(0, netYen - voiceCost);

  const optPNone = document.createElement("option");
  optPNone.value = "";
  optPNone.textContent = "同時購入しない（すべてデポジット残高として保持）";
  selP.appendChild(optPNone);

  (c.prompt_plans || []).forEach((pp) => {
    const opt = document.createElement("option");
    opt.value = pp.id;
    opt.disabled = pp.price_yen > maxForPrompt;
    opt.textContent = `${Number(pp.prompts).toLocaleString()}prompt : ${fmtYen(pp.price_yen)}${pp.price_yen > maxForPrompt ? " [残高不足]" : ""}`;
    selP.appendChild(opt);
  });

  if ([...selP.options].some((o) => o.value === portalState.comboPromptId && !o.disabled)) {
    selP.value = portalState.comboPromptId;
  } else {
    portalState.comboPromptId = "";
    selP.value = "";
  }
}

function computeCurrentCheckoutSpec() {
  const c = portalState.campaign;
  if (!c) return null;
  const vRem = Number(c.voice_pool?.remaining_yen ?? 157300);
  const isSub = portalState.paymentMode === "subscription";

  if (portalState.orderKind === "voice_direct") {
    const vp = (c.voice_products || []).find((v) => v.sku === portalState.selectedSku);
    if (!vp) return null;
    const gross = isSub ? vp.price_yen : (vRem > 0 ? Math.min(vp.price_yen, vRem) : 0);
    const { fee, net } = gross > 0 ? calcFeeAndNet(gross, c.paypal) : { fee: 0, net: 0 };
    const planId = vp.plan_id || "";
    const subUrl = vp.subscribe_url || (planId ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${planId}` : "");
    return {
      paymentMode: portalState.paymentMode,
      orderKind: "voice_direct",
      sku: vp.sku,
      planId,
      subscribeUrl: subUrl,
      cycleLabel: isSub ? (vp.cycle_label || "定期購読") : "1回のみ単発決済",
      title: isSub ? (vp.plan_name || vp.name) : vp.name,
      grossYen: gross,
      feeYen: fee,
      netYen: net,
      voicePlanId: vp.voice_plan_id,
      promptPlanId: "",
      voicePoolAdd: Math.min(gross, vRem),
      grants: {
        deposit_yen: 0,
        prompts: 0,
        voice_credits: vp.credits || 0,
        voice_pass_days: vp.days === 30 ? 31 : (vp.days || 0),
      },
      blockedReason: vRem <= 0 ? "今年度のAquesTalk1ライセンス実費は100%達成済みのため無料開放中です！" : "",
    };
  }

  const dep = (c.deposit_products || []).find((d) => d.sku === portalState.selectedSku);
  if (!dep) return null;
  const { fee, net } = calcFeeAndNet(dep.gross_yen, c.paypal);
  const vp = (c.voice_products || []).find((v) => v.voice_plan_id === portalState.comboVoiceId);
  const pp = (c.prompt_plans || []).find((p) => p.id === portalState.comboPromptId);

  const voiceCharge = vp && vRem > 0 ? Math.min(vp.price_yen, vRem) : 0;
  const promptCharge = pp ? pp.price_yen : 0;
  const leftover = Math.max(0, net - voiceCharge - promptCharge);
  const planId = dep.plan_id || "";
  const subUrl = dep.subscribe_url || (planId ? `https://www.paypal.com/webapps/billing/plans/subscribe?plan_id=${planId}` : "");

  return {
    paymentMode: portalState.paymentMode,
    orderKind: "deposit",
    sku: dep.sku,
    planId,
    subscribeUrl: subUrl,
    cycleLabel: isSub ? (dep.cycle_label || `月額 ${fmtYen(dep.gross_yen)}`) : "1回のみ単発決済",
    title: isSub ? (dep.plan_name || `デポジット ${dep.gross_yen.toLocaleString()}円 月額購読`) : `デポジット ${dep.gross_yen.toLocaleString()}円`,
    grossYen: dep.gross_yen,
    feeYen: fee,
    netYen: net,
    voicePlanId: vp ? vp.voice_plan_id : "",
    promptPlanId: pp ? pp.id : "",
    voicePoolAdd: voiceCharge,
    grants: {
      deposit_yen: leftover,
      prompts: pp ? pp.prompts : 0,
      voice_credits: vp && vRem > 0 ? (vp.credits || 0) : 0,
      voice_pass_days: vp && vRem > 0 ? (vp.days === 30 ? 31 : (vp.days || 0)) : 0,
    },
    blockedReason: "",
  };
}

function updateCheckoutSummary() {
  const spec = computeCurrentCheckoutSpec();
  if (!spec) return;

  const isSub = spec.paymentMode === "subscription";
  $("sum-paymode-label").textContent = isSub ? "🔄 PayPal定期購読（いつでも解約可）" : "⚡ 1回のみ単発決済";
  $("sum-paymode-label").style.color = isSub ? "var(--sky)" : "var(--gold)";
  $("sum-sku-label").textContent = spec.sku;
  $("sum-plan-row").classList.toggle("hidden", !isSub);
  $("sum-plan-id").textContent = spec.planId || "-";
  $("sum-cycle-label").textContent = spec.cycleLabel;
  $("sum-fee-yen").textContent = `-${fmtYen(spec.feeYen)}`;
  $("sum-net-yen").textContent = fmtYen(spec.netYen);
  $("sum-voice-pool-add").textContent = fmtYen(spec.voicePoolAdd);
  $("sum-grants-text").textContent = formatGrantsShort(spec.grants);
  $("sum-total-caption").textContent = isSub ? "初回・更新お支払い額（税込）" : "お支払い総額（税込）";
  $("sum-gross-yen").textContent = fmtYen(spec.grossYen);

  const directWrap = $("direct-subscribe-wrap");
  const directBtn = $("btn-direct-paypal-subscribe");
  if (directWrap && directBtn) {
    if (isSub && spec.planId && spec.subscribeUrl && !spec.blockedReason) {
      directWrap.classList.remove("hidden");
      directBtn.href = spec.subscribeUrl;
      directBtn.textContent = `🔗 PayPal公式画面で「${spec.title}」を購読登録 ↗`;
      directBtn.onclick = () => savePendingCheckoutToLocal(spec.orderKind, spec.sku);
    } else {
      directWrap.classList.add("hidden");
    }
  }

  if ($("combo-hint-msg") && spec.orderKind === "deposit") {
    $("combo-hint-msg").textContent =
      `内訳: 実効チャージ ${fmtYen(spec.netYen)} ＝ ボイス充当 ${fmtYen(spec.voicePoolAdd)} ＋ プロンプト充当 ${fmtYen(spec.netYen - spec.voicePoolAdd - spec.grants.deposit_yen)} ＋ 残りデポジット残高 ${fmtYen(spec.grants.deposit_yen)}`;
  }
}

function renderSupportersWall() {
  const wall = $("supporters-wall");
  wall.innerHTML = "";
  const list = portalState.campaign?.recent_supporters || [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "supporter-item";
    empty.style.gridColumn = "1 / -1";
    empty.style.textAlign = "center";
    empty.style.color = "var(--text-muted)";
    empty.textContent = "最初の実費分担サポーターとして、ぜひ幻想郷のフルボイス本格稼働にご参加ください！";
    wall.appendChild(empty);
    return;
  }

  list.forEach((s) => {
    const item = document.createElement("div");
    item.className = "supporter-item";
    const head = document.createElement("div");
    head.className = "supporter-head";
    const nm = document.createElement("span");
    nm.textContent = `🌸 ${s.name}`;
    const amt = document.createElement("span");
    amt.style.color = "var(--gold)";
    amt.textContent = fmtYen(s.gross_yen);
    head.append(nm, amt);

    const tr = document.createElement("div");
    tr.className = "supporter-tier";
    tr.textContent = s.summary_label || "";
    item.append(head, tr);

    if (s.message) {
      const msg = document.createElement("p");
      msg.className = "supporter-msg";
      msg.textContent = s.message;
      item.appendChild(msg);
    }
    wall.appendChild(item);
  });
}

function loadPayPalSdk(clientId, currency = "JPY", mode = "subscription") {
  const sdkKey = `${clientId}|${currency}|${mode}`;
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("PayPal Client ID が未設定です。"));
      return;
    }
    if (window.paypal && portalState.paypalSdkLoadedKey === sdkKey) {
      resolve(window.paypal);
      return;
    }
    const existing = document.getElementById("paypal-js-sdk");
    if (existing) existing.remove();
    try {
      delete window.paypal;
    } catch (_) {
      window.paypal = undefined;
    }

    const script = document.createElement("script");
    script.id = "paypal-js-sdk";
    const params = new URLSearchParams({
      "client-id": clientId,
      currency,
      locale: "ja_JP",
    });
    if (mode === "subscription") {
      params.set("vault", "true");
      params.set("intent", "subscription");
    } else {
      params.set("intent", "capture");
    }
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;
    script.onload = () => {
      portalState.paypalSdkLoadedKey = sdkKey;
      resolve(window.paypal);
    };
    script.onerror = () => reject(new Error("PayPal JavaScript SDK の読み込みに失敗しました。"));
    document.head.appendChild(script);
  });
}

function encodeThpp1Voucher(payloadObj) {
  const bytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `THPP1-${b64url}`;
}

function showVoucherSuccess(receipt) {
  portalState.lastReceipt = receipt;
  $("voucher-result-box").classList.remove("hidden");
  $("voucher-result-heading").textContent = receipt.payment_mode === "subscription"
    ? "🎉 PayPal購読登録完了・サポーター引換コード発行"
    : "🎉 お支払い完了・サポーター引換コード発行";
  $("issued-voucher-code").textContent = receipt.voucher_code || receipt.paypal_subscription_id || `PPORDER-${receipt.paypal_order_id}`;

  const subLine = $("issued-sub-id-line");
  if (subLine) {
    if (receipt.paypal_subscription_id) {
      subLine.classList.remove("hidden");
      subLine.textContent = `PayPal 購読ID: ${receipt.paypal_subscription_id}（プランID: ${receipt.plan_id || "-"}）`;
    } else {
      subLine.classList.add("hidden");
      subLine.textContent = "";
    }
  }

  const statusEl = $("checkout-status");
  statusEl.className = "checkout-msg";
  statusEl.textContent = receipt.payment_mode === "subscription"
    ? "PayPal購読登録が完了し、サポーター引換コードが発行されました！下のボタンから控えを保存してください。"
    : "決済が完了し、サポーター引換コードが発行されました！下のボタンから控えを保存してください。";
}

async function finalizeSubscriptionApproval({ subscriptionId, supporterOrderId = "", spec = null }) {
  const activeSpec = spec || computeCurrentCheckoutSpec();
  const supporterName = $("inp-supporter-name")?.value.trim() || "";
  const supporterMsg = $("inp-supporter-msg")?.value.trim() || "";
  const isPublic = $("chk-supporter-public") ? $("chk-supporter-public").checked : true;
  const statusEl = $("checkout-status");

  statusEl.className = "checkout-msg";
  statusEl.textContent = `PayPal購読 (${subscriptionId}) を確認し、引換コードを発行しています…`;

  if (portalState.serverOnline && portalState.apiBase) {
    try {
      const resp = await fetch(`${portalState.apiBase}/api/public/paypal/activate_subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supporter_order_id: supporterOrderId,
          paypal_subscription_id: subscriptionId,
          plan_id: activeSpec ? activeSpec.planId : "",
          order_kind: activeSpec ? activeSpec.orderKind : "deposit",
          sku: activeSpec ? activeSpec.sku : "",
          voice_plan_id: activeSpec ? activeSpec.voicePlanId : "",
          prompt_plan_id: activeSpec ? activeSpec.promptPlanId : "",
          supporter_name: supporterName,
          supporter_message: supporterMsg,
          is_public: isPublic,
        }),
      });
      if (resp.ok) {
        const d = await resp.json();
        if (d.campaign) {
          portalState.campaign = d.campaign;
          renderCampaignUI();
        }
        showVoucherSuccess({
          payment_mode: "subscription",
          voucher_code: d.voucher_code || subscriptionId,
          paypal_subscription_id: subscriptionId,
          paypal_order_id: subscriptionId,
          plan_id: d.plan_id || (activeSpec ? activeSpec.planId : ""),
          sku: activeSpec ? activeSpec.sku : "",
          title: activeSpec ? activeSpec.title : "PayPal定期購読プラン",
          price_yen: activeSpec ? activeSpec.grossYen : 0,
          grants: d.grants || (activeSpec ? activeSpec.grants : {}),
          completed_at: new Date().toISOString(),
        });
        return;
      }
    } catch (_) {}
  }

  const thpp1Code = encodeThpp1Voucher({
    t: "subscription",
    o: subscriptionId,
    c: subscriptionId,
    pl: activeSpec ? activeSpec.planId : "",
    k: activeSpec ? activeSpec.orderKind : "deposit",
    s: activeSpec ? activeSpec.sku : "",
    v: activeSpec ? activeSpec.voicePlanId : "",
    p: activeSpec ? activeSpec.promptPlanId : "",
    a: activeSpec ? activeSpec.grossYen : 0,
    n: supporterName.slice(0, 16),
    m: supporterMsg.slice(0, 80),
    u: isPublic ? 1 : 0,
  });

  showVoucherSuccess({
    payment_mode: "subscription",
    voucher_code: thpp1Code,
    paypal_subscription_id: subscriptionId,
    paypal_order_id: subscriptionId,
    plan_id: activeSpec ? activeSpec.planId : "",
    sku: activeSpec ? activeSpec.sku : "",
    title: activeSpec ? activeSpec.title : "PayPal定期購読プラン",
    price_yen: activeSpec ? activeSpec.grossYen : 0,
    grants: activeSpec ? activeSpec.grants : {},
    completed_at: new Date().toISOString(),
  });
}

async function setupPayPalButtons() {
  const ppCfg = portalState.campaign?.paypal || {};
  const clientId = (ppCfg.js_client_id || "").trim();
  const statusEl = $("checkout-status");
  const container = $("paypal-button-container");
  container.innerHTML = "";

  if (!clientId) {
    statusEl.className = "checkout-msg error";
    statusEl.textContent = "PayPal Client ID が未設定です。";
    return;
  }

  const mode = portalState.paymentMode;

  try {
    const paypal = await loadPayPalSdk(clientId, ppCfg.currency || "JPY", mode);

    if (mode === "subscription") {
      statusEl.className = "checkout-msg";
      statusEl.textContent = "下のPayPal「購読」ボタンから定期購読登録へお進みいただけます（いつでも解約可能）。";

      let activeSupporterOrderId = "";

      paypal.Buttons({
        style: {
          layout: "vertical",
          color: "gold",
          shape: "rect",
          label: "subscribe",
        },
        createSubscription: async (_data, actions) => {
          const spec = computeCurrentCheckoutSpec();
          if (!spec) throw new Error("購読プランを選択してください。");
          if (spec.blockedReason) throw new Error(spec.blockedReason);
          if (!spec.planId || !spec.planId.startsWith("P-")) {
            throw new Error("選択商品のPayPal購読プランID (P-...) が見つかりません。");
          }

          activeSupporterOrderId = "";
          statusEl.className = "checkout-msg";
          statusEl.textContent = `PayPal購読プラン (${spec.planId}) を開始しています…`;

          const supporterName = $("inp-supporter-name").value.trim();
          const supporterMsg = $("inp-supporter-msg").value.trim();
          const isPublic = $("chk-supporter-public").checked;

          if (portalState.serverOnline && portalState.apiBase && ppCfg.rest_ready) {
            try {
              const resp = await fetch(`${portalState.apiBase}/api/public/paypal/create_subscription`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  order_kind: spec.orderKind,
                  sku: spec.sku,
                  plan_id: spec.planId,
                  voice_plan_id: spec.voicePlanId,
                  prompt_plan_id: spec.promptPlanId,
                  supporter_name: supporterName,
                  supporter_message: supporterMsg,
                  is_public: isPublic,
                  return_url: window.location.href.split("?")[0],
                  cancel_url: window.location.href.split("?")[0],
                }),
              });
              if (resp.ok) {
                const d = await resp.json();
                if (d.paypal_subscription_id && !d.paypal_subscription_id.startsWith("I-SIM")) {
                  activeSupporterOrderId = d.supporter_order_id || "";
                  return d.paypal_subscription_id;
                }
              }
            } catch (_) {}
          }

          return actions.subscription.create({
            plan_id: spec.planId,
            custom_id: `${spec.sku}|${spec.voicePlanId || "-"}|${spec.promptPlanId || "-"}`.slice(0, 127),
            application_context: {
              brand_name: "東方Project恋愛シミュレーター",
              locale: "ja-JP",
              shipping_preference: "NO_SHIPPING",
              user_action: "SUBSCRIBE_NOW",
            },
          });
        },
        onApprove: async (data) => {
          const subId = data.subscriptionID || data.orderID;
          await finalizeSubscriptionApproval({
            subscriptionId: subId,
            supporterOrderId: activeSupporterOrderId,
            spec: computeCurrentCheckoutSpec(),
          });
        },
        onCancel: () => {
          statusEl.className = "checkout-msg";
          statusEl.textContent = "PayPal購読登録手続きをキャンセルしました。";
        },
        onError: (err) => {
          statusEl.className = "checkout-msg error";
          statusEl.textContent = `PayPal購読エラー: ${err?.message || err}`;
        },
      }).render("#paypal-button-container");
      return;
    }

    // 1回のみ購入 (intent=capture) モード
    statusEl.className = "checkout-msg";
    statusEl.textContent = "1回のみの都度決済（自動継続なし）としてお支払いいただけます。";

    let activeSupporterOrderId = "";

    paypal.Buttons({
      style: {
        layout: "vertical",
        color: "gold",
        shape: "rect",
        label: "paypal",
      },
      createOrder: async (_data, actions) => {
        const spec = computeCurrentCheckoutSpec();
        if (!spec) throw new Error("商品を選択してください。");
        if (spec.blockedReason) throw new Error(spec.blockedReason);

        activeSupporterOrderId = "";
        statusEl.className = "checkout-msg";
        statusEl.textContent = "PayPal注文を作成しています…";

        const supporterName = $("inp-supporter-name").value.trim();
        const supporterMsg = $("inp-supporter-msg").value.trim();
        const isPublic = $("chk-supporter-public").checked;

        if (portalState.serverOnline && portalState.apiBase && ppCfg.rest_ready) {
          try {
            const resp = await fetch(`${portalState.apiBase}/api/public/paypal/create_order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                order_kind: spec.orderKind,
                sku: spec.sku,
                voice_plan_id: spec.voicePlanId,
                prompt_plan_id: spec.promptPlanId,
                supporter_name: supporterName,
                supporter_message: supporterMsg,
                is_public: isPublic,
                return_url: window.location.href.split("?")[0],
                cancel_url: window.location.href.split("?")[0],
              }),
            });
            if (resp.ok) {
              const d = await resp.json();
              if (d.paypal_order_id && !d.paypal_order_id.startsWith("SIM_")) {
                activeSupporterOrderId = d.supporter_order_id || "";
                return d.paypal_order_id;
              }
            }
          } catch (_) {}
        }

        return actions.order.create({
          intent: "CAPTURE",
          purchase_units: [
            {
              custom_id: spec.sku,
              description: `東方Project恋愛シミュレーター: ${spec.title}`.slice(0, 120),
              amount: {
                currency_code: "JPY",
                value: String(spec.grossYen),
              },
            },
          ],
        });
      },
      onApprove: async (data, actions) => {
        const spec = computeCurrentCheckoutSpec();
        const supporterName = $("inp-supporter-name").value.trim();
        const supporterMsg = $("inp-supporter-msg").value.trim();
        const isPublic = $("chk-supporter-public").checked;

        statusEl.className = "checkout-msg";
        statusEl.textContent = "お支払いを確定し、サポーター引換コードを発行しています…";

        let jsDetails = null;
        let captureId = "";
        let capturedJpy = spec ? spec.grossYen : 0;

        if (!ppCfg.rest_ready || !activeSupporterOrderId) {
          jsDetails = await actions.order.capture();
          const pu = (jsDetails.purchase_units || [{}])[0];
          const caps = (pu.payments || {}).captures || [];
          if (caps.length) {
            captureId = caps[0].id || "";
            if (caps[0].amount?.value) capturedJpy = Math.round(Number(caps[0].amount.value));
          } else if (pu.amount?.value) {
            capturedJpy = Math.round(Number(pu.amount.value));
          }
        }

        if (portalState.serverOnline && portalState.apiBase) {
          try {
            const capResp = await fetch(`${portalState.apiBase}/api/public/paypal/capture_order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                supporter_order_id: activeSupporterOrderId,
                paypal_order_id: jsDetails?.id || data.orderID,
                paypal_capture_id: captureId,
                js_captured_status: jsDetails?.status || "",
                captured_jpy: capturedJpy,
                order_kind: spec ? spec.orderKind : "deposit",
                sku: spec ? spec.sku : "",
                voice_plan_id: spec ? spec.voicePlanId : "",
                prompt_plan_id: spec ? spec.promptPlanId : "",
                supporter_name: supporterName,
                supporter_message: supporterMsg,
                is_public: isPublic,
              }),
            });
            if (capResp.ok) {
              const capData = await capResp.json();
              if (capData.campaign) {
                portalState.campaign = capData.campaign;
                renderCampaignUI();
              }
              showVoucherSuccess({
                payment_mode: "one_time",
                voucher_code: capData.voucher_code,
                paypal_order_id: jsDetails?.id || data.orderID,
                sku: spec ? spec.sku : "",
                title: spec ? spec.title : "",
                price_yen: capturedJpy,
                grants: capData.grants || (spec ? spec.grants : {}),
                completed_at: new Date().toISOString(),
              });
              return;
            }
          } catch (_) {}
        }

        const finalOrderId = jsDetails?.id || data.orderID;
        const thpp1Code = encodeThpp1Voucher({
          t: "one_time",
          o: finalOrderId,
          c: captureId || finalOrderId,
          k: spec ? spec.orderKind : "deposit",
          s: spec ? spec.sku : "",
          v: spec ? spec.voicePlanId : "",
          p: spec ? spec.promptPlanId : "",
          a: capturedJpy,
          n: supporterName.slice(0, 16),
          m: supporterMsg.slice(0, 80),
          u: isPublic ? 1 : 0,
        });
        showVoucherSuccess({
          payment_mode: "one_time",
          voucher_code: thpp1Code,
          paypal_order_id: finalOrderId,
          sku: spec ? spec.sku : "",
          title: spec ? spec.title : "",
          price_yen: capturedJpy,
          grants: spec ? spec.grants : {},
          completed_at: new Date().toISOString(),
        });
      },
      onCancel: () => {
        statusEl.className = "checkout-msg";
        statusEl.textContent = "お支払い手続きをキャンセルしました。";
      },
      onError: (err) => {
        statusEl.className = "checkout-msg error";
        statusEl.textContent = `PayPal決済エラー: ${err?.message || err}`;
      },
    }).render("#paypal-button-container");
  } catch (err) {
    statusEl.className = "checkout-msg error";
    statusEl.textContent = err.message || "PayPalボタンの初期化に失敗しました。";
  }
}

async function checkSubscriptionReturnRedirect() {
  const params = new URLSearchParams(window.location.search);
  const subId = (params.get("subscription_id") || "").trim();
  const supOid = (params.get("supporter_order_id") || "").trim();
  if (!subId || !subId.startsWith("I-")) return;

  try {
    const savedRaw = localStorage.getItem("threnai_pending_sub");
    if (savedRaw) {
      const saved = JSON.parse(savedRaw);
      if (saved.orderKind && saved.sku) {
        portalState.orderKind = saved.orderKind;
        portalState.selectedSku = saved.sku;
        portalState.comboVoiceId = saved.voicePlanId || "";
        portalState.comboPromptId = saved.promptPlanId || "";
        if ($("inp-supporter-name") && saved.supporterName) $("inp-supporter-name").value = saved.supporterName;
        if ($("inp-supporter-msg") && saved.supporterMsg) $("inp-supporter-msg").value = saved.supporterMsg;
        if ($("chk-supporter-public") && typeof saved.isPublic === "boolean") $("chk-supporter-public").checked = saved.isPublic;
        renderProductsSection();
      }
    }
  } catch (_) {}

  await finalizeSubscriptionApproval({
    subscriptionId: subId,
    supporterOrderId: supOid,
    spec: computeCurrentCheckoutSpec(),
  });

  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, document.title, cleanUrl);
}

$("tab-deposit").onclick = () => {
  portalState.orderKind = "deposit";
  portalState.selectedSku = "";
  renderProductsSection();
};

$("tab-voice").onclick = () => {
  portalState.orderKind = "voice_direct";
  portalState.selectedSku = "";
  renderProductsSection();
};

$("btn-paymode-sub").onclick = async () => {
  if (portalState.paymentMode === "subscription") return;
  portalState.paymentMode = "subscription";
  renderProductsSection();
  await setupPayPalButtons();
};

$("btn-paymode-once").onclick = async () => {
  if (portalState.paymentMode === "one_time") return;
  portalState.paymentMode = "one_time";
  renderProductsSection();
  await setupPayPalButtons();
};

$("sel-combo-voice").onchange = (e) => {
  portalState.comboVoiceId = e.target.value;
  populateComboSelectors();
  updateCheckoutSummary();
};

$("sel-combo-prompt").onchange = (e) => {
  portalState.comboPromptId = e.target.value;
  updateCheckoutSummary();
};

$("btn-apply-api-base").onclick = async () => {
  const val = $("inp-api-base").value.trim().replace(/\/$/, "");
  portalState.apiBase = val;
  if (val) localStorage.setItem("threnai_api_base", val);
  else localStorage.removeItem("threnai_api_base");
  await loadCampaignData();
  renderCampaignUI();
  await setupPayPalButtons();
};

$("btn-copy-voucher").onclick = async () => {
  const code = $("issued-voucher-code").textContent.trim();
  if (!code) return;
  await navigator.clipboard.writeText(code);
  $("btn-copy-voucher").textContent = "✓ コピーしました！";
  setTimeout(() => {
    $("btn-copy-voucher").textContent = "📋 コードをコピー";
  }, 2000);
};

$("btn-download-receipt").onclick = () => {
  const r = portalState.lastReceipt;
  if (!r) return;
  const lines = [
    "============================================================",
    " 東方Project恋愛シミュレーター PayPal購読・サポーター引換控え",
    "============================================================",
    `発行日時         : ${r.completed_at}`,
    `お支払い区分     : ${r.payment_mode === "subscription" ? "PayPal定期購読 (サブスクリプション)" : "1回のみ単発決済"}`,
    `購入プラン (SKU) : ${r.title} [${r.sku}] (${fmtYen(r.price_yen)})`,
    ...(r.plan_id ? [`PayPalプランID   : ${r.plan_id}`] : []),
    ...(r.paypal_subscription_id ? [`PayPal購読ID     : ${r.paypal_subscription_id}`] : [`PayPal注文ID     : ${r.paypal_order_id}`]),
    `付与特典         : ${formatGrantsShort(r.grants)}`,
    `引換コード       : ${r.voucher_code}`,
    "------------------------------------------------------------",
    "【使い方】",
    "1. ゲームクライアントを起動し「認証開始（サーバー連携）」を実行します。",
    "2. 「AIの導入方法とボイス設定」画面の「🎁 先行サポーター引換コード」欄に",
    "   上記の引換コードを入力して「コードを反映」を押すと即時反映されます。",
    ...(r.paypal_subscription_id ? [
      "3. 次回以降の月次・年次自動更新時は、上記の PayPal購読ID (" + r.paypal_subscription_id + ")",
      "   を同じ欄に入力するだけで更新サイクル分が自動加算されます。",
    ] : []),
    "============================================================",
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `TouhouRenai_Sub_${r.paypal_subscription_id || r.paypal_order_id || "receipt"}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
};

(async function initPortal() {
  portalState.apiBase = resolveInitialApiBase();
  if ($("inp-api-base") && portalState.apiBase) {
    $("inp-api-base").value = portalState.apiBase;
  }
  await loadCampaignData();
  renderCampaignUI();
  await setupPayPalButtons();
  await checkSubscriptionReturnRedirect();
})();
