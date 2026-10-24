/**
 * 本地 OCR：**用 macOS 自带的 Vision 框架**识别一张图里的文字。
 *
 * 这个文件由 `osascript -l JavaScript` 执行（JXA），**不是** Node 模块 ——
 * 不要 `import` 它，也不要在这里用 `require` / `process`。参数从 `run(argv)` 进来，
 * 结果打成一行 JSON 从 stdout 出去（宿主侧 `ocr.js` 负责解析）。
 *
 * ★ 为什么走 JXA 而不是编译一个 Swift 二进制：
 *   1. **零产物**。编二进制要带架构（arm64 / x64）、要签名、要从插件包里被 Gatekeeper
 *      放行；而 JXA 只是文本，`osascript` 是系统自带的。
 *   2. **不需要 Xcode**。`swiftc` 只有在装了命令行工具的机器上才有；`osascript` 人人都有。
 *   3. 实测（2026-10-24，M 系列 Mac，1653×2339 的扫描页）：**0.6–0.8 秒/页**，
 *      与编译版一致（同一套 Vision 内核），中文识别几乎无误。
 *
 * ★ `recognitionLevel = 0` 是 `VNRequestTextRecognitionLevelAccurate`；
 *   `usesLanguageCorrection` 必须开 —— 关掉时中文会被拆成单个字块，连不成行。
 * ★ `recognitionLanguages` 给 `zh-Hans` 在前：文档没写顺序有影响，但实测简体中文
 *   页面把 `en-US` 放前面会多出「数字被识别成全角」这类噪声。
 */
ObjC.import('Foundation');
ObjC.import('Vision');

function fail(message) {
  return JSON.stringify({ ok: false, error: String(message) });
}

function run(argv) {
  if (argv.length < 1) return fail('缺少图片路径');

  const url = $.NSURL.fileURLWithPath(argv[0]);
  const started = Date.now();

  let handler;
  let request;
  try {
    handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
    request = $.VNRecognizeTextRequest.alloc.init;
    request.recognitionLevel = 0;
    request.usesLanguageCorrection = true;
    request.recognitionLanguages = ['zh-Hans', 'en-US'];
  } catch (error) {
    return fail(error);
  }

  let performed = false;
  try {
    performed = handler.performRequestsError($([request]), null);
  } catch (error) {
    return fail(error);
  }
  if (!performed) return fail('Vision 没有完成识别（图片可能不是位图，或已损坏）');

  const results = request.results;
  const count = results.count;
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const observation = results.objectAtIndex(i);
    const candidates = observation.topCandidates(1);
    if (candidates.count > 0) {
      const text = ObjC.unwrap(candidates.objectAtIndex(0).string);
      if (typeof text === 'string' && text !== '') lines.push(text);
    }
  }

  return JSON.stringify({ ok: true, lines: lines.length, ms: Date.now() - started, text: lines });
}
