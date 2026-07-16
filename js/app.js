/**
 * app.js — CxF Color Converter メインアプリ (Claude Design 版)
 * 依存: colorlib.js (CxFColor), cxf-parser.js (CxFParser),
 *       terms.js (CxFTerms), vendor/jsColorEngineWeb.js (jsColorEngine)
 */
(function () {
  'use strict';
  var C = window.CxFColor, P = window.CxFParser, JCE = window.jsColorEngine, T = window.CxFTerms;

  // ===== 状態 =====
  var state = {
    samples: [],          // {file, obj, convD50, convView, cmyk, cmykSource, cmykIsIcc}
    ill: 'D50',
    intent: 'relative',
    bpc: true,
    iccProfile: null,
    iccName: '',
    transform: null
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(v, d) { return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.style.display = 'none'; }, 2400);
  }

  // ===== シグネチャー: 波長帯グラデーション =====
  (function () {
    var stops = [];
    for (var wl = 380; wl <= 730; wl += 10) {
      stops.push(C.wavelengthToCss(wl) + ' ' + (((wl - 380) / 350) * 100).toFixed(1) + '%');
    }
    var g = 'linear-gradient(90deg,' + stops.join(',') + ')';
    var band = $('specBand');
    if (band) band.style.background = g;
    document.documentElement.style.setProperty('--spectrum', g);
  })();

  // ===== ICC変換 =====
  function rebuildTransform() {
    state.transform = null;
    if (!state.iccProfile) return;
    try {
      var t = new JCE.Transform({ bpc: state.bpc });
      t.create('*lab', state.iccProfile, state.intent === 'perceptual' ? JCE.eIntent.perceptual : JCE.eIntent.relative);
      state.transform = t;
    } catch (e) {
      toast('ICC変換の構築に失敗: ' + e.message);
      state.transform = null;
    }
  }

  function computeCmyk(s) {
    if (state.transform && s.convD50 && s.convD50.Lab) {
      try {
        var out = state.transform.transform(JCE.color.Lab(s.convD50.Lab[0], s.convD50.Lab[1], s.convD50.Lab[2]));
        s.cmyk = { c: out.C, m: out.M, y: out.Y, k: out.K };
        s.cmykSource = state.iccName;
        s.cmykIsIcc = true;
        return;
      } catch (e) { /* fall through */ }
    }
    var base = s.convView || s.convD50;
    s.cmyk = base && base.rgb ? C.naiveCmyk(base.rgb) : null;
    s.cmykSource = '簡易';
    s.cmykIsIcc = false;
  }

  function recomputeAll() {
    state.samples.forEach(function (s) {
      s.convD50 = C.convertSample(s.obj, 'D50');
      s.convView = state.ill === 'D50' ? s.convD50 : C.convertSample(s.obj, state.ill);
      computeCmyk(s);
    });
    render();
  }

  // ===== ICCの端末内保存 (IndexedDB) =====
  // Japan Color等のICCプロファイルはライセンス上サイトに同梱・配布できないため、
  // 一度読み込んだプロファイルを利用者自身の端末(ブラウザ)に保存し、
  // 次回アクセス時に自動適用する。データはサーバーに送信されない。
  var IDB_NAME = 'cxf-color-converter', IDB_STORE = 'icc';
  function idbOpen() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(IDB_STORE); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var rq = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  var NAIVE_BADGE = '<span class="badge naive">簡易CMYK<button class="q" type="button" data-term="cmyk" aria-label="CMYKとは" aria-expanded="false" style="margin-left:6px;border-color:currentColor;color:inherit">?</button></span>';

  function renderIccBadge(saved) {
    $('iccStatus').innerHTML = '<span class="badge icc">' + esc(state.iccName) +
      (saved ? '<span class="savemark">この端末に保存済</span>' : '') + '</span>' +
      '<button class="iccx" type="button" title="プロファイルを解除して端末の保存からも削除します">解除</button>';
    $('iccStatus').querySelector('.iccx').addEventListener('click', function (e) {
      e.stopPropagation();
      clearIcc();
    });
  }

  function clearIcc() {
    state.iccProfile = null; state.iccName = ''; state.transform = null;
    idbDel('profile').catch(function () {});
    $('iccStatus').innerHTML = NAIVE_BADGE;
    state.samples.forEach(computeCmyk);
    render();
    toast('ICCプロファイルを解除しました');
  }

  function applyIccBytes(bytes, fallbackName, opts) {
    opts = opts || {};
    var profile = new JCE.Profile();
    return profile.loadPromise(bytes).then(function () {
      if (!profile.loaded) throw new Error((profile.lastError && profile.lastError.text) || '不正なICCファイル');
      if (profile.colorSpace !== 'CMYK') throw new Error('CMYKプロファイルではありません（' + profile.colorSpace + '）');
      state.iccProfile = profile;
      state.iccName = profile.name || profile.description || fallbackName;
      rebuildTransform();
      state.samples.forEach(computeCmyk);
      renderIccBadge(opts.saved);
      render();
    });
  }

  function handleIccFile(file) {
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return applyIccBytes(bytes, file.name, { saved: true }).then(function () {
        toast('ICCを適用しました。この端末に保存し、次回から自動適用します');
        return idbSet('profile', { name: state.iccName, bytes: bytes }).catch(function () { /* プライベートブラウズ等では保存不可 */ });
      });
    }).catch(function (e) {
      toast('ICC読込エラー: ' + e.message);
    });
  }

  function restoreIcc() {
    if (!window.indexedDB) return;
    idbGet('profile').then(function (rec) {
      if (rec && rec.bytes) {
        applyIccBytes(rec.bytes, rec.name, { saved: true }).then(function () {
          toast('保存済みのICC「' + state.iccName + '」を適用しました');
        }).catch(function () { idbDel('profile').catch(function () {}); });
      }
    }).catch(function () {});
  }

  // ===== スペクトルSVG (その色自身の線で描く) =====
  function spectrumSvg(spec36, hex) {
    if (!spec36) return '<div class="nochart">スペクトルなし — 直接値から変換</div>';
    var W = 300, H = 56, base = 52, padT = 4;
    var ih = base - padT;
    var maxR = 1.0;
    for (var i = 0; i < spec36.length; i++) if (spec36[i] > maxR) maxR = spec36[i];
    var pts = [];
    for (var j = 0; j < C.N_WL; j++) {
      var x = (j / (C.N_WL - 1)) * W;
      var y = padT + ih - (Math.max(0, spec36[j]) / maxR) * ih;
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="反射率スペクトル 380から730ナノメートル">' +
      '<line x1="0" y1="' + base + '" x2="' + W + '" y2="' + base + '" stroke="rgba(0,0,0,0.10)" stroke-width="1"></line>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + hex + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
      '</svg>';
  }

  // ===== 相対輝度 (プレビューの文字色判定) =====
  function isLight(rgb) {
    var lin = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    return L > 0.36;
  }

  // ===== 全画面カラープレビュー =====
  function openPreview(idx) {
    var s = state.samples[idx];
    if (!s || !s.convView) return;
    var cv = s.convView;
    var light = isLight(cv.rgb);
    var fg = light ? '#000' : '#FFF';
    var chip = light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.16)';
    var ov = document.createElement('div');
    ov.className = 'preview';
    ov.style.background = cv.hex;
    ov.style.color = fg;
    var cmykRow = s.cmyk ? '<div class="row">CMYK ' + s.cmyk.c + ' / ' + s.cmyk.m + ' / ' + s.cmyk.y + ' / ' + s.cmyk.k + (s.cmykIsIcc ? '' : ' <span style="opacity:.6">(簡易)</span>') + '</div>' : '';
    ov.innerHTML =
      '<div class="esc" style="background:' + chip + '">クリック / ESC で戻る</div>' +
      '<div class="info">' +
        '<div class="nm">' + esc(s.obj.name) + '</div>' +
        '<div class="row">' + cv.hex.toUpperCase() + '</div>' +
        (cv.Lab ? '<div class="row">L*a*b* ' + fmt(cv.Lab[0], 2) + ' / ' + fmt(cv.Lab[1], 2) + ' / ' + fmt(cv.Lab[2], 2) + '</div>' : '') +
        cmykRow +
      '</div>';
    function close() {
      ov.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
  }

  // ===== 描画 =====
  function metaLabel(s, cv) {
    var type = '';
    if (/^M[012]_/.test(s.obj.objectType)) type = s.obj.objectType.slice(0, 2);
    else if (s.obj.objectType) type = s.obj.objectType;
    var src = { spectrum: 'スペクトル', lab: 'Lab直接値', xyz: 'XYZ直接値', srgb: 'sRGB直接値' }[cv.source] || cv.source;
    var qkey = /^M[012]$/.test(type) ? 'm012' : (cv.source === 'spectrum' ? 'spectrum' : null);
    var text = type ? type + ' · ' + src : src;
    return '<span class="meta">' + esc(text) + (qkey ? T.qBtn(qkey) : '') + '</span>';
  }

  function render() {
    var box = $('results');
    if (state.samples.length === 0) {
      box.innerHTML =
        '<div class="empty">' +
          '<p class="lead">ここに変換結果が並びます</p>' +
          '<div class="steps">' +
            '<div class="step"><b>STEP 1</b>測色計で測り CxF3 で書き出す</div>' +
            '<div class="step"><b>STEP 2</b>上の欄にファイルをドロップ</div>' +
            '<div class="step"><b>STEP 3</b>HEXコピー・CSVで書き出し</div>' +
          '</div>' +
          '<button class="btn primary js-load-sample" type="button">サンプルCxFで試す</button>' +
        '</div>';
      $('btnCsv').disabled = true; $('btnClear').disabled = true;
      return;
    }
    $('btnCsv').disabled = false; $('btnClear').disabled = false;

    var html = '<div class="grid-cards">';
    state.samples.forEach(function (s, idx) {
      var cv = s.convView;
      if (!cv) return;
      var lab = cv.Lab, xyz = cv.XYZ, rgb = cv.rgb;
      var cmykSrc = s.cmykIsIcc
        ? '<span class="srcname" title="' + esc(s.cmykSource) + '">ICC</span>'
        : '<span class="srcname naivemark">簡易</span>';

      html += '<article class="card">' +
        '<div class="swatch" data-idx="' + idx + '" role="button" tabindex="0" aria-label="' + esc(s.obj.name) + ' を全画面で見る" style="background:' + cv.hex + '">' +
          (rgb.outOfGamut ? '<span class="gamut">sRGB域外' + T.qBtn('gamut') + '</span>' : '') +
          '<span class="zoom">クリックで全画面</span>' +
          '<span class="hexchip">' + cv.hex.toUpperCase() + '</span>' +
        '</div>' +
        '<div class="body">' +
          '<div class="head">' +
            '<span class="name">' + esc(s.obj.name) + '</span>' +
            metaLabel(s, cv) +
            '<span class="fname">' + esc(s.file) + '</span>' +
          '</div>' +
          '<div class="vals">' +
            (lab ? '<div class="kv"><b>L*a*b* (' + state.ill + '/2°)' + T.qBtn('lab') + '</b><span class="num">' + fmt(lab[0], 2) + ' / ' + fmt(lab[1], 2) + ' / ' + fmt(lab[2], 2) + '</span></div>' : '') +
            (xyz ? '<div class="kv"><b>XYZ' + T.qBtn('xyz') + '</b><span class="num">' + fmt(xyz[0], 2) + ' / ' + fmt(xyz[1], 2) + ' / ' + fmt(xyz[2], 2) + '</span></div>' : '') +
            '<div class="kv"><b>sRGB / HEX' + T.qBtn('srgb') + '</b><button class="copybtn" data-copy="' + cv.hex.toUpperCase() + '" title="クリックでコピー">' + cv.hex.toUpperCase() + ' ⧉</button></div>' +
            (s.cmyk ? '<div class="kv"><b>CMYK ' + cmykSrc + T.qBtn('cmyk') + '</b><span class="num">' + s.cmyk.c + ' / ' + s.cmyk.m + ' / ' + s.cmyk.y + ' / ' + s.cmyk.k + '</span></div>' : '') +
          '</div>' +
          '<div class="chartwrap">' + spectrumSvg(cv.spectrum36, cv.hex) + '</div>' +
        '</div>' +
      '</article>';
    });
    html += '</div>';
    box.innerHTML = html;

    box.querySelectorAll('.copybtn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
          toast(b.getAttribute('data-copy') + ' をコピーしました');
        });
      });
    });
    box.querySelectorAll('.swatch').forEach(function (sw) {
      sw.addEventListener('click', function (e) {
        if (e.target.closest('.q')) return;
        openPreview(Number(sw.getAttribute('data-idx')));
      });
      sw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(Number(sw.getAttribute('data-idx'))); }
      });
    });
  }

  // ===== CxFファイル処理 =====
  function handleCxfFiles(files) {
    var added = 0, errs = [];
    var arr = Array.prototype.slice.call(files);
    var done = 0;
    arr.forEach(function (file) {
      file.text().then(function (text) {
        try {
          var parsed = P.parseCxF(text);
          parsed.objects.forEach(function (obj) {
            state.samples.push({ file: file.name, obj: obj, convD50: null, convView: null, cmyk: null, cmykSource: '', cmykIsIcc: false });
            added++;
          });
          if (parsed.warnings.length) parsed.warnings.forEach(function (w) { errs.push(file.name + ': ' + w); });
          var devInfo = parsed.device.name ? parsed.device.name + (parsed.device.serial ? ' #' + parsed.device.serial : '') : '';
          $('cxfStatus').innerHTML = '<span class="ok">● ' + esc(file.name) + ' — ' + parsed.objects.length + '色を読み込みました</span>' +
            (devInfo ? ' <span style="font-family:var(--mono);font-size:11px;color:var(--ter)">' + esc(devInfo) + '</span>' : '');
        } catch (e) {
          errs.push(file.name + ': ' + e.message);
        }
        done++;
        if (done === arr.length) {
          if (added > 0) recomputeAll();
          if (errs.length) toast(errs[0]);
          else if (added > 0) toast(added + '色を変換しました');
        }
      });
    });
  }

  // ===== CSVエクスポート =====
  function downloadCsv() {
    var head = ['file', 'name', 'object_type', 'source', 'illuminant', 'L', 'a', 'b', 'X', 'Y', 'Z', 'R', 'G', 'B', 'HEX', 'C', 'M', 'Y_', 'K', 'cmyk_source'];
    for (var w = 0; w < C.N_WL; w++) head.push('R' + C.WL_GRID[w]);
    var rows = [head];
    state.samples.forEach(function (s) {
      var cv = s.convView; if (!cv) return;
      var r = [s.file, s.obj.name, s.obj.objectType, cv.source, state.ill];
      r = r.concat(cv.Lab ? cv.Lab.map(function (v) { return fmt(v, 4); }) : ['', '', '']);
      r = r.concat(cv.XYZ ? cv.XYZ.map(function (v) { return fmt(v, 4); }) : ['', '', '']);
      r = r.concat(cv.rgb ? [cv.rgb.r, cv.rgb.g, cv.rgb.b, cv.hex] : ['', '', '', '']);
      r = r.concat(s.cmyk ? [s.cmyk.c, s.cmyk.m, s.cmyk.y, s.cmyk.k, s.cmykSource] : ['', '', '', '', '']);
      for (var w2 = 0; w2 < C.N_WL; w2++) r.push(cv.spectrum36 ? fmt(cv.spectrum36[w2], 6) : '');
      rows.push(r);
    });
    var csv = '\uFEFF' + rows.map(function (r) {
      return r.map(function (c) { c = String(c == null ? '' : c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cxf-colors-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ===== イベント配線 =====
  function wireDrop(zone, input, handler, multi) {
    zone.addEventListener('click', function (e) {
      if (e.target.closest('button') || e.target.closest('a')) return;
      input.click();
    });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handler(multi ? e.dataTransfer.files : e.dataTransfer.files[0]);
    });
    input.addEventListener('change', function (e) {
      if (e.target.files.length) handler(multi ? e.target.files : e.target.files[0]);
      input.value = '';
    });
  }
  wireDrop($('dropCxf'), $('fileCxf'), handleCxfFiles, true);
  wireDrop($('dropIcc'), $('fileIcc'), handleIccFile, false);

  function wireSeg(id, cb) {
    var seg = $(id);
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        cb(b.getAttribute('data-v'));
      });
    });
  }
  wireSeg('segIll', function (v) { state.ill = v; recomputeAll(); });
  wireSeg('segIntent', function (v) { state.intent = v; rebuildTransform(); state.samples.forEach(computeCmyk); render(); });

  // BPC: iOS風トグルスイッチ
  $('bpcSwitch').addEventListener('click', function () {
    state.bpc = !state.bpc;
    this.setAttribute('aria-checked', String(state.bpc));
    rebuildTransform();
    state.samples.forEach(computeCmyk);
    render();
  });

  $('btnCsv').addEventListener('click', downloadCsv);
  $('btnClear').addEventListener('click', function () {
    state.samples = [];
    $('cxfStatus').innerHTML = '<button class="btn-link js-load-sample" type="button">サンプルCxFで試す</button>';
    render();
  });

  // サンプル読込 (ドロップ欄・空状態のどちらのボタンでも動くよう委譲)
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.js-load-sample') : null;
    if (!b) return;
    e.stopPropagation();
    fetch('samples/sample.cxf').then(function (r) { return r.text(); }).then(function (text) {
      var parsed = P.parseCxF(text);
      parsed.objects.forEach(function (obj) {
        state.samples.push({ file: 'sample.cxf', obj: obj, convD50: null, convView: null, cmyk: null, cmykSource: '', cmykIsIcc: false });
      });
      $('cxfStatus').innerHTML = '<span class="ok">● sample.cxf — ' + parsed.objects.length + '色を読み込みました</span>';
      recomputeAll();
      toast('サンプル ' + parsed.objects.length + '色を読み込みました');
    }).catch(function () { toast('サンプルの読み込みに失敗しました'); });
  });

  restoreIcc();
  render();
})();
