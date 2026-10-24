/**
 * 本地复刻 `@deepseek-ai/dsh-typert-protocol` 里**真正被 Gateway 读取**的那部分契约。
 *
 * 为什么需要它：外部 link 插件的 Host 半区在 Node 的解析链上拿不到宿主内部包
 * ——桌面端把它们放在 App 的 asar 里，profile 的 node_modules 里没有；顶层静态
 * import 会让整个插件 `failed to import`。它们也不能写进 dependencies：这些包
 * peer 依赖 `@deepseek-ai/cordis`，插件里会出现第二份 cordis，Service 基类就是
 * 另一个实例。
 *
 * 复刻依据是宿主实现本身（App 内 `dsh-typert-protocol/lib/types/index.js`）：
 *   1. 方法标记写在**原型**上，属性名是固定字符串，不是 symbol；
 *   2. 描述符形状 `{ version: 1, methods: [...] }`，marker 是冻结的普通对象；
 *   3. 服务靠**可见字段** `typertRemote` 被 Gateway 发现（`dsh-api-gateway` :713）；
 *   4. Gateway 只核对 `service` / `serviceKey` / `namespace` 三个字段（同文件 :1452）。
 * 四样都是普通对象 + 字符串键，所以跨模块实例天然兼容。
 */

/** 方法清单的属性名。必须与宿主逐字一致：写错只会让 Remote 面静默消失。 */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** 宿主 `TYPERT_REMOTE_SEGMENT_PATTERN` 的同一份判据。 */
const SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

function validateName(subject, value) {
  if (typeof value !== 'string' || !SEGMENT_PATTERN.test(value) || value === '.' || value === '..') {
    throw new TypeError(`typert-lite: ${subject} must contain only RPC endpoint segment characters`);
  }
}

function readDescriptor(prototype) {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
  if (property === undefined) return undefined;
  const descriptor = property.value;
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new TypeError('typert-lite: Remote method descriptor must be an object');
  }
  if (descriptor.version !== 1) {
    throw new TypeError(`typert-lite: unsupported Remote method descriptor version ${String(descriptor.version)}`);
  }
  if (!Array.isArray(descriptor.methods)) {
    throw new TypeError('typert-lite: Remote method descriptor methods must be an array');
  }
  return descriptor;
}

function sameInvocation(left, right) {
  if (left.kind === 'direct') return right.kind === 'direct';
  if (right.kind === 'direct') return false;
  return left.context === right.context;
}

function mark(prototype, method, invocation, mode, exportName) {
  const descriptor = readDescriptor(prototype);
  const marker = Object.freeze({
    method,
    ...(exportName === undefined || exportName === method ? {} : { exportName }),
    ...(mode === undefined ? {} : { mode }),
    invocation: Object.freeze(invocation),
  });
  const current = descriptor?.methods.find((candidate) => candidate.method === method);
  if (current !== undefined) {
    if (current.exportName === marker.exportName
      && current.mode === marker.mode
      && sameInvocation(current.invocation, invocation)) {
      return;
    }
    throw new Error(`typert-lite: Remote method "${method}" has conflicting invocation markers`);
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze([...(descriptor?.methods ?? []), marker]) }),
  });
}

/**
 * 与宿主 `Remote(exportName)` 等价的方法装饰器。接受宿主装饰器同样的手写 context
 * （`{ name, private, static, addInitializer }`），所以调用点不用改写。
 * @param exportName - Remote 导出名。
 * @returns 一个标准方法装饰器。
 */
export function Remote(exportName) {
  validateName('Remote export name', exportName);
  return function decorate(_method, context) {
    if (context === undefined || context.private === true || context.static === true || typeof context.name !== 'string') {
      throw new TypeError('typert-lite: Remote requires a public instance method with a string name');
    }
    const method = context.name;
    context.addInitializer(function initializer() {
      const prototype = Object.getPrototypeOf(this);
      if (prototype === null) {
        throw new TypeError(`typert-lite: cannot mark Remote method "${method}" on an object without a prototype`);
      }
      mark(prototype, method, { kind: 'direct' }, undefined, exportName);
    });
  };
}

/**
 * 读取一个存活服务原型上的 Remote 方法清单（Gateway 用的同一份数据）。
 * @param service - 存活的服务实例。
 * @returns marker 快照，按声明顺序。
 */
export function remoteMethods(service) {
  const prototype = Object.getPrototypeOf(service);
  if (prototype === null) return [];
  return (readDescriptor(prototype)?.methods ?? []).map((marker) => ({ ...marker }));
}

/**
 * 构造 Gateway 会在服务实例上寻找的可见绑定。
 * @param service - 服务实例本身。
 * @param serviceKey - Cordis 服务名，同时是默认 wire 命名空间。
 * @param options - 可选的独立命名空间。
 * @returns 冻结的绑定对象，存进 `service.typertRemote`。
 */
export function bindTypertRemote(service, serviceKey, options = {}) {
  validateName('service key', serviceKey);
  const namespace = options.namespace ?? serviceKey;
  validateName('namespace', namespace);
  return Object.freeze({ service, serviceKey, namespace });
}
