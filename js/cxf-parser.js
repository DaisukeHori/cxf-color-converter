/**
 * cxf-parser.js — CxF3 (Color Exchange Format 3 / ISO 17972) パーサー
 *
 * iroca-color-simulator の measure.html 内 parseCxF3 を基に汎用化:
 *  - 全 Object を走査 (M0/M1/M2_Measurement に限らず Standard / Sample / Target 等も対象)
 *  - ReflectanceSpectrum: StartWL 属性、または ColorSpecification 参照から
 *    WavelengthRange (StartWL / Increment) を解決。点数は可変。
 *  - ColorCIELab / ColorCIEXYZ / ColorSRGB の直接値にも対応
 *  - FileInformation (Creator / Description / CreationDate) と測定器情報を取得
 *  - CxF1 / CxF2 らしきファイルは判別してエラーメッセージで案内
 *
 * 依存: DOMParser (ブラウザ標準)。Node でテストする場合は
 *       @xmldom/xmldom の DOMParser を globalThis に注入すること。
 */
(function (global) {
  'use strict';

  var NS_CXF3 = 'http://colorexchangeformat.com/CxF3-core';

  function textOf(parent, ns, tag) {
    if (!parent) return null;
    var els = parent.getElementsByTagNameNS(ns, tag);
    if (!els || els.length === 0) return null;
    return (els[0].textContent || '').trim();
  }

  function firstNS(parent, ns, tag) {
    if (!parent) return null;
    var els = parent.getElementsByTagNameNS(ns, tag);
    return (els && els.length > 0) ? els[0] : null;
  }

  function parseNumberList(text) {
    if (!text) return [];
    return text.trim().split(/\s+/).map(Number).filter(function (v) { return isFinite(v); });
  }

  /**
   * CxF3 XML文字列をパースする。
   * @param {string} xmlStr
   * @returns {{
   *   fileInfo: {creator:string, description:string, creationDate:string},
   *   device: {name:string, serial:string},
   *   specs: Object.<string, {startWL:number, increment:number, measurementType:string,
   *                            illumination:string, filter:string, geometry:string}>,
   *   objects: Array.<{
   *     id:string, name:string, objectType:string,
   *     spectrum: {values:number[], startWL:number, increment:number, colorSpec:string}|null,
   *     lab: {L:number,a:number,b:number}|null,
   *     xyz: {X:number,Y:number,Z:number}|null,
   *     srgb: {R:number,G:number,B:number}|null,
   *     tags: Object.<string,string>
   *   }>,
   *   warnings: string[]
   * }}
   * @throws {Error} CxF3として解釈できない場合
   */
  function parseCxF(xmlStr) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlStr, 'text/xml');

    // パースエラー検出 (ブラウザは parsererror 要素を返す)
    var perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length > 0) {
      throw new Error('XMLとして解釈できませんでした。ファイルが破損しているか、テキスト形式ではない可能性があります。');
    }

    var root = doc.documentElement;
    if (!root) throw new Error('XMLルート要素が見つかりません。');

    // CxF3 判定
    var isCxF3 = (root.namespaceURI === NS_CXF3) ||
      (root.localName === 'CxF' && (xmlStr.indexOf('CxF3-core') >= 0));
    if (!isCxF3) {
      if (/<CxF[\s>]/.test(xmlStr) || root.localName === 'CxF') {
        throw new Error('CxF1/CxF2 形式のようです。本ツールは CxF3 (ISO 17972) に対応しています。X-Rite製ソフト等でCxF3として書き出し直してください。');
      }
      throw new Error('CxF3ファイルではないようです (ルート要素: ' + root.localName + ')。');
    }

    var warnings = [];

    // ---- FileInformation ----
    var fi = firstNS(doc, NS_CXF3, 'FileInformation');
    var fileInfo = {
      creator: textOf(fi, NS_CXF3, 'Creator') || '',
      description: textOf(fi, NS_CXF3, 'Description') || '',
      creationDate: textOf(fi, NS_CXF3, 'CreationDate') || ''
    };

    // ---- 測定器情報 (X-Rite Prism CustomResources 等) ----
    var device = { name: '', serial: '' };
    var allEls = doc.getElementsByTagName('*');
    for (var d = 0; d < allEls.length; d++) {
      var el = allEls[d];
      if (el.localName === 'CustomAttributes') {
        device.name = el.getAttribute('MeasurementDevice') || device.name;
        device.serial = el.getAttribute('MeasurementDeviceSerialNumber') || device.serial;
      }
    }

    // ---- ColorSpecificationCollection: 波長レンジと測定条件 ----
    var specs = {};
    var specEls = doc.getElementsByTagNameNS(NS_CXF3, 'ColorSpecification');
    for (var s = 0; s < specEls.length; s++) {
      var spEl = specEls[s];
      var id = spEl.getAttribute('Id') || ('spec' + s);
      var wr = firstNS(spEl, NS_CXF3, 'WavelengthRange');
      var spec = {
        startWL: wr ? Number(wr.getAttribute('StartWL')) : NaN,
        increment: wr ? Number(wr.getAttribute('Increment')) : NaN,
        measurementType: textOf(spEl, NS_CXF3, 'MeasurementType') || '',
        illumination: textOf(spEl, NS_CXF3, 'DeviceIllumination') || '',
        filter: textOf(spEl, NS_CXF3, 'DeviceFilter') || '',
        geometry: ''
      };
      var geo = firstNS(spEl, NS_CXF3, 'GeometryChoice');
      if (geo) {
        var ang = textOf(geo, NS_CXF3, 'MeasurementAngle');
        var illAng = textOf(geo, NS_CXF3, 'IlluminationAngle');
        if (illAng && ang) spec.geometry = illAng + '/' + ang;
        else if (ang) spec.geometry = ang + '°';
        else spec.geometry = (geo.textContent || '').trim().slice(0, 40);
      }
      specs[id] = spec;
    }

    // ---- ObjectCollection ----
    var objects = [];
    var objEls = doc.getElementsByTagNameNS(NS_CXF3, 'Object');
    for (var o = 0; o < objEls.length; o++) {
      var obj = objEls[o];
      var entry = {
        id: obj.getAttribute('Id') || ('obj' + o),
        name: obj.getAttribute('Name') || ('Object ' + (o + 1)),
        objectType: obj.getAttribute('ObjectType') || '',
        spectrum: null,
        lab: null,
        xyz: null,
        srgb: null,
        tags: {}
      };

      var cv = firstNS(obj, NS_CXF3, 'ColorValues');
      if (cv) {
        // ReflectanceSpectrum (複数ある場合は最初のもの)
        var rs = firstNS(cv, NS_CXF3, 'ReflectanceSpectrum');
        if (rs) {
          var vals = parseNumberList(rs.textContent);
          if (vals.length > 0) {
            var startAttr = rs.getAttribute('StartWL');
            var colorSpecRef = rs.getAttribute('ColorSpecification') || '';
            var startWL = startAttr !== null && startAttr !== '' ? Number(startAttr) : NaN;
            var increment = NaN;
            if (colorSpecRef && specs[colorSpecRef]) {
              if (!isFinite(startWL)) startWL = specs[colorSpecRef].startWL;
              increment = specs[colorSpecRef].increment;
            }
            if (!isFinite(startWL)) { startWL = 380; warnings.push(entry.name + ': StartWLが不明のため380nmと仮定しました。'); }
            if (!isFinite(increment)) { increment = 10; }
            entry.spectrum = { values: vals, startWL: startWL, increment: increment, colorSpec: colorSpecRef };
          }
        }
        // ColorCIELab
        var labEl = firstNS(cv, NS_CXF3, 'ColorCIELab');
        if (labEl) {
          var L = Number(textOf(labEl, NS_CXF3, 'L'));
          var A = Number(textOf(labEl, NS_CXF3, 'A'));
          var B = Number(textOf(labEl, NS_CXF3, 'B'));
          if (isFinite(L) && isFinite(A) && isFinite(B)) entry.lab = { L: L, a: A, b: B };
        }
        // ColorCIEXYZ
        var xyzEl = firstNS(cv, NS_CXF3, 'ColorCIEXYZ');
        if (xyzEl) {
          var X = Number(textOf(xyzEl, NS_CXF3, 'X'));
          var Y = Number(textOf(xyzEl, NS_CXF3, 'Y'));
          var Z = Number(textOf(xyzEl, NS_CXF3, 'Z'));
          if (isFinite(X) && isFinite(Y) && isFinite(Z)) entry.xyz = { X: X, Y: Y, Z: Z };
        }
        // ColorSRGB
        var rgbEl = firstNS(cv, NS_CXF3, 'ColorSRGB');
        if (rgbEl) {
          var R = Number(textOf(rgbEl, NS_CXF3, 'R'));
          var G = Number(textOf(rgbEl, NS_CXF3, 'G'));
          var Bb = Number(textOf(rgbEl, NS_CXF3, 'B'));
          if (isFinite(R) && isFinite(G) && isFinite(Bb)) entry.srgb = { R: R, G: G, B: Bb };
        }
      }

      // TagCollection (SampleName / Row / Column 等)
      var tagEls = obj.getElementsByTagNameNS(NS_CXF3, 'Tag');
      for (var t = 0; t < tagEls.length; t++) {
        var tg = tagEls[t];
        var tn = tg.getAttribute('Name');
        if (tn) entry.tags[tn] = tg.getAttribute('Value') || '';
      }
      // SampleName タグがあれば表示名を補強
      if (entry.tags.SampleName && entry.tags.SampleName.length > 0) {
        entry.name = entry.name + ' (' + entry.tags.SampleName + ')';
      }

      // 色情報を1つも持たないObjectはスキップ
      if (entry.spectrum || entry.lab || entry.xyz || entry.srgb) {
        objects.push(entry);
      }
    }

    if (objects.length === 0) {
      throw new Error('色データを持つObjectが見つかりませんでした。ReflectanceSpectrum / ColorCIELab / ColorCIEXYZ / ColorSRGB のいずれかが必要です。');
    }

    return {
      fileInfo: fileInfo,
      device: device,
      specs: specs,
      objects: objects,
      warnings: warnings
    };
  }

  var api = { parseCxF: parseCxF, NS_CXF3: NS_CXF3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.CxFParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
