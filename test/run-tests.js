// Node用テストランナー: DOMParserを注入してパーサー+色変換を検証
const { DOMParser } = require('@xmldom/xmldom');
globalThis.DOMParser = DOMParser;
const fs = require('fs');
const CxFParser = require('../js/cxf-parser.js');
const C = require('../js/colorlib.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---- Test 1: 実CxFファイル (X-Rite i1Profiler / Prism) ----
console.log('Test 1: 実CxF (i1Profiler出力) パース');
const xml = fs.readFileSync(process.argv[2] || '/mnt/user-data/uploads/テ_フォルトの測定値.cxf', 'utf8');
const parsed = CxFParser.parseCxF(xml);
assert(parsed.fileInfo.creator === 'X-Rite - Prism', 'Creator = X-Rite - Prism');
assert(parsed.device.name === 'i1Pro 2', '測定器 = i1Pro 2');
assert(parsed.objects.length >= 3, `Object数 >= 3 (実際: ${parsed.objects.length})`);
const m0 = parsed.objects.find(o => o.objectType === 'M0_Measurement');
assert(!!m0, 'M0_Measurement が存在');
assert(m0.spectrum.values.length === 36, `スペクトル36点 (実際: ${m0.spectrum.values.length})`);
assert(m0.spectrum.startWL === 380 && m0.spectrum.increment === 10, `StartWL=380, Inc=10 (実際: ${m0.spectrum.startWL}/${m0.spectrum.increment})`);

// ---- Test 2: スペクトル→Lab (colour-science リファレンス: 85.90, 0.50, 8.76) ----
console.log('Test 2: スペクトル→Lab (D50/2°)');
const conv = C.convertSample(m0, 'D50');
console.log(`  Lab = (${conv.Lab[0].toFixed(2)}, ${conv.Lab[1].toFixed(2)}, ${conv.Lab[2].toFixed(2)})`);
assert(near(conv.Lab[0], 85.9039, 0.005), 'L* ≈ 85.9039 ±0.005');
assert(near(conv.Lab[1], 0.5734, 0.005), 'a* ≈ 0.5734 ±0.005 (自己整合白色点)');
assert(near(conv.Lab[2], 8.7232, 0.005), 'b* ≈ 8.7232 ±0.005');

// ---- Test 3: Lab→sRGB (jsColorEngine リファレンス: 221, 214, 198) ----
console.log('Test 3: Lab→sRGB (Bradford D50→D65)');
console.log(`  sRGB = (${conv.rgb.r}, ${conv.rgb.g}, ${conv.rgb.b}) hex=${conv.hex}`);
assert(near(conv.rgb.r, 221, 1.01), 'R ≈ 221 ±1');
assert(near(conv.rgb.g, 214, 1.01), 'G ≈ 214 ±1');
assert(near(conv.rgb.b, 198, 1.01), 'B ≈ 198 ±1');

// ---- Test 4: 再サンプリング (20nm刻み → 36点) ----
console.log('Test 4: 任意グリッド再サンプリング');
const spec36 = m0.spectrum.values;
const spec20nm = spec36.filter((_, i) => i % 2 === 0); // 380,400,...,720 (18点)
const resampled = C.resampleSpectrum(spec20nm, 380, 20);
assert(resampled.length === 36, '出力36点');
assert(near(resampled[0], spec36[0], 1e-9), '380nm一致');
assert(near(resampled[2], spec36[2], 1e-9), '400nm一致');
const interp390 = (spec36[0] + spec36[2]) / 2;
assert(near(resampled[1], interp390, 1e-9), '390nm=線形補間値');
assert(near(resampled[35], spec20nm[17], 1e-9), '730nm=エッジクランプ(720nm値)');
const convR = C.convertSample({spectrum:{values:spec20nm, startWL:380, increment:20}}, 'D50');
const dE = C.deltaE2000(conv.Lab, convR.Lab);
console.log(`  20nm→36点補間後のΔE2000 = ${dE.toFixed(4)}`);
assert(dE < 0.3, '補間誤差 ΔE2000 < 0.3');

// ---- Test 5: Lab直接値のみのCxF ----
console.log('Test 5: ColorCIELab直接値パース');
const labOnlyXml = `<?xml version="1.0" encoding="UTF-8"?>
<cc:CxF xmlns:cc="http://colorexchangeformat.com/CxF3-core">
<cc:Resources><cc:ObjectCollection>
<cc:Object ObjectType="Standard" Name="TestRed" Id="c1">
<cc:ColorValues><cc:ColorCIELab ColorSpecification="CSD50_2">
<cc:L>54.28</cc:L><cc:A>78.98</cc:A><cc:B>64.91</cc:B>
</cc:ColorCIELab></cc:ColorValues>
</cc:Object>
</cc:ObjectCollection></cc:Resources></cc:CxF>`;
const labParsed = CxFParser.parseCxF(labOnlyXml);
assert(labParsed.objects.length === 1, 'Object 1件');
assert(near(labParsed.objects[0].lab.L, 54.28, 1e-9), 'L=54.28');
const convLab = C.convertSample(labParsed.objects[0], 'D50');
console.log(`  Lab直接値 → sRGB = (${convLab.rgb.r}, ${convLab.rgb.g}, ${convLab.rgb.b})`);
assert(convLab.source === 'lab', 'source=lab');

// ---- Test 6: 簡易CMYK ----
console.log('Test 6: 簡易CMYK');
const cmyk = C.naiveCmyk({r:255, g:0, b:0});
assert(cmyk.c === 0 && cmyk.m === 100 && cmyk.y === 100 && cmyk.k === 0, `赤 → C0 M100 Y100 K0 (実際: ${JSON.stringify(cmyk)})`);
const cmykW = C.naiveCmyk(conv.rgb);
console.log(`  サンプル簡易CMYK = C${cmykW.c} M${cmykW.m} Y${cmykW.y} K${cmykW.k}`);

// ---- Test 7: CxF2形式の検出 ----
console.log('Test 7: 非CxF3の検出');
try {
  CxFParser.parseCxF('<?xml version="1.0"?><CxF><Palette/></CxF>');
  assert(false, 'CxF2でエラーを投げる');
} catch(e) {
  assert(e.message.indexOf('CxF1/CxF2') >= 0, 'CxF1/CxF2案内メッセージ: ' + e.message.slice(0, 40));
}


// ---- Test 8: 同梱サンプルCxF ----
console.log('Test 8: samples/sample.cxf');
const sampleXml = fs.readFileSync(__dirname + '/../samples/sample.cxf', 'utf8');
const sp = CxFParser.parseCxF(sampleXml);
assert(sp.objects.length === 7, `7オブジェクト (実際: ${sp.objects.length})`);
const specResolved = sp.objects[0].spectrum;
assert(specResolved.startWL === 380 && specResolved.increment === 10, 'ColorSpec参照でWavelengthRange解決');
for (const o of sp.objects) {
  const cv = C.convertSample(o, 'D50');
  console.log(`  ${o.name.padEnd(22)} Lab=(${cv.Lab[0].toFixed(1)}, ${cv.Lab[1].toFixed(1)}, ${cv.Lab[2].toFixed(1)}) sRGB=${cv.hex}`);
}
const red = C.convertSample(sp.objects.find(o=>o.name==='Vivid Red'), 'D50');
assert(red.Lab[1] > 30 && red.rgb.r > red.rgb.b, '赤サンプルはa*>30かつR>B');
const blue = C.convertSample(sp.objects.find(o=>o.name==='Deep Blue'), 'D50');
assert(blue.Lab[2] < -20 && blue.rgb.b > blue.rgb.r, '青サンプルはb*<-20かつB>R');

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
