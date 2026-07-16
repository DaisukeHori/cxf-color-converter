/**
 * colorlib.js — CxF Color Converter 色科学ライブラリ
 *
 * 機能:
 *  - 任意波長グリッドの反射率スペクトル → 380-730nm/10nm (36点) へ再サンプリング
 *  - スペクトル → XYZ → Lab (D50/2° または D65/2°)
 *  - Lab(D50) → sRGB (Bradford D50→D65 適応)
 *  - CIEDE2000 色差
 *  - 簡易CMYK (sRGB基準・参考値。高精度はICCプロファイル+jsColorEngineを使用)
 *
 * CIEテーブルは colour-science 0.4.7 (CIE 1931 2° 標準観測者 / CIE標準イルミナント)
 * から生成した正確な値。iroca-color-simulator の measure.html 実装を基に、
 * D50テーブルの転記ずれ(510/520nm付近, 最大0.61)を修正済み。
 *
 * ブラウザ: window.CxFColor / Node: module.exports の両対応 (テスト用)。
 */
(function (global) {
  'use strict';

  // ============================================================
  // 波長グリッド定義: 380-730nm / 10nm / 36点
  // ============================================================
  var WL_START = 380;
  var WL_INC = 10;
  var N_WL = 36;
  var WL_GRID = new Array(N_WL);
  for (var i = 0; i < N_WL; i++) WL_GRID[i] = WL_START + i * WL_INC;

  // ============================================================
  // CIE 1931 2° 等色関数 (380-730nm/10nm, colour-science 0.4.7)
  // ============================================================
  var CMF_X = [0.001368, 0.004243, 0.01431, 0.04351, 0.13438, 0.2839, 0.34828, 0.3362, 0.2908,
    0.19536, 0.09564, 0.03201, 0.0049, 0.0093, 0.06327, 0.1655, 0.2904, 0.43345,
    0.5945, 0.7621, 0.9163, 1.0263, 1.0622, 1.0026, 0.85445, 0.6424, 0.4479,
    0.2835, 0.1649, 0.0874, 0.04677, 0.0227, 0.0113592, 0.00579035, 0.00289933, 0.00143997];
  var CMF_Y = [0.000039, 0.00012, 0.000396, 0.00121, 0.004, 0.0116, 0.023, 0.038, 0.06,
    0.09098, 0.13902, 0.20802, 0.323, 0.503, 0.71, 0.862, 0.954, 0.99495,
    0.995, 0.952, 0.87, 0.757, 0.631, 0.503, 0.381, 0.265, 0.175,
    0.107, 0.061, 0.032, 0.017, 0.00821, 0.004102, 0.002091, 0.001047, 0.00052];
  var CMF_Z = [0.00645, 0.02005, 0.06785, 0.2074, 0.6456, 1.3856, 1.74706, 1.77211, 1.6692,
    1.28764, 0.81295, 0.46518, 0.272, 0.1582, 0.07825, 0.04216, 0.0203, 0.00875,
    0.0039, 0.0021, 0.00165, 0.0011, 0.0008, 0.00034, 0.00019, 0.00005, 0.00002,
    0, 0, 0, 0, 0, 0, 0, 0, 0];

  // ============================================================
  // 標準イルミナント SPD (380-730nm/10nm, colour-science 0.4.7)
  // ============================================================
  var ILLUMINANTS = {
    D50: [24.488, 29.871, 49.308, 56.513, 60.034, 57.818, 74.825, 87.247, 90.612,
      91.368, 95.109, 91.963, 95.724, 96.613, 97.129, 102.099, 100.755, 102.317,
      100, 97.735, 98.918, 93.499, 97.688, 99.269, 99.042, 95.722, 98.857,
      95.667, 98.19, 103.003, 99.133, 87.381, 91.604, 92.889, 76.854, 86.511],
    D65: [49.9755, 54.6482, 82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812,
      114.861, 115.923, 108.811, 109.354, 107.802, 104.79, 107.689, 104.405, 104.046,
      100, 96.3342, 95.788, 88.6856, 90.0062, 89.5991, 87.6987, 83.2886, 83.6992,
      80.0268, 80.2146, 82.2778, 78.2842, 69.7213, 71.6091, 74.349, 61.604, 69.8856]
  };

  // 白色点キャッシュ (テーブル自己整合: 完全拡散反射面のXYZ)
  var _whiteCache = {};
  function whitePoint(illName) {
    if (_whiteCache[illName]) return _whiteCache[illName];
    var S = ILLUMINANTS[illName];
    var sumY = 0;
    for (var i = 0; i < N_WL; i++) sumY += S[i] * CMF_Y[i];
    var k = 100.0 / sumY;
    var X = 0, Y = 0, Z = 0;
    for (var j = 0; j < N_WL; j++) {
      X += S[j] * CMF_X[j];
      Y += S[j] * CMF_Y[j];
      Z += S[j] * CMF_Z[j];
    }
    var w = [k * X, k * Y, k * Z];
    _whiteCache[illName] = w;
    return w;
  }

  // ============================================================
  // 任意波長グリッド → 36点(380-730/10nm) 再サンプリング (線形補間)
  // 範囲外はエッジ値でクランプ (CIE 15 の慣行に準拠した単純外挿)
  // ============================================================
  function resampleSpectrum(values, startWL, increment) {
    if (!values || values.length === 0) return null;
    startWL = Number(startWL);
    increment = Number(increment);
    if (!isFinite(startWL)) startWL = WL_START;
    if (!isFinite(increment) || increment <= 0) increment = WL_INC;

    // 既に完全一致ならコピーを返す
    if (startWL === WL_START && increment === WL_INC && values.length >= N_WL) {
      return values.slice(0, N_WL).map(Number);
    }
    var endWL = startWL + (values.length - 1) * increment;
    var out = new Array(N_WL);
    for (var i = 0; i < N_WL; i++) {
      var wl = WL_GRID[i];
      if (wl <= startWL) { out[i] = Number(values[0]); continue; }
      if (wl >= endWL) { out[i] = Number(values[values.length - 1]); continue; }
      var pos = (wl - startWL) / increment;
      var lo = Math.floor(pos);
      var hi = Math.min(lo + 1, values.length - 1);
      var t = pos - lo;
      out[i] = Number(values[lo]) * (1 - t) + Number(values[hi]) * t;
    }
    return out;
  }

  // ============================================================
  // 反射率(36点) → XYZ (指定イルミナント/2°)
  // 反射率は 0-1 スケール。0-100 スケールらしき場合は自動判定して正規化。
  // ============================================================
  function reflectanceToXYZ(R, illName) {
    illName = illName || 'D50';
    var S = ILLUMINANTS[illName];
    if (!S) throw new Error('未対応のイルミナント: ' + illName);
    var max = 0;
    for (var m = 0; m < R.length; m++) if (R[m] > max) max = R[m];
    var scale = max > 2.0 ? 0.01 : 1.0; // 0-100% 表記の自動正規化
    var sumY = 0;
    for (var i = 0; i < N_WL; i++) sumY += S[i] * CMF_Y[i];
    var k = 100.0 / sumY;
    var X = 0, Y = 0, Z = 0;
    for (var j = 0; j < N_WL; j++) {
      var r = R[j] * scale;
      X += r * S[j] * CMF_X[j];
      Y += r * S[j] * CMF_Y[j];
      Z += r * S[j] * CMF_Z[j];
    }
    return [k * X, k * Y, k * Z];
  }

  // ============================================================
  // XYZ ⇔ Lab (CIE 1976, 白色点はテーブル自己整合値)
  // ============================================================
  var EPS = 216 / 24389;   // 0.008856...
  var KAPPA = 24389 / 27;  // 903.296...

  function xyzToLab(XYZ, illName) {
    var w = whitePoint(illName || 'D50');
    var xr = XYZ[0] / w[0], yr = XYZ[1] / w[1], zr = XYZ[2] / w[2];
    var f = function (t) { return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116; };
    var fx = f(xr), fy = f(yr), fz = f(zr);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToXYZ(lab, illName) {
    var w = whitePoint(illName || 'D50');
    var L = lab[0], a = lab[1], b = lab[2];
    var fy = (L + 16) / 116;
    var fx = a / 500 + fy;
    var fz = fy - b / 200;
    var finv = function (f) {
      var f3 = f * f * f;
      return f3 > EPS ? f3 : (116 * f - 16) / KAPPA;
    };
    return [finv(fx) * w[0], finv(fy) * w[1], finv(fz) * w[2]];
  }

  // ============================================================
  // Lab → sRGB
  //  D50入力: Bradford で D50→D65 適応後、標準 sRGB 行列
  //  D65入力: 直接 sRGB 行列
  // ============================================================
  var M_BRADFORD_D50_D65 = [
    [0.9555766, -0.0230393, 0.0631636],
    [-0.0282895, 1.0099416, 0.0210077],
    [0.0122982, -0.0204830, 1.3299098]
  ];
  var M_XYZ_TO_SRGB = [
    [3.2406, -1.5372, -0.4986],
    [-0.9689, 1.8758, 0.0415],
    [0.0557, -0.2040, 1.0570]
  ];

  function labToSrgb(lab, illName) {
    illName = illName || 'D50';
    var XYZ = labToXYZ(lab, illName);
    var X, Y, Z;
    if (illName === 'D50') {
      X = M_BRADFORD_D50_D65[0][0] * XYZ[0] + M_BRADFORD_D50_D65[0][1] * XYZ[1] + M_BRADFORD_D50_D65[0][2] * XYZ[2];
      Y = M_BRADFORD_D50_D65[1][0] * XYZ[0] + M_BRADFORD_D50_D65[1][1] * XYZ[1] + M_BRADFORD_D50_D65[1][2] * XYZ[2];
      Z = M_BRADFORD_D50_D65[2][0] * XYZ[0] + M_BRADFORD_D50_D65[2][1] * XYZ[1] + M_BRADFORD_D50_D65[2][2] * XYZ[2];
    } else {
      X = XYZ[0]; Y = XYZ[1]; Z = XYZ[2];
    }
    X /= 100; Y /= 100; Z /= 100;
    var r = M_XYZ_TO_SRGB[0][0] * X + M_XYZ_TO_SRGB[0][1] * Y + M_XYZ_TO_SRGB[0][2] * Z;
    var g = M_XYZ_TO_SRGB[1][0] * X + M_XYZ_TO_SRGB[1][1] * Y + M_XYZ_TO_SRGB[1][2] * Z;
    var b = M_XYZ_TO_SRGB[2][0] * X + M_XYZ_TO_SRGB[2][1] * Y + M_XYZ_TO_SRGB[2][2] * Z;
    var clip = false;
    if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) clip = true;
    r = Math.max(0, Math.min(1, r));
    g = Math.max(0, Math.min(1, g));
    b = Math.max(0, Math.min(1, b));
    var enc = function (v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
    return {
      r: Math.round(enc(r) * 255),
      g: Math.round(enc(g) * 255),
      b: Math.round(enc(b) * 255),
      outOfGamut: clip
    };
  }

  function rgbToHex(rgb) {
    var h = function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); };
    return '#' + h(rgb.r) + h(rgb.g) + h(rgb.b);
  }

  // ============================================================
  // CIEDE2000 (Sharma et al. 2005)
  // ============================================================
  function deltaE2000(lab1, lab2, kL, kC, kH) {
    kL = kL || 1; kC = kC || 1; kH = kH || 1;
    var L1 = lab1[0], a1 = lab1[1], b1 = lab1[2];
    var L2 = lab2[0], a2 = lab2[1], b2 = lab2[2];
    var C1 = Math.hypot(a1, b1);
    var C2 = Math.hypot(a2, b2);
    var Cb = (C1 + C2) / 2;
    var G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    var a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    var C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    var h1p = ((Math.atan2(b1, a1p) * 180 / Math.PI) + 360) % 360;
    var h2p = ((Math.atan2(b2, a2p) * 180 / Math.PI) + 360) % 360;
    var dLp = L2 - L1;
    var dCp = C2p - C1p;
    var dhp = h2p - h1p;
    if (Math.abs(dhp) > 180) dhp -= Math.sign(dhp) * 360;
    if (C1p * C2p === 0) dhp = 0;
    var dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);
    var Lpb = (L1 + L2) / 2;
    var Cpb = (C1p + C2p) / 2;
    var hpb;
    var hsum = h1p + h2p;
    if (Math.abs(h1p - h2p) <= 180) hpb = hsum / 2;
    else if (hsum < 360) hpb = (hsum + 360) / 2;
    else hpb = (hsum - 360) / 2;
    if (C1p * C2p === 0) hpb = hsum;
    var T = 1 - 0.17 * Math.cos((hpb - 30) * Math.PI / 180)
      + 0.24 * Math.cos((2 * hpb) * Math.PI / 180)
      + 0.32 * Math.cos((3 * hpb + 6) * Math.PI / 180)
      - 0.20 * Math.cos((4 * hpb - 63) * Math.PI / 180);
    var dTheta = 30 * Math.exp(-Math.pow((hpb - 275) / 25, 2));
    var Rc = 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)));
    var Sl = 1 + (0.015 * Math.pow(Lpb - 50, 2)) / Math.sqrt(20 + Math.pow(Lpb - 50, 2));
    var Sc = 1 + 0.045 * Cpb;
    var Sh = 1 + 0.015 * Cpb * T;
    var Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
    return Math.sqrt(
      Math.pow(dLp / (kL * Sl), 2) +
      Math.pow(dCp / (kC * Sc), 2) +
      Math.pow(dHp / (kH * Sh), 2) +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
    );
  }

  // ============================================================
  // 簡易CMYK (sRGB 0-255 → CMYK %, ナイーブ変換・参考値)
  // ICC変換とは別物であることをUI上で明示すること。
  // ============================================================
  function naiveCmyk(rgb) {
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    var k = 1 - Math.max(r, g, b);
    if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
    var c = (1 - r - k) / (1 - k);
    var m = (1 - g - k) / (1 - k);
    var y = (1 - b - k) / (1 - k);
    var pct = function (v) { return Math.round(Math.max(0, Math.min(1, v)) * 100); };
    return { c: pct(c), m: pct(m), y: pct(y), k: pct(k) };
  }

  // ============================================================
  // 波長(nm) → 表示用近似sRGB (スペクトル帯・チャート描画用の視覚化。測色用途ではない)
  // 単波長刺激のCMF値から相対XYZ→sRGBへ落とす簡易法。
  // ============================================================
  function wavelengthToCss(wl) {
    var pos = (wl - WL_START) / WL_INC;
    var lo = Math.max(0, Math.min(N_WL - 1, Math.floor(pos)));
    var hi = Math.min(N_WL - 1, lo + 1);
    var t = Math.max(0, Math.min(1, pos - lo));
    var X = CMF_X[lo] * (1 - t) + CMF_X[hi] * t;
    var Y = CMF_Y[lo] * (1 - t) + CMF_Y[hi] * t;
    var Z = CMF_Z[lo] * (1 - t) + CMF_Z[hi] * t;
    var sum = X + Y + Z;
    if (sum <= 0) return '#000000';
    var r = M_XYZ_TO_SRGB[0][0] * X + M_XYZ_TO_SRGB[0][1] * Y + M_XYZ_TO_SRGB[0][2] * Z;
    var g = M_XYZ_TO_SRGB[1][0] * X + M_XYZ_TO_SRGB[1][1] * Y + M_XYZ_TO_SRGB[1][2] * Z;
    var b = M_XYZ_TO_SRGB[2][0] * X + M_XYZ_TO_SRGB[2][1] * Y + M_XYZ_TO_SRGB[2][2] * Z;
    var mx = Math.max(r, g, b);
    if (mx > 0) { r /= mx; g /= mx; b /= mx; }
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    var enc = function (v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
    return rgbToHex({ r: enc(r) * 255, g: enc(g) * 255, b: enc(b) * 255 });
  }

  // ============================================================
  // 統合: スペクトル or 直接値 → 全色数値
  // ============================================================
  function convertSample(sample, illName) {
    illName = illName || 'D50';
    var out = { illuminant: illName, observer: '2', source: null };
    if (sample.spectrum && sample.spectrum.values && sample.spectrum.values.length > 0) {
      var R = resampleSpectrum(sample.spectrum.values, sample.spectrum.startWL, sample.spectrum.increment);
      out.spectrum36 = R;
      out.XYZ = reflectanceToXYZ(R, illName);
      out.Lab = xyzToLab(out.XYZ, illName);
      out.source = 'spectrum';
    } else if (sample.lab) {
      out.Lab = [sample.lab.L, sample.lab.a, sample.lab.b];
      out.XYZ = labToXYZ(out.Lab, illName);
      out.source = 'lab';
    } else if (sample.xyz) {
      out.XYZ = [sample.xyz.X, sample.xyz.Y, sample.xyz.Z];
      out.Lab = xyzToLab(out.XYZ, illName);
      out.source = 'xyz';
    } else if (sample.srgb) {
      out.rgb = { r: sample.srgb.R, g: sample.srgb.G, b: sample.srgb.B, outOfGamut: false };
      out.hex = rgbToHex(out.rgb);
      out.source = 'srgb';
      out.naiveCmyk = naiveCmyk(out.rgb);
      return out;
    } else {
      return null;
    }
    out.rgb = labToSrgb(out.Lab, illName);
    out.hex = rgbToHex(out.rgb);
    out.naiveCmyk = naiveCmyk(out.rgb);
    return out;
  }

  var api = {
    WL_START: WL_START,
    WL_INC: WL_INC,
    N_WL: N_WL,
    WL_GRID: WL_GRID,
    CMF_X: CMF_X, CMF_Y: CMF_Y, CMF_Z: CMF_Z,
    ILLUMINANTS: ILLUMINANTS,
    whitePoint: whitePoint,
    resampleSpectrum: resampleSpectrum,
    reflectanceToXYZ: reflectanceToXYZ,
    xyzToLab: xyzToLab,
    labToXYZ: labToXYZ,
    labToSrgb: labToSrgb,
    rgbToHex: rgbToHex,
    deltaE2000: deltaE2000,
    naiveCmyk: naiveCmyk,
    wavelengthToCss: wavelengthToCss,
    convertSample: convertSample
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.CxFColor = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
