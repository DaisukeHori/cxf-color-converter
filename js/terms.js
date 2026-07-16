/**
 * terms.js — 専門用語辞書 + 「?」ボタン吹き出しエンジン
 *
 * 使い方:
 *   HTML側:  <button class="q" data-term="lab" aria-label="L*a*b*とは">?</button>
 *   ガイド側: CxFTerms.TERMS を列挙して用語集を自動生成
 *
 * クリックで吹き出し表示、外側クリック / ESC / ×で閉じる。
 * 位置はボタン基準で自動計算し、画面端でははみ出さないよう調整する。
 */
(function (global) {
  'use strict';

  var TERMS = {
    cxf: {
      title: 'CxFファイル',
      body: 'Color Exchange Format。測った色のデータ（分光反射率など）をやり取りするための国際標準ファイルです（ISO 17972）。X-Rite社の測色計やソフト（i1Profiler、eXactなど）から書き出せます。本ツールはバージョン3（CxF3）に対応しています。'
    },
    m012: {
      title: 'M0 / M1 / M2（測定条件）',
      body: '測るときに当てる光の違いです（ISO 13655）。M0＝昔ながらのランプ光（従来の測定値と互換）、M1＝印刷業界標準の昼光で蛍光増白剤の効果を含む、M2＝UVカットで蛍光増白の影響を除いたもの。印刷物の評価はM1、過去データとの比較はM0が一般的です。'
    },
    spectrum: {
      title: '分光反射率（スペクトル）',
      body: '380〜730nmの波長ごとに「その物が光を何％跳ね返すか」を並べた、色の生データです。いわば色の指紋で、ここからLabやRGBなど全ての色数値を計算します。グラフの山の位置がその色の性格を表します（右の山＝赤系、左＝青系）。'
    },
    lab: {
      title: 'L*a*b*（CIELAB）',
      body: '人間の見た目に合わせた色の座標です。L*＝明るさ（0が黒、100が白）、a*＝プラスで赤み・マイナスで緑み、b*＝プラスで黄み・マイナスで青み。モニタやプリンタなど機器が変わっても共通で使える「色の住所」として、色指定や色差管理の基準になります。'
    },
    xyz: {
      title: 'XYZ（三刺激値）',
      body: '国際照明委員会（CIE）が定めた、人の目の感度をもとにした最も基本的な色の数値です。Labはここから計算されます。普段の色確認はLabを見れば十分ですが、他の色計算ソフトへ受け渡すときに使われることがあります。'
    },
    srgb: {
      title: 'sRGB',
      body: 'パソコンやスマホの画面で使われる標準の色空間です。WebやアプリのHEX指定（#FF6600 など）はこの値。画面用の規格なので、印刷インキで出せる色とは範囲（色域）が異なります。'
    },
    hex: {
      title: 'HEX（カラーコード）',
      body: 'sRGBのR・G・B各256段階を16進数で並べた表記です（例: #DDD6C6）。クリックでコピーして、FigmaやIllustrator、CSSにそのまま貼り付けられます。'
    },
    cmyk: {
      title: 'CMYK',
      body: '印刷インキ4色（シアン・マゼンタ・イエロー・黒）の網点％です。同じ色でも紙質や印刷条件によって適切な数値は変わるため、ICCプロファイルで「どの印刷条件か」を指定すると実用精度になります。ICCなしの簡易値はあくまで当たりを付けるための参考値です。'
    },
    icc: {
      title: 'ICCプロファイル',
      body: '「この印刷条件では、この色はこう出る」という対応表が入った変換辞書ファイル（.icc / .icm）です。Japan Color 2011 Coated（日本の枚葉オフセット標準）などをドロップすると、その条件に合った正確なCMYK値が計算されます。ファイルはPCの中で処理され、送信されません。'
    },
    intent: {
      title: 'レンダリングインテント',
      body: '印刷で再現できない鮮やかな色を、どう丸めるかのルールです。「相対比色」＝再現できる色はできるだけ忠実に（単色の色合わせ向き・おすすめ）。「知覚的」＝全体の階調バランスを優先（写真の変換向き）。'
    },
    bpc: {
      title: 'BPC（黒点補正）',
      body: 'Black Point Compensation。紙とインキで出せる一番暗い黒に合わせて暗部を割り付け、シャドウのつぶれを防ぐ処理です。PhotoshopのCMYK変換も初期設定でONになっており、通常はONのままで問題ありません。'
    },
    illuminant: {
      title: '表示光源（D50 / D65）',
      body: '色を評価するときの照明の種類です。D50＝印刷・グラフィックアーツの国際標準光（やや暖かい昼光）、D65＝モニタ規格や一般的な昼光。印刷向けの数値管理はD50のままが基本です。切り替えるとLab・XYZ・sRGBの値が変わります（CMYKはICCの仕様上、常にD50基準で計算します）。'
    },
    gamut: {
      title: 'sRGB域外',
      body: 'この色は鮮やかすぎて、画面の色空間（sRGB）では正確に再現できません、という印です。表示は一番近い色に丸めていますが、Lab値そのものは正確です。蛍光色や高彩度のインキでよく起こります。'
    },
    de: {
      title: 'ΔE（色差）',
      body: '2つの色がどれだけ離れているかを表す数値です。本ツール内部ではΔE2000という最新の計算式を使っています。目安として、1以下＝並べてもほぼ区別できない、2〜3＝訓練された人が気づく、6以上＝誰でも違いが分かるレベルです。'
    }
  };

  var currentPop = null;
  var currentBtn = null;
  var openedAt = 0;

  function closePop() {
    if (currentPop) {
      currentPop.remove();
      currentPop = null;
    }
    if (currentBtn) {
      currentBtn.setAttribute('aria-expanded', 'false');
      currentBtn = null;
    }
  }

  function openPop(btn) {
    closePop();
    var key = btn.getAttribute('data-term');
    var term = TERMS[key];
    if (!term) return;

    var pop = document.createElement('div');
    pop.className = 'tippop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', term.title);
    var h = document.createElement('h4');
    h.textContent = term.title;
    var p = document.createElement('p');
    p.textContent = term.body;
    var x = document.createElement('button');
    x.className = 'close';
    x.setAttribute('aria-label', '閉じる');
    x.textContent = '✕';
    x.addEventListener('click', closePop);
    pop.appendChild(x);
    pop.appendChild(h);
    pop.appendChild(p);
    document.body.appendChild(pop);

    // 位置計算: ボタンの下。右端・下端でははみ出さないよう調整
    var r = btn.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.min(Math.max(12, r.left - 10), window.innerWidth - pw - 12);
    var top = r.bottom + 10;
    if (top + ph > window.innerHeight - 12) {
      top = Math.max(12, r.top - ph - 10);
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    currentPop = pop;
    currentBtn = btn;
    openedAt = Date.now();
    btn.setAttribute('aria-expanded', 'true');
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.q[data-term]') : null;
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (currentBtn === btn) { closePop(); } else { openPop(btn); }
      return;
    }
    if (currentPop && !currentPop.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePop();
  });
  window.addEventListener('scroll', function () {
    // ボタンへの自動スクロール直後の残存イベントでは閉じない
    if (Date.now() - openedAt > 250) closePop();
  }, { passive: true });
  window.addEventListener('resize', closePop);

  /** ?ボタンのHTML文字列を生成 (動的描画用) */
  function qBtn(key) {
    var t = TERMS[key];
    var label = t ? t.title + 'とは' : '用語説明';
    return '<button class="q" type="button" data-term="' + key + '" aria-label="' + label + '" aria-expanded="false">?</button>';
  }

  global.CxFTerms = { TERMS: TERMS, qBtn: qBtn, close: closePop };
})(typeof window !== 'undefined' ? window : this);
